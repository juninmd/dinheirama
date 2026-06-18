import { Hono } from 'hono'
import YahooFinance from 'yahoo-finance2'
import { z } from 'zod'

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

const tickerSchema = z.string().regex(/^[A-Z0-9]{4,6}\.[A-Z]{2}$/, 'Invalid B3 ticker')

interface TrainingSample {
  ticker: string
  timestamp: string
  features: {
    rsi: number | null
    historyChange30d: number
    dayChange: number | null
    volumeRatio: number | null
    priceToSma20: number | null
    priceToSma50: number | null
    atr: number | null
    newsImpactScore: number
    signalCount: number
    assetClass: 'stock' | 'crypto'
    marketCap: number | null
    peRatio: number | null
    dividendYield: number | null
  }
  labels: {
    return_1d: number | null
    return_5d: number | null
    return_20d: number | null
    action_1d: 'buy' | 'hold' | 'sell'
    action_5d: 'buy' | 'hold' | 'sell'
    action_20d: 'buy' | 'hold' | 'sell'
  }
  metadata: {
    currentPrice: number
    collectedAt: string
  }
}

const MARKET_UNIVERSE = [
  'PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA',
  'BBDC4.SA', 'RENT3.SA', 'PRIO3.SA', 'MGLU3.SA', 'B3SA3.SA',
  'GGBR4.SA', 'JBSS3.SA', 'TOTS3.SA', 'RADL3.SA', 'VIVT3.SA',
  'TAEE11.SA', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD'
]

function calculateRSI(quotes: any[], periods: number = 14): number | null {
  if (!quotes || quotes.length <= periods) return null
  let gains = 0, losses = 0
  for (let i = 1; i <= periods; i++) {
    const diff = quotes[i].close - quotes[i - 1].close
    if (diff >= 0) gains += diff
    else losses -= diff
  }
  let avgGain = gains / periods, avgLoss = losses / periods
  for (let i = periods + 1; i < quotes.length; i++) {
    const diff = quotes[i].close - quotes[i - 1].close
    if (diff >= 0) { avgGain = (avgGain * (periods - 1) + diff) / periods; avgLoss = (avgLoss * (periods - 1)) / periods }
    else { avgGain = (avgGain * (periods - 1)) / periods; avgLoss = (avgLoss * (periods - 1) - diff) / periods }
  }
  if (avgLoss === 0) return 100
  return 100 - (100 / (1 + avgGain / avgLoss))
}

function calculateATR(quotes: any[], periods: number = 14): number | null {
  if (!quotes || quotes.length <= periods) return null
  let trSum = 0
  for (let i = 1; i <= periods; i++) {
    const high = quotes[i].high, low = quotes[i].low, prevClose = quotes[i - 1].close
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trSum += tr
  }
  return trSum / periods
}

function getAssetClass(ticker: string): 'stock' | 'crypto' {
  return ticker.endsWith('-USD') ? 'crypto' : 'stock'
}

async function fetchWithRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  let lastError: Error | undefined
  for (let i = 0; i <= retries; i++) {
    try { return await fn() }
    catch (error) { lastError = error as Error; if (i < retries) await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i))) }
  }
  throw lastError
}

async function collectSample(ticker: string): Promise<TrainingSample | null> {
  try {
    const [quote, chart30d, chart1y, fundamentals] = await Promise.allSettled([
      fetchWithRetry(() => yahooFinance.quote(ticker)),
      fetchWithRetry(() => yahooFinance.chart(ticker, { period1: new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0] })),
      fetchWithRetry(() => yahooFinance.chart(ticker, { period1: new Date(Date.now() - 365 * 864e5).toISOString().split('T')[0] })),
      fetchWithRetry(() => yahooFinance.quoteSummary(ticker, { modules: ['summaryDetail', 'defaultKeyStatistics'] }))
    ])

    if (quote.status === 'rejected' || !quote.value?.regularMarketPrice) return null

    const q = quote.value
    const history30d = chart30d.status === 'fulfilled' ? chart30d.value?.quotes : []
    const history1y = chart1y.status === 'fulfilled' ? chart1y.value?.quotes : []
    const fund = fundamentals.status === 'fulfilled' ? fundamentals.value : {}

    const currentPrice = q.regularMarketPrice
    const historyChange30d = history30d.length > 1 && history30d[0]?.close
      ? ((currentPrice - history30d[0].close) / history30d[0].close) * 100
      : 0

    const dayChange = q.regularMarketChangePercent

    const avgVolume30d = history30d.length > 0
      ? history30d.reduce((sum, d) => sum + (d.volume || 0), 0) / history30d.length
      : q.regularMarketVolume || 1
    const volumeRatio = q.regularMarketVolume ? q.regularMarketVolume / avgVolume30d : null

    const sma20 = history1y.length >= 20
      ? history1y.slice(-20).reduce((s, d) => s + d.close, 0) / 20
      : null
    const sma50 = history1y.length >= 50
      ? history1y.slice(-50).reduce((s, d) => s + d.close, 0) / 50
      : null

    const rsi = calculateRSI(history30d)
    const atr = calculateATR(history30d)

    const summaryDetail = fund.summaryDetail || {}
    const defaultStats = fund.defaultKeyStatistics || {}

    return {
      ticker,
      timestamp: new Date().toISOString(),
      features: {
        rsi,
        historyChange30d,
        dayChange,
        volumeRatio,
        priceToSma20: sma20 ? currentPrice / sma20 : null,
        priceToSma50: sma50 ? currentPrice / sma50 : null,
        atr,
        newsImpactScore: 0,
        signalCount: 0,
        assetClass: getAssetClass(ticker),
        marketCap: q.marketCap || null,
        peRatio: summaryDetail.trailingPE?.raw || defaultStats.trailingPE?.raw || null,
        dividendYield: summaryDetail.dividendYield?.raw || defaultStats.dividendYield?.raw || null,
      },
      labels: {
        return_1d: null,
        return_5d: null,
        return_20d: null,
        action_1d: 'hold',
        action_5d: 'hold',
        action_20d: 'hold',
      },
      metadata: { currentPrice, collectedAt: new Date().toISOString() }
    }
  } catch (error) {
    console.error(`Failed to collect ${ticker}:`, error)
    return null
  }
}

async function backfillLabels(samples: TrainingSample[]): Promise<TrainingSample[]> {
  const byTicker = new Map<string, TrainingSample[]>()
  for (const s of samples) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, [])
    byTicker.get(s.ticker)!.push(s)
  }

  for (const [ticker, tickerSamples] of byTicker) {
    tickerSamples.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    try {
      const chart = await fetchWithRetry(() => yahooFinance.chart(ticker, { period1: '2022-01-01' }))
      const quotes = chart?.quotes || []
      const priceMap = new Map(quotes.map(q => [new Date(q.date).toISOString().split('T')[0]!, q.close]))
      
      for (const sample of tickerSamples) {
        const date = sample.timestamp.split('T')[0]!
        const basePrice = priceMap.get(date)
        if (!basePrice) continue
        
        for (const [horizon, days] of [['return_1d', 1], ['return_5d', 5], ['return_20d', 20]] as const) {
          const futureDate = new Date(date)
          futureDate.setDate(futureDate.getDate() + days)
          const futureKey = futureDate.toISOString().split('T')[0]!
          const futurePrice = priceMap.get(futureKey)
          
          if (futurePrice && basePrice > 0) {
            const ret = ((futurePrice - basePrice) / basePrice) * 100
            ;(sample.labels as any)[horizon] = ret
            ;(sample.labels as any)[`action_${days}d`] = ret > 3 ? 'buy' : ret < -3 ? 'sell' : 'hold'
          }
        }
      }
    } catch (error) {
      console.error(`Failed to backfill labels for ${ticker}:`, error)
    }
  }
  return samples
}

async function runCollection(): Promise<TrainingSample[]> {
  console.log(`[${new Date().toISOString()}] Starting training data collection for ${MARKET_UNIVERSE.length} tickers`)
  
  const results = await Promise.allSettled(MARKET_UNIVERSE.map(t => collectSample(t)))
  const samples = results
    .filter((r): r is PromiseFulfilledResult<TrainingSample> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value)
  
  console.log(`Collected ${samples.length} samples, backfilling labels...`)
  const labeled = await backfillLabels(samples)
  
  console.log(`Done. Samples with labels: ${labeled.filter(s => s.labels.return_5d !== null).length}`)
  return labeled
}

async function saveSamples(samples: TrainingSample[]) {
  const fs = await import('fs')
  const path = await import('path')
  
  const outputDir = process.env.TRAINING_DATA_DIR || '/data/training'
  await fs.promises.mkdir(outputDir, { recursive: true })
  
  const dateStr = new Date().toISOString().split('T')[0]
  const filePath = path.join(outputDir, `training_${dateStr}.jsonl`)
  
  const lines = samples.map(s => JSON.stringify(s)).join('\n') + '\n'
  await fs.promises.appendFile(filePath, lines)
  
  console.log(`Saved ${samples.length} samples to ${filePath}`)
}

if (import.meta.main) {
  const samples = await runCollection()
  await saveSamples(samples)
  console.log('Collection complete')
}

export { TrainingSample, collectSample, backfillLabels, runCollection, saveSamples }