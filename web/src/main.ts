import './style.css'

interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
  duration: number
}

interface WatchlistItem {
  ticker: string
  addedAt: number
  price?: number
  change?: number
}

interface AnalyzeResponse {
  ticker: string
  name: string
  assetClass: 'stock' | 'crypto'
  quote: { price: number; change: number; volume?: number; currency?: string }
  rsi: number | null
  score: number
  action: 'buy' | 'hold' | 'sell'
  risk: 'low' | 'medium' | 'high'
  newsImpact: { label: 'bullish' | 'bearish' | 'neutral'; score: number; summary: string }
  signals: Array<{ source: string; title: string; url?: string }>
  rationale: string[]
  analysis: string
  aiSource: string
  timestamp: string
}

interface PortfolioResponse {
  portfolio: Array<{
    ticker: string
    name: string
    assetClass: 'stock' | 'crypto'
    price: number
    change: number
    historyChange: number
    rsi: number | null
    score: number
    action: 'buy' | 'hold' | 'sell'
    risk: 'low' | 'medium' | 'high'
    newsImpact: { label: 'bullish' | 'bearish' | 'neutral'; score: number; summary: string }
    signals: Array<{ source: string; title: string; url?: string }>
  }>
  recommendation: string
  aiSource: string
  tickersAnalyzed: number
  timestamp: string
}

interface TrainingResponse {
  generatedAt: string
  drills: Array<{
    id: string
    ticker: string
    prompt: string
    context: string[]
    expectedDecision: 'buy' | 'hold' | 'sell'
    answer: string
  }>
  source: {
    tickersAnalyzed: number
    aiSource: string
  }
}

interface ResearchResponse {
  asset: string
  generatedAt: string
  impact: { label: 'bullish' | 'bearish' | 'neutral'; score: number; summary: string }
  items: Array<{
    kind: 'fast-news' | 'news' | 'paper'
    source: string
    title: string
    url?: string
    impact: 'bullish' | 'bearish' | 'neutral'
    publishedAt?: string
    summary?: string
  }>
  nextQuestions: string[]
}

interface Alert {
  id: string
  ticker: string
  type: 'price' | 'rsi' | 'ml_signal'
  condition: 'above' | 'below' | 'action_equals'
  value: number | string
  status: 'active' | 'triggered' | 'disabled'
  createdAt: string
  lastTriggeredAt: string | null
  triggerCount: number
  lastCheckedValue: number | string | null
}

interface AlertHistory {
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const form = $<HTMLFormElement>('analyze-form')
const input = $<HTMLInputElement>('ticker-input')
const btn = $<HTMLButtonElement>('analyze-btn')
const loading = $<HTMLDivElement>('loading')
const resultDiv = $<HTMLDivElement>('result')
const errorDiv = $<HTMLDivElement>('error')
const generatePortfolioBtn = $<HTMLButtonElement>('generate-portfolio-btn')
const trainingBtn = $<HTMLButtonElement>('training-btn')
const researchBtn = $<HTMLButtonElement>('research-btn')
const alertsBtn = $<HTMLButtonElement>('alerts-btn')
const portfolioResultDiv = $<HTMLDivElement>('portfolio-result')
const portfolioStats = $<HTMLDivElement>('portfolio-stats')
const portfolioAnalysis = $<HTMLParagraphElement>('portfolio-analysis')
const trainingResultDiv = $<HTMLDivElement>('training-result')
const trainingList = $<HTMLDivElement>('training-list')
const researchResultDiv = $<HTMLDivElement>('research-result')
const researchSummary = $<HTMLParagraphElement>('research-summary')
const researchList = $<HTMLDivElement>('research-list')
const alertsResultDiv = $<HTMLDivElement>('alerts-result')
const networkStatus = $<HTMLDivElement>('network-status')
const watchlistContainer = $<HTMLDivElement>('watchlist-container')
const watchlistList = $<HTMLUListElement>('watchlist-list')
const darkModeToggle = $<HTMLButtonElement>('dark-mode-toggle')
const toastContainer = $<HTMLDivElement>('toast-container')

const createAlertForm = $<HTMLFormElement>('create-alert-form')
const alertTicker = $<HTMLInputElement>('alert-ticker')
const alertType = $<HTMLSelectElement>('alert-type')
const alertCondition = $<HTMLSelectElement>('alert-condition')
const alertValue = $<HTMLInputElement>('alert-value')
const activeAlertsList = $<HTMLTableSectionElement>('active-alerts-list')
const alertsHistoryList = $<HTMLUListElement>('alerts-history-list')
const clearAlertHistoryBtn = $<HTMLButtonElement>('clear-alert-history-btn')
const testTelegramBtn = $<HTMLButtonElement>('test-telegram-btn')

let isOnline = navigator.onLine
let toastTimeout: ReturnType<typeof setTimeout> | null = null

function initApp(): void {
  loadDarkModePreference()
  loadWatchlist()
  setupNetworkListeners()
  setupKeyboardShortcuts()
}

function loadDarkModePreference(): void {
  const saved = localStorage.getItem('darkMode')
  if (saved === 'true' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.setAttribute('data-theme', 'light')
  }
}

function loadWatchlist(): void {
  try {
    const saved = localStorage.getItem('dinheirama_watchlist')
    if (saved) {
      const items: WatchlistItem[] = JSON.parse(saved)
      renderWatchlist(items)
    }
  } catch {
    console.warn('Failed to load watchlist')
  }
}

function saveWatchlist(items: WatchlistItem[]): void {
  localStorage.setItem('dinheirama_watchlist', JSON.stringify(items))
}

function renderWatchlist(items: WatchlistItem[]): void {
  if (items.length === 0) {
    watchlistContainer.classList.add('hidden')
    return
  }

  watchlistContainer.classList.remove('hidden')
  watchlistList.innerHTML = ''

  items.forEach(item => {
    const li = document.createElement('li')
    li.className = 'watchlist-item'
    li.innerHTML = `
      <span class="watchlist-ticker">${item.ticker}</span>
      <button class="watchlist-remove" data-ticker="${item.ticker}" aria-label="Remove ${item.ticker}">×</button>
    `

    li.querySelector('.watchlist-remove')?.addEventListener('click', () => {
      removeFromWatchlist(item.ticker)
    })

    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('watchlist-remove')) return
      analyzeFromWatchlist(item.ticker)
    })

    watchlistList.appendChild(li)
  })
}

function addToWatchlist(ticker: string): void {
  const saved = localStorage.getItem('dinheirama_watchlist')
  const items: WatchlistItem[] = saved ? JSON.parse(saved) : []

  if (items.some(i => i.ticker === ticker)) {
    showToast(`${ticker} já está na watchlist`, 'info')
    return
  }

  items.unshift({ ticker, addedAt: Date.now() })
  if (items.length > 10) items.pop()

  saveWatchlist(items)
  renderWatchlist(items)
  showToast(`${ticker} adicionada à watchlist`, 'success')
}

function removeFromWatchlist(ticker: string): void {
  const saved = localStorage.getItem('dinheirama_watchlist')
  if (!saved) return

  const items: WatchlistItem[] = JSON.parse(saved)
  const filtered = items.filter(i => i.ticker !== ticker)

  saveWatchlist(filtered)
  renderWatchlist(filtered)
  showToast(`${ticker} removida da watchlist`, 'info')
}

function setupNetworkListeners(): void {
  window.addEventListener('online', () => {
    isOnline = true
    networkStatus.classList.add('hidden')
    showToast('Conexão restaurada', 'success')
  })

  window.addEventListener('offline', () => {
    isOnline = false
    networkStatus.classList.remove('hidden')
    networkStatus.innerHTML = '⚠️ Você está offline. Algumas funcionalidades podem não funcionar.'
    showToast('Conexão perdida', 'error')
  })
}

function setupKeyboardShortcuts(): void {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      form.dispatchEvent(new Event('submit'))
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideAllResults()
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      input.focus()
      input.select()
    }
  })
}

function showToast(message: string, type: Toast['type'] = 'info', duration = 4000): void {
  if (toastTimeout) clearTimeout(toastTimeout)

  const toast: Toast = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type,
    message,
    duration
  }

  const toastEl = document.createElement('div')
  toastEl.className = `toast toast-${toast.type}`
  toastEl.innerHTML = `
    <span class="toast-icon">${getToastIcon(type)}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Fechar">×</button>
  `

  toastEl.querySelector('.toast-close')?.addEventListener('click', () => removeToast(toast.id))
  toastContainer.appendChild(toastEl)

  requestAnimationFrame(() => toastEl.classList.add('show'))

  toastTimeout = setTimeout(() => removeToast(toast.id), duration)
}

function removeToast(id: string): void {
  const toastEl = Array.from(toastContainer.children).find(c => c.querySelector('.toast-message')?.textContent === id) as HTMLElement || 
                  toastContainer.querySelector(`[class^="toast"]`) // fallback
  if (toastEl) {
    toastEl.classList.remove('show')
    setTimeout(() => toastEl.remove(), 300)
  }
}

function getToastIcon(type: Toast['type']): string {
  const icons: Record<Toast['type'], string> = {
    success: '✓',
    error: '✗',
    info: 'ℹ',
    warning: '⚠'
  }
  return icons[type]
}

function setLoading(isLoading: boolean, message = 'Processando...'): void {
  if (isLoading) {
    resultDiv.classList.add('hidden')
    portfolioResultDiv.classList.add('hidden')
    trainingResultDiv.classList.add('hidden')
    researchResultDiv.classList.add('hidden')
    alertsResultDiv.classList.add('hidden')
    errorDiv.classList.add('hidden')
    btn.disabled = true
    generatePortfolioBtn.disabled = true
    trainingBtn.disabled = true
    researchBtn.disabled = true
    alertsBtn.disabled = true
  } else {
    btn.disabled = false
    generatePortfolioBtn.disabled = false
    trainingBtn.disabled = false
    researchBtn.disabled = false
    alertsBtn.disabled = false
  }

  const loadingText = isLoading ? message : 'Processando...'
  loading.innerHTML = `
    <div class="spinner-container">
      <div class="spinner"></div>
      <p class="loading-text">${loadingText}</p>
    </div>
  `
  loading.classList.toggle('hidden', !isLoading)
}

function hideAllResults(): void {
  resultDiv.classList.add('hidden')
  portfolioResultDiv.classList.add('hidden')
  trainingResultDiv.classList.add('hidden')
  researchResultDiv.classList.add('hidden')
  alertsResultDiv.classList.add('hidden')
  errorDiv.classList.add('hidden')
  loading.classList.add('hidden')
}

function formatPrice(value: number | undefined | null, decimals = 2, currency = 'BRL'): string {
  if (value == null) return 'N/A'
  const prefix = currency === 'USD' ? 'US$' : 'R$'
  return `${prefix} ${value.toFixed(decimals)}`
}

function formatPercent(value: number | undefined | null, decimals = 2): string {
  if (value == null) return 'N/A'
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

function getRSIColor(rsi: number | null): string {
  if (rsi == null) return 'var(--text-muted)'
  if (rsi < 30) return 'var(--success)'
  if (rsi > 70) return 'var(--danger)'
  return 'var(--warning)'
}

function getChangeColor(change: number | undefined | null): string {
  if (change == null) return 'var(--text-muted)'
  if (change >= 0) return 'var(--success)'
  return 'var(--danger)'
}

function getActionLabel(action: AnalyzeResponse['action']): string {
  const labels: Record<AnalyzeResponse['action'], string> = {
    buy: 'Comprar',
    hold: 'Manter',
    sell: 'Vender'
  }
  return labels[action]
}

function getRiskLabel(risk: AnalyzeResponse['risk']): string {
  const labels: Record<AnalyzeResponse['risk'], string> = {
    low: 'baixo',
    medium: 'médio',
    high: 'alto'
  }
  return labels[risk]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function renderAnalysisResult(data: AnalyzeResponse): void {
  const resTicker = $<HTMLSpanElement>('res-ticker')
  const resPrice = $<HTMLSpanElement>('res-price')
  const resChange = $<HTMLSpanElement>('res-change')
  const resRsi = $<HTMLSpanElement>('res-rsi')
  const resScore = $<HTMLSpanElement>('res-score')
  const resAction = $<HTMLSpanElement>('res-action')
  const resSignals = $<HTMLUListElement>('res-signals')
  const resAnalysis = $<HTMLParagraphElement>('res-analysis')
  const resAiSource = $<HTMLSpanElement>('res-ai-source')
  const addToWatchlistBtn = $<HTMLButtonElement>('add-to-watchlist-btn')

  resTicker.textContent = data.ticker
  resPrice.textContent = formatPrice(data.quote.price, 2, data.quote.currency)
  resChange.textContent = formatPercent(data.quote.change)
  resChange.style.color = getChangeColor(data.quote.change)
  resRsi.textContent = data.rsi !== null ? data.rsi.toFixed(2) : 'N/A'
  resRsi.style.color = getRSIColor(data.rsi)
  resScore.textContent = `${data.score}/100`
  resAction.textContent = `${getActionLabel(data.action)} · risco ${getRiskLabel(data.risk)}`
  resAction.title = data.newsImpact.summary

  resSignals.innerHTML = ''
  const signals = data.signals.slice(0, 4)
  if (signals.length === 0) {
    const li = document.createElement('li')
    li.textContent = 'Sem sinais externos configurados ou encontrados.'
    resSignals.appendChild(li)
  } else {
    signals.forEach(sig => {
      const li = document.createElement('li')
      li.innerHTML = sig.url
        ? `<a href="${escapeHtml(sig.url)}" target="_blank" rel="noreferrer"><b>[${escapeHtml(sig.source)}]</b> ${escapeHtml(sig.title)}</a>`
        : `<b>[${escapeHtml(sig.source)}]</b> ${escapeHtml(sig.title)}`
      resSignals.appendChild(li)
    })
  }

  resAnalysis.innerHTML = data.analysis
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')

  if (resAiSource) {
    resAiSource.textContent = `IA: ${data.aiSource}`
  }

  if (addToWatchlistBtn) {
    addToWatchlistBtn.onclick = () => addToWatchlist(data.ticker)
  }

  resultDiv.classList.remove('hidden')
}

function renderPortfolioResult(data: PortfolioResponse): void {
  portfolioStats.innerHTML = ''
  const ranked = [...data.portfolio].sort((a, b) => b.score - a.score)

  ranked.forEach(stock => {
    const div = document.createElement('div')
    div.className = 'portfolio-stock'
    div.innerHTML = `
      <div class="portfolio-stock-header">
        <span class="portfolio-stock-ticker">${escapeHtml(stock.ticker)}</span>
        <span class="portfolio-stock-price">${formatPrice(stock.price, 2, stock.assetClass === 'crypto' ? 'USD' : 'BRL')}</span>
      </div>
      <div class="portfolio-stock-stats">
        <span style="color: ${getChangeColor(stock.change)}">${formatPercent(stock.change)}</span>
        <span style="color: ${getChangeColor(stock.historyChange)}">30D: ${formatPercent(stock.historyChange)}</span>
        <span style="color: ${getRSIColor(stock.rsi)}">RSI: ${stock.rsi?.toFixed(0) || 'N/A'}</span>
      </div>
      <div class="portfolio-stock-meta">
        <span>Ação: <b>${getActionLabel(stock.action)}</b> (${stock.score}/100)</span>
      </div>
    `
    portfolioStats.appendChild(div)
  })

  portfolioAnalysis.innerHTML = data.recommendation
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>')

  portfolioResultDiv.classList.remove('hidden')
}

function renderTrainingResult(data: TrainingResponse): void {
  trainingList.innerHTML = ''
  if (data.drills.length === 0) {
    trainingList.innerHTML = '<p class="empty-list-msg">Nenhum cenário de treino gerado.</p>'
    return
  }

  data.drills.forEach(drill => {
    const div = document.createElement('div')
    div.className = 'training-drill'
    
    const contextItems = drill.context.map(ctx => `<li>${escapeHtml(ctx)}</li>`).join('')
    
    div.innerHTML = `
      <div class="training-drill-header">
        <span>${escapeHtml(drill.ticker)}</span>
        <span class="badge font-mono text-xs px-1.5 py-0.5 rounded bg-tertiary">Horizonte: 5D</span>
      </div>
      <p><b>Pergunta:</b> ${escapeHtml(drill.prompt)}</p>
      <ul>
        ${contextItems}
      </ul>
      <details class="mt-1">
        <summary>Ver resposta esperada</summary>
        <div class="mt-1 p-2 rounded bg-tertiary" style="background: var(--bg-tertiary); padding: 0.75rem; border-radius: 8px;">
          <p>${escapeHtml(drill.answer)}</p>
        </div>
      </details>
    `
    trainingList.appendChild(div)
  })

  trainingResultDiv.classList.remove('hidden')
}

function renderResearchResult(data: ResearchResponse): void {
  researchSummary.textContent = `${data.impact.summary} (Impacto: ${data.impact.label.toUpperCase()})`
  researchList.innerHTML = ''

  if (data.items.length === 0) {
    researchList.innerHTML = '<p class="empty-list-msg">Sem artigos ou notícias encontradas para este ativo.</p>'
    return
  }

  data.items.forEach(item => {
    const div = document.createElement('div')
    div.className = 'research-item'
    
    const titleHtml = item.url 
      ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer" style="color: var(--accent-secondary); font-weight: 600; text-decoration: none;">${escapeHtml(item.title)}</a>`
      : escapeHtml(item.title)
      
    const dateStr = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('pt-BR') : ''

    div.innerHTML = `
      <div class="research-item-header">
        <span>${escapeHtml(item.source)} (${escapeHtml(item.kind)})</span>
        <span class="badge" style="color: ${item.impact === 'bullish' ? 'var(--success)' : item.impact === 'bearish' ? 'var(--danger)' : 'var(--text-secondary)'}; font-weight: bold;">${escapeHtml(item.impact.toUpperCase())}</span>
      </div>
      <h3>${titleHtml}</h3>
      ${item.summary ? `<p class="mt-1 text-sm text-secondary" style="color: var(--text-secondary); font-size: 0.875rem; margin-top: 0.5rem;">${escapeHtml(item.summary)}</p>` : ''}
      ${dateStr ? `<div class="mt-1 text-xs text-muted" style="color: var(--text-muted); font-size: 0.75rem; margin-top: 0.5rem;">${dateStr}</div>` : ''}
    `
    researchList.appendChild(div)
  })

  researchResultDiv.classList.remove('hidden')
}

async function fetchAlerts(): Promise<void> {
  try {
    const res = await fetch('/api/alerts')
    if (!res.ok) throw new Error('Erro ao buscar alertas')
    const alerts = await res.json() as Alert[]
    renderAlerts(alerts)
  } catch (err: any) {
    showToast(err.message, 'error')
  }
}

function renderAlerts(alerts: Alert[]): void {
  activeAlertsList.innerHTML = ''
  if (alerts.length === 0) {
    activeAlertsList.innerHTML = `
      <tr>
        <td colspan="5" class="empty-list-msg text-center">Nenhum alerta configurado. Crie um acima!</td>
      </tr>
    `
    return
  }

  alerts.forEach(alert => {
    const tr = document.createElement('tr')
    
    const statusText = alert.status === 'active' ? 'Ativo' : alert.status === 'triggered' ? 'Disparado' : 'Inativo'
    const statusClass = alert.status === 'active' ? 'status-active' : alert.status === 'triggered' ? 'status-triggered' : 'status-disabled'
    
    let condSymbol = ''
    if (alert.condition === 'above') condSymbol = '>'
    else if (alert.condition === 'below') condSymbol = '<'
    else condSymbol = '='

    const triggerValueStr = alert.type === 'price' ? `R$ ${Number(alert.value).toFixed(2)}` : String(alert.value)

    tr.innerHTML = `
      <td><b>${escapeHtml(alert.ticker)}</b></td>
      <td><span class="badge font-mono text-xs px-1.5 py-0.5 rounded bg-tertiary" style="background: var(--bg-tertiary); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px;">${escapeHtml(alert.type.toUpperCase())}</span></td>
      <td><code>${condSymbol} ${escapeHtml(triggerValueStr)}</code></td>
      <td><span class="status-indicator ${statusClass}" style="color: ${alert.status === 'active' ? 'var(--success)' : alert.status === 'triggered' ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 600;">${statusText}</span></td>
      <td>
        <button class="toggle-alert-btn icon-btn small inline-btn" data-id="${alert.id}" data-active="${alert.status === 'active'}" title="${alert.status === 'active' ? 'Desativar' : 'Ativar'}" style="display: inline-flex; width: 28px; height: 28px; font-size: 11px; padding: 0; align-items: center; justify-content: center;">
          <span>${alert.status === 'active' ? '⏸️' : '▶️'}</span>
        </button>
        <button class="delete-alert-btn icon-btn small inline-btn danger-hover" data-id="${alert.id}" title="Excluir" style="display: inline-flex; width: 28px; height: 28px; font-size: 11px; padding: 0; align-items: center; justify-content: center;">
          <span>🗑️</span>
        </button>
      </td>
    `
    
    tr.querySelector('.toggle-alert-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      const id = btn.getAttribute('data-id')!
      const isActive = btn.getAttribute('data-active') === 'true'
      try {
        const res = await fetch(`/api/alerts/${id}/toggle`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enable: !isActive })
        })
        if (res.ok) {
          showToast(`Alerta ${isActive ? 'desativado' : 'ativado'}`, 'success')
          fetchAlerts()
        }
      } catch (err: any) {
        showToast(err.message, 'error')
      }
    })

    tr.querySelector('.delete-alert-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement
      const id = btn.getAttribute('data-id')!
      if (!confirm('Deseja realmente excluir este alerta?')) return
      try {
        const res = await fetch(`/api/alerts/${id}`, {
          method: 'DELETE'
        })
        if (res.ok) {
          showToast('Alerta removido', 'success')
          fetchAlerts()
        }
      } catch (err: any) {
        showToast(err.message, 'error')
      }
    })

    activeAlertsList.appendChild(tr)
  })
}

async function fetchHistory(): Promise<void> {
  try {
    const res = await fetch('/api/alerts/history')
    if (!res.ok) throw new Error('Erro ao buscar histórico')
    const history = await res.json() as AlertHistory[]
    renderHistory(history)
  } catch (err: any) {
    showToast(err.message, 'error')
  }
}

function renderHistory(history: AlertHistory[]): void {
  alertsHistoryList.innerHTML = ''
  if (history.length === 0) {
    alertsHistoryList.innerHTML = `<li class="empty-list-msg" style="padding: 1rem; color: var(--text-muted); list-style: none;">Nenhum disparo registrado.</li>`
    clearAlertHistoryBtn.classList.add('hidden')
    return
  }

  clearAlertHistoryBtn.classList.remove('hidden')

  history.forEach(item => {
    const li = document.createElement('li')
    li.className = 'history-item'
    li.style.borderBottom = '1px solid var(--border-color)'
    li.style.padding = '0.75rem 0'
    li.style.listStyle = 'none'
    
    const date = new Date(item.triggeredAt).toLocaleString('pt-BR')
    const typeName = item.type === 'price' ? 'Preço' : item.type === 'rsi' ? 'RSI' : 'Sinal ML'
    
    li.innerHTML = `
      <div class="history-meta" style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">
        <span class="history-ticker"><b>${escapeHtml(item.ticker)}</b></span>
        <span class="history-type badge" style="background: var(--bg-tertiary); padding: 1px 4px; border-radius: 4px;">${escapeHtml(typeName)}</span>
        <span class="history-date">${date}</span>
      </div>
      <div class="history-detail" style="font-size: 0.875rem;">${item.message}</div>
    `
    alertsHistoryList.appendChild(li)
  })
}

function showError(message: string, code?: string): void {
  const errMsg = $<HTMLSpanElement>('error-message')
  let displayMessage = message

  if (code === 'NETWORK_ERROR') {
    displayMessage = 'Erro de conexão. Verifique se o servidor está rodando.'
  } else if (code === 'TIMEOUT') {
    displayMessage = 'Tempo esgotado. Tente novamente.'
  } else if (code === 'INVALID_TICKER') {
    displayMessage = 'Ticker inválido. Use formato: PETR4.SA, VALE3.SA'
  } else if (code === 'NOT_FOUND') {
    displayMessage = 'Ação não encontrada. Verifique o ticker.'
  }

  errMsg.textContent = displayMessage
  errorDiv.classList.remove('hidden')
  window.scrollTo({ top: errorDiv.offsetTop - 20, behavior: 'smooth' })
}

function analyzeFromWatchlist(ticker: string): void {
  input.value = ticker
  form.dispatchEvent(new Event('submit'))
}

darkModeToggle?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme')
  const next = current === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('darkMode', next === 'dark' ? 'true' : 'false')
  showToast(`Modo ${next === 'dark' ? 'escuro' : 'claro'} ativado`, 'info', 2000)
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()

  const ticker = input.value.trim().toUpperCase()

  if (!ticker) {
    showToast('Digite um ticker para analisar', 'warning')
    input.focus()
    return
  }

  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  setLoading(true, 'Analisando ativo com IA...')

  try {
    const response = await fetchWithRetry('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker })
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao analisar ação')
    }

    renderAnalysisResult(data)
    showToast(`${ticker} analisada com sucesso`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'ANALYSIS_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

generatePortfolioBtn.addEventListener('click', async () => {
  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  setLoading(true, 'Analisando ações da B3...')

  try {
    const response = await fetchWithRetry('/api/portfolio', {
      method: 'GET'
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao gerar portfólio')
    }

    renderPortfolioResult(data)
    showToast(`Portfólio gerado (${data.tickersAnalyzed} ações)`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'PORTFOLIO_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

trainingBtn.addEventListener('click', async () => {
  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  setLoading(true, 'Montando treino do mercado...')

  try {
    const response = await fetchWithRetry('/api/training', {
      method: 'GET'
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao gerar treino')
    }

    renderTrainingResult(data)
    showToast(`Treino gerado (${data.drills.length} cenários)`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'TRAINING_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

researchBtn.addEventListener('click', async () => {
  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  const ticker = input.value.trim().toUpperCase() || 'BTC-USD'
  setLoading(true, 'Lendo notícias e papers...')

  try {
    const response = await fetchWithRetry(`/api/research/${encodeURIComponent(ticker)}`, {
      method: 'GET'
    }, 2, 1000)

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Erro ao pesquisar notícias e papers')
    }

    renderResearchResult(data)
    showToast(`Pesquisa pronta (${data.items.length} itens)`, 'success')

  } catch (error: any) {
    if (!navigator.onLine) {
      showError('Você está offline', 'NETWORK_ERROR')
    } else if (error.name === 'TypeError') {
      showError('Erro de conexão com o servidor', 'NETWORK_ERROR')
    } else {
      showError(error.message, 'RESEARCH_ERROR')
    }
  } finally {
    setLoading(false)
  }
})

alertType.addEventListener('change', () => {
  const type = alertType.value
  const condAbove = alertCondition.querySelector('option[value="above"]') as HTMLOptionElement
  const condBelow = alertCondition.querySelector('option[value="below"]') as HTMLOptionElement
  const condEquals = alertCondition.querySelector('option[value="action_equals"]') as HTMLOptionElement

  if (type === 'ml_signal') {
    condAbove.disabled = true
    condBelow.disabled = true
    condEquals.disabled = false
    alertCondition.value = 'action_equals'
    alertValue.placeholder = 'Ex: buy, sell, hold'
  } else {
    condAbove.disabled = false
    condBelow.disabled = false
    condEquals.disabled = true
    alertCondition.value = 'above'
    alertValue.placeholder = type === 'price' ? 'Ex: 75000, 42.50' : 'Ex: 30, 70'
  }
})

alertsBtn.addEventListener('click', () => {
  hideAllResults()
  alertsResultDiv.classList.remove('hidden')
  fetchAlerts()
  fetchHistory()
})

createAlertForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!isOnline) {
    showToast('Você está offline', 'error')
    return
  }

  const ticker = alertTicker.value.trim().toUpperCase()
  const type = alertType.value
  const condition = alertCondition.value
  let value: string | number = alertValue.value.trim()

  if (type === 'price' || type === 'rsi') {
    const num = parseFloat(value)
    if (isNaN(num)) {
      showToast('Digite um valor numérico válido', 'warning')
      return
    }
    value = num
  } else {
    value = value.toLowerCase()
    if (value !== 'buy' && value !== 'sell' && value !== 'hold') {
      showToast('Valor inválido. Use buy, sell ou hold', 'warning')
      return
    }
  }

  try {
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, type, condition, value })
    })

    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error || 'Erro ao criar alerta')
    }

    showToast(`Alerta para ${ticker} criado com sucesso`, 'success')
    alertTicker.value = ''
    alertValue.value = ''
    fetchAlerts()
  } catch (err: any) {
    showToast(err.message, 'error')
  }
})

clearAlertHistoryBtn.addEventListener('click', async () => {
  if (!confirm('Deseja realmente limpar todo o histórico de disparos?')) return
  try {
    const res = await fetch('/api/alerts/clear-history', { method: 'POST' })
    if (res.ok) {
      showToast('Histórico limpo', 'success')
      fetchHistory()
    }
  } catch (err: any) {
    showToast(err.message, 'error')
  }
})

testTelegramBtn.addEventListener('click', async () => {
  testTelegramBtn.disabled = true
  const origContent = testTelegramBtn.innerHTML
  testTelegramBtn.innerHTML = '⏳ Enviando...'
  try {
    const res = await fetch('/api/alerts/test-telegram', { method: 'POST' })
    const data = await res.json()
    if (res.ok && data.success) {
      showToast('Mensagem de teste enviada!', 'success')
    } else {
      throw new Error(data.error || 'Falha ao enviar mensagem de teste. Verifique suas credenciais .env.')
    }
  } catch (err: any) {
    showToast(err.message, 'error')
  } finally {
    testTelegramBtn.disabled = false
    testTelegramBtn.innerHTML = origContent
  }
})

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2, delayMs = 1000): Promise<Response> {
  let lastError: Error | undefined
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options)
      return response
    } catch (error: any) {
      lastError = error
      if (i < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)))
      }
    }
  }
  throw lastError || new Error('fetchWithRetry failed')
}

initApp()