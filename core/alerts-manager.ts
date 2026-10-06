import * as fs from 'fs'
import * as path from 'path'
import { mapPool } from './cache.ts'
import { sendTelegram } from './telegram-daily.ts'

export interface Alert {
  id: string
  ticker: string
  type: 'price' | 'rsi' | 'ml_signal'
  condition: 'above' | 'below' | 'action_equals'
  value: number | string // numeric threshold or action like 'buy'/'sell'
  status: 'active' | 'triggered' | 'disabled'
  createdAt: string
  lastTriggeredAt: string | null
  triggerCount: number
  lastCheckedValue: number | string | null
}

export interface AlertHistory {
  id: string
  alertId: string
  ticker: string
  type: 'price' | 'rsi' | 'ml_signal'
  condition: string
  targetValue: number | string
  triggeredValue: number | string
  triggeredAt: string
  message: string
}

const ALERTS_DIR = process.env.ALERTS_DIR || path.join(import.meta.dir, '..', 'data')
const ALERTS_FILE = path.join(ALERTS_DIR, 'alerts.json')
const HISTORY_FILE = path.join(ALERTS_DIR, 'alerts_history.json')

let alertsCache: Alert[] = []
let historyCache: AlertHistory[] = []
let isChecking = false

// Helper to ensure data directory exists
function ensureDirExists() {
  try {
    if (!fs.existsSync(ALERTS_DIR)) {
      fs.mkdirSync(ALERTS_DIR, { recursive: true })
    }
  } catch (err) {
    console.error('[alerts] Error creating directory:', err)
  }
}

export function loadAlerts(): Alert[] {
  ensureDirExists()
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = fs.readFileSync(ALERTS_FILE, 'utf-8')
      alertsCache = JSON.parse(raw)
    } else {
      alertsCache = []
    }
  } catch (err) {
    console.error('[alerts] Error reading alerts file, resetting:', err)
    alertsCache = []
  }
  return alertsCache
}

export function saveAlerts(): void {
  ensureDirExists()
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertsCache, null, 2), 'utf-8')
  } catch (err) {
    console.error('[alerts] Error writing alerts file:', err)
  }
}

export function loadHistory(): AlertHistory[] {
  ensureDirExists()
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8')
      historyCache = JSON.parse(raw)
    } else {
      historyCache = []
    }
  } catch (err) {
    console.error('[alerts] Error reading history file:', err)
    historyCache = []
  }
  return historyCache
}

export function saveHistory(): void {
  ensureDirExists()
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyCache, null, 2), 'utf-8')
  } catch (err) {
    console.error('[alerts] Error writing history file:', err)
  }
}

export function getAlerts(): Alert[] {
  return alertsCache.length ? alertsCache : loadAlerts()
}

export function getHistory(): AlertHistory[] {
  return historyCache.length ? historyCache : loadHistory()
}

export function addAlert(newAlert: Omit<Alert, 'id' | 'createdAt' | 'status' | 'triggerCount' | 'lastTriggeredAt' | 'lastCheckedValue'>): Alert {
  const alerts = getAlerts()
  const alert: Alert = {
    ...newAlert,
    id: 'alt_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4),
    status: 'active',
    createdAt: new Date().toISOString(),
    lastTriggeredAt: null,
    triggerCount: 0,
    lastCheckedValue: null
  }
  alerts.push(alert)
  saveAlerts()
  console.log(`[alerts] Added alert ${alert.id} for ${alert.ticker}`)
  return alert
}

export function deleteAlert(id: string): boolean {
  const alerts = getAlerts()
  const idx = alerts.findIndex(a => a.id === id)
  if (idx === -1) return false
  alerts.splice(idx, 1)
  saveAlerts()
  console.log(`[alerts] Deleted alert ${id}`)
  return true
}

export function toggleAlert(id: string, enable: boolean): boolean {
  const alerts = getAlerts()
  const alert = alerts.find(a => a.id === id)
  if (!alert) return false
  alert.status = enable ? 'active' : 'disabled'
  saveAlerts()
  console.log(`[alerts] Toggled alert ${id} to ${alert.status}`)
  return true
}

export function clearHistory(): void {
  historyCache = []
  saveHistory()
  console.log(`[alerts] Alert history cleared`)
}

export async function checkAlertsOnce(
  buildAssetSnapshotFn: (asset: { ticker: string; name: string; assetClass: 'stock' | 'crypto'; thesis: string }) => Promise<any>
): Promise<AlertHistory[]> {
  if (isChecking) {
    console.log('[alerts] Check already in progress, skipping...')
    return []
  }
  isChecking = true

  const activeAlerts = getAlerts().filter(a => a.status === 'active')
  if (activeAlerts.length === 0) {
    isChecking = false
    return []
  }

  console.log(`[alerts] Checking ${activeAlerts.length} active alerts...`)
  const triggeredHistory: AlertHistory[] = []
  
  // Unique tickers that we need snapshots for
  const uniqueTickers = Array.from(new Set(activeAlerts.map(a => a.ticker)))
  const snapshots = new Map<string, any>()

  // Load snapshots for unique tickers (em paralelo limitado: um ticker lento não atrasa os demais)
  await mapPool(uniqueTickers, 4, async ticker => {
    try {
      const assetClass = ticker.endsWith('-USD') ? 'crypto' as const : 'stock' as const
      const snapshot = await buildAssetSnapshotFn({
        ticker,
        name: ticker,
        assetClass,
        thesis: 'Alert verification'
      })
      if (snapshot) {
        snapshots.set(ticker, snapshot)
      }
    } catch (err: any) {
      console.error(`[alerts] Failed to build snapshot for alert check of ${ticker}:`, err.message)
    }
  })

  // Evaluate alerts
  let stateChanged = false
  const history = getHistory()

  for (const alert of activeAlerts) {
    const snapshot = snapshots.get(alert.ticker)
    if (!snapshot) continue

    let trigger = false
    let currentVal: number | string | null = null
    let reason = ''

    if (alert.type === 'price') {
      currentVal = snapshot.price
      if (currentVal != null) {
        const threshold = Number(alert.value)
        if (alert.condition === 'above' && currentVal > threshold) {
          trigger = true
          reason = `preço atual (${currentVal.toFixed(2)}) subiu acima do limite (${threshold.toFixed(2)})`
        } else if (alert.condition === 'below' && currentVal < threshold) {
          trigger = true
          reason = `preço atual (${currentVal.toFixed(2)}) caiu abaixo do limite (${threshold.toFixed(2)})`
        }
      }
    } else if (alert.type === 'rsi') {
      currentVal = snapshot.rsi
      if (currentVal != null) {
        const threshold = Number(alert.value)
        if (alert.condition === 'above' && currentVal > threshold) {
          trigger = true
          reason = `RSI atual (${currentVal.toFixed(0)}) subiu acima do limite (${threshold.toFixed(0)})`
        } else if (alert.condition === 'below' && currentVal < threshold) {
          trigger = true
          reason = `RSI atual (${currentVal.toFixed(0)}) caiu abaixo do limite (${threshold.toFixed(0)})`
        }
      }
    } else if (alert.type === 'ml_signal') {
      // alert on ML action match
      currentVal = snapshot.action // buy, sell, hold
      const targetAction = String(alert.value).toLowerCase()
      if (currentVal === targetAction) {
        // Only trigger if last checked value was different, to avoid duplicate alerts every check
        if (alert.lastCheckedValue !== currentVal) {
          trigger = true
          reason = `sinal mudou de ${alert.lastCheckedValue || 'N/A'} para ${currentVal.toUpperCase()}`
        }
      }
    }

    // Always update lastCheckedValue
    if (currentVal !== null && alert.lastCheckedValue !== currentVal) {
      alert.lastCheckedValue = currentVal
      stateChanged = true
    }

    if (trigger) {
      alert.status = 'triggered'
      alert.lastTriggeredAt = new Date().toISOString()
      alert.triggerCount += 1
      stateChanged = true

      const message = `🚨 <b>Alerta Disparado!</b>\n\nAtivo: <b>${alert.ticker}</b>\nTipo: <code>${alert.type.toUpperCase()}</code>\nMotivo: ${reason}\n\n<i>Preço: ${snapshot.price?.toFixed(2) ?? 'N/A'} | RSI: ${snapshot.rsi?.toFixed(0) ?? 'N/A'} | Ação: ${snapshot.action.toUpperCase()}</i>`
      
      const historyItem: AlertHistory = {
        id: 'hist_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4),
        alertId: alert.id,
        ticker: alert.ticker,
        type: alert.type,
        condition: alert.condition,
        targetValue: alert.value,
        triggeredValue: currentVal ?? 'N/A',
        triggeredAt: alert.lastTriggeredAt,
        message
      }

      triggeredHistory.push(historyItem)
      history.unshift(historyItem)

      // Send telegram notification (non-blocking)
      try {
        console.log(`[alerts] Triggered ${alert.id} sending to Telegram...`)
        sendTelegram(message).catch(err => {
          console.error(`[alerts] Telegram send failed for alert ${alert.id}:`, err.message)
        })
      } catch (err: any) {
        console.error(`[alerts] Telegram notification threw error:`, err.message)
      }
    }
  }

  if (stateChanged) {
    saveAlerts()
  }

  if (triggeredHistory.length > 0) {
    saveHistory()
    console.log(`[alerts] Dispatched ${triggeredHistory.length} alerts`)
  }

  isChecking = false
  return triggeredHistory
}

export function startAlertsCheckLoop(
  buildAssetSnapshotFn: (asset: { ticker: string; name: string; assetClass: 'stock' | 'crypto'; thesis: string }) => Promise<any>,
  intervalMs = 60000
): any {
  console.log(`[alerts] Starting alerts checking daemon. Interval: ${intervalMs / 1000}s`)
  // Initial load
  loadAlerts()
  loadHistory()
  
  const timer = setInterval(() => {
    checkAlertsOnce(buildAssetSnapshotFn).catch(err => {
      console.error('[alerts] Error in alerts check loop:', err)
      isChecking = false
    })
  }, intervalMs)

  return timer
}
