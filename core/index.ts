import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { compress } from 'hono/compress'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { CacheManager, mapPool } from './cache.ts'
import { createLlm, llmConfigFromEnv } from './llm'
import { initModel, predict, reloadModel, isModelLoaded } from './training/serve'
import type { FeatureVector, ModelPrediction } from './training/serve'
import {
  getAlerts,
  addAlert,
  deleteAlert,
  toggleAlert,
  getHistory,
  clearHistory,
  startAlertsCheckLoop
} from './alerts-manager.ts'
import { optimizePortfolio, simulateAsset } from './monte-carlo.ts'
import type { AssetSeries, McAssetResult, McEngine, McPortfolioResult } from './monte-carlo.ts'
import { MARKET_UNIVERSE } from './quant/universe.ts'
import * as path from 'path'
import { createYahooMarketData } from './quant/data.ts'
import { classifyRiskByVol, signalFromScore } from './quant/factors.ts'
import type { FundamentalsHistory } from './quant/fundamentals.ts'
import type { UniverseHistory } from './quant/universe.ts'
import { Journal } from './quant/journal.ts'
import { type FactLine, guardedExplain } from './quant/llm-guard.ts'
import { IpsStore, loadPit, loadUniverseHistory, registerQuantRoutes } from './quant/routes.ts'
import { type FactorTableRow, createQuantService } from './quant/service.ts'

const app = new Hono()

const tickerSchema = z.string().regex(/^[A-Z0-9]{4,6}\.[A-Z]{2}$/, 'Invalid B3 ticker format (ex: PETR4.SA)')

const quoteCache = new CacheManager(5)
const chartCache = new CacheManager(10)
const signalCache = new CacheManager(30)
const seriesCache = new CacheManager(180)
/** Cotações recentes (em lote) usadas pelos snapshots: o Yahoo atrasa B3 em ~15 min, então 30 s bastam e ficam abaixo do ciclo de 60 s dos alertas. */
const liveQuoteCache = new CacheManager(0.5, 200)
/** Barras diárias de 1 ano por ticker: uma só chamada alimenta RSI/variação 30d e o Monte Carlo. */
const barsCache = new CacheManager(15, 200)
const snapshotCache = new CacheManager(0.5, 200)
const portfolioCache = new CacheManager(2, 4)

type AssetClass = 'stock'
type SuggestedAction = 'buy' | 'hold' | 'sell'
type ImpactLabel = 'bullish' | 'bearish' | 'neutral'

interface MarketAsset {
  ticker: string
  name: string
  assetClass: AssetClass
  thesis: string
}

interface MarketSignal {
  source: string
  title: string
  url?: string
}

interface ResearchItem extends MarketSignal {
  kind: 'fast-news' | 'news' | 'paper'
  impact: ImpactLabel
  publishedAt?: string
  summary?: string
}

interface AssetSnapshot {
  ticker: string
  name: string
  assetClass: AssetClass
  price: number
  change: number
  volume?: number
  historyChange: number
  rsi: number | null
  score: number
  action: SuggestedAction
  risk: 'low' | 'medium' | 'high'
  newsImpact: {
    label: ImpactLabel
    score: number
    summary: string
  }
  signals: MarketSignal[]
  rationale: string[]
  /** Modelo que gerou score/ação: multifator (validado em backtest) ou legado (RSI + 30d, fallback sem dados). */
  scoreModel?: 'multifactor' | 'legacy'
  legacyScore?: number
  factors?: {
    value: number | null
    quality: number | null
    momentum: number | null
    lowVol: number | null
    coverage: number
    trendOk: boolean | null
    grahamMarginOfSafety: number | null
    piotroski: number | null
    magicFormulaRank: number | null
  }
}

interface TrainingDrill {
  id: string
  ticker: string
  prompt: string
  context: string[]
  expectedDecision: SuggestedAction
  answer: string
}

interface ResearchBrief {
  asset: string
  generatedAt: string
  impact: {
    label: ImpactLabel
    score: number
    summary: string
  }
  items: ResearchItem[]
  nextQuestions: string[]
}

function calculateRSI(quotes: any[], periods: number = 14): number | null {
  if (!quotes || quotes.length <= periods) return null

  let gains = 0
  let losses = 0

  for (let i = 1; i <= periods; i++) {
    const diff = quotes[i].close - quotes[i - 1].close
    if (diff >= 0) {
      gains += diff
    } else {
      losses -= diff
    }
  }

  let avgGain = gains / periods
  let avgLoss = losses / periods

  for (let i = periods + 1; i < quotes.length; i++) {
    const diff = quotes[i].close - quotes[i - 1].close
    if (diff >= 0) {
      avgGain = (avgGain * (periods - 1) + diff) / periods
      avgLoss = (avgLoss * (periods - 1)) / periods
    } else {
      avgGain = (avgGain * (periods - 1)) / periods
      avgLoss = (avgLoss * (periods - 1) - diff) / periods
    }
  }

  if (avgLoss === 0) return 100

  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const logEntry = { timestamp, level, message, ...data }
  console.log(JSON.stringify(logEntry))
}

const llmConfig = llmConfigFromEnv()
const llm = createLlm(llmConfig)

// ---- Camada quantitativa (fatores, backtest, carteira robusta, IPS, diário) ----
const QUANT_RISK_FREE = Number(process.env.MC_RISK_FREE_RATE ?? 0.105)
const QUANT_DATA_DIR = process.env.QUANT_DATA_DIR || process.env.ALERTS_DIR || path.join(import.meta.dir, '..', 'data')
let pitHistory: FundamentalsHistory | null = loadPit(QUANT_DATA_DIR).history
let universeHistory: UniverseHistory | null = loadUniverseHistory(QUANT_DATA_DIR)
const marketData = createYahooMarketData(yahooFinance as any)
const quantService = createQuantService({
  data: marketData,
  universe: MARKET_UNIVERSE,
  riskFreeAnnual: QUANT_RISK_FREE,
  getPit: () => pitHistory,
  getUniverseHistory: () => universeHistory,
  log: (level, message, data) => log(level, message, data),
})
registerQuantRoutes(app, {
  service: quantService,
  data: marketData,
  journal: new Journal(path.join(QUANT_DATA_DIR, 'journal.json')),
  ipsStore: new IpsStore(path.join(QUANT_DATA_DIR, 'ips.json')),
  riskFreeAnnual: QUANT_RISK_FREE,
  dataDir: QUANT_DATA_DIR,
  cvmTickers: MARKET_UNIVERSE.map(asset => ({ ticker: asset.ticker, isFinancial: asset.isFinancial })),
  onPitChange: history => { pitHistory = history },
  onUniverseHistoryChange: history => { universeHistory = history },
  allowedOrigins: envList('ALLOWED_ORIGINS'),
  log: (level, message, data) => log(level, message, data),
})

async function fetchWithTimeout<T>(promise: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | undefined
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      if (i < retries) {
        log('warn', `Retrying request, attempt ${i + 1}/${retries}`)
        await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, i)))
      }
    }
  }
  throw lastError
}

app.use('*', cors())
// JSON da API é verboso e muito compressível; estáticos já saem pré-comprimidos (precompressed).
app.use('/api/*', compress())

const isApiPath = (path: string) => path === '/health' || path.startsWith('/api/')

// Assets do Vite têm hash no nome: cache imutável. O resto (index.html etc.) revalida sempre.
const staticFiles = serveStatic({
  root: './public',
  precompressed: true,
  onFound: (filePath, c) => {
    c.header('Cache-Control', filePath.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  },
})
const spaIndex = serveStatic({
  path: './public/index.html',
  precompressed: true,
  onFound: (_path, c) => { c.header('Cache-Control', 'no-cache') },
})
// Estáticos só para rotas de UI: evita um stat de arquivo em toda chamada de API.
app.use('*', (c, next) => (isApiPath(c.req.path) ? next() : staticFiles(c, next)))
// Fallback SPA: sem o guarda, ele responderia index.html antes de qualquer rota GET da API.
app.get('*', (c, next) => (isApiPath(c.req.path) ? next() : spaIndex(c, next)))

app.get('/', (c) => {
  return c.text('B3 Stock Analyzer API')
})

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache: {
      quoteCacheSize: quoteCache.size,
      chartCacheSize: chartCache.size
    }
  })
})

app.get('/api/integrations/status', (c) => {
  const status = buildIntegrationStatus()
  return c.json(status)
})

app.get('/api/quote/:ticker', async (c) => {
  const ticker = c.req.param('ticker')

  const validation = tickerSchema.safeParse(ticker)
  if (!validation.success) {
    return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
  }

  try {
    const { value: quote, cached } = await quoteCache.getOrLoad(`quote:${ticker}`, async () => {
      const result = await fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500) as Record<string, any>
      return !result || result.regularMarketPrice === undefined ? null : result
    })

    if (!quote) {
      return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)
    }

    return c.json(cached ? { ...quote, cached: true } : quote)
  } catch (error: any) {
    log('error', `Failed to fetch quote for ${ticker}`, { error: error.message })
    return c.json({ error: 'Failed to fetch quote', code: 'QUOTE_ERROR' }, 500)
  }
})

app.get('/api/history/:ticker', async (c) => {
  const ticker = c.req.param('ticker')

  const validation = tickerSchema.safeParse(ticker)
  if (!validation.success) {
    return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
  }

  try {
    const { value, cached } = await chartCache.getOrLoad(`history:${ticker}`, () =>
      fetchWithRetry(() => yahooFinance.historical(ticker, { period1: '2023-01-01' }), 2, 500)
    )
    // histórico é um array: espalhá-lo num objeto (como antes) quebrava o formato no cache hit
    c.header('X-Cache', cached ? 'HIT' : 'MISS')
    return c.json(value)
  } catch (error: any) {
    log('error', `Failed to fetch history for ${ticker}`, { error: error.message })
    return c.json({ error: 'Failed to fetch history', code: 'HISTORY_ERROR' }, 500)
  }
})

app.post('/api/analyze', async (c) => {
  try {
    const body = await c.req.json()
    const ticker = normalizeAsset(body.ticker || '')

    if (!ticker) {
      return c.json({ error: 'Ticker is required', code: 'MISSING_TICKER' }, 400)
    }

    const validation = tickerSchema.safeParse(ticker)
    if (!validation.success) {
      return c.json({
        error: 'Invalid asset format. Use B3 tickers like PETR4.SA, VALE3.SA, etc.',
        code: 'INVALID_TICKER'
      }, 400)
    }

    log('info', `Analyzing asset: ${ticker}`)
    const asset: MarketAsset = {
      ticker,
      name: body.name || ticker,
      assetClass: getAssetClass(ticker),
      thesis: body.thesis || 'Ativo solicitado pelo usuario',
    }

    const snapshot = await buildAssetSnapshot(asset)
    if (!snapshot) {
      return c.json({ error: 'Asset not found', code: 'NOT_FOUND' }, 404)
    }

    const series = await fetchCloseSeries(ticker)
    const monteCarlo = series ? simulateAsset(series, { days: 21, sims: 5000 }) : null

    const facts: FactLine[] = [
      { label: 'Ativo', display: `${snapshot.ticker} (${snapshot.name})` },
      { label: 'Preço', display: `R$ ${snapshot.price.toFixed(2)}`, numbers: [snapshot.price] },
      { label: 'Score (posto 0-100 no universo)', display: `${snapshot.score} (modelo ${snapshot.scoreModel ?? 'legacy'})`, numbers: [snapshot.score] },
      { label: 'Sinal educacional', display: snapshot.action },
      { label: 'Risco por volatilidade', display: snapshot.risk },
      ...snapshot.rationale.map(line => ({ label: 'Leitura', display: line })),
      { label: 'Notícias/papers (não entram no score)', display: `${snapshot.newsImpact.label}: ${snapshot.newsImpact.summary}` },
      ...(monteCarlo ? [{ label: 'Monte Carlo', display: formatMcAsset(monteCarlo) }] : [{ label: 'Monte Carlo', display: 'histórico insuficiente' }]),
    ]

    const fallbackText = [
      `**Sinal do modelo (ranking relativo, não previsão):** ${snapshot.action.toUpperCase()} — score ${snapshot.score}/100, risco ${snapshot.risk}.`,
      '',
      `**Leitura:** ${snapshot.rationale.join(' ')}`,
      '',
      `**Notícias/papers (informativo):** ${snapshot.newsImpact.summary}.`,
      '',
      monteCarlo
        ? `**Monte Carlo (${monteCarlo.days}d):** retorno médio ${monteCarlo.distribution.meanPct}%, prob. de lucro ${(monteCarlo.distribution.probProfit * 100).toFixed(0)}%, P5 ${monteCarlo.distribution.percentiles.p5}%, P95 ${monteCarlo.distribution.percentiles.p95}%, CVaR95 ${monteCarlo.distribution.cvar95Pct}%. A média histórica é uma estimativa ruidosa: use o intervalo, não o ponto.`
        : '**Monte Carlo:** histórico insuficiente para simular.',
      '',
      '**O que não sabemos:** resultados futuros, notícias não capturadas e sua situação pessoal (horizonte, reserva, tolerância a perdas).',
    ].join('\n')

    const guarded = await guardedExplain(
      { generate: prompt => fetchWithTimeout(llm.generate(prompt), 300000) },
      `Análise educacional de ${snapshot.ticker}`,
      facts,
      fallbackText
    )
    const aiResponse = guarded.text
    const aiSource = guarded.source === 'llm' ? 'litellm' : 'fallback'
    if (guarded.rejected) log('warn', 'LLM answer rejected by guard', { ticker, unsupported: guarded.rejected.unsupportedNumbers, forbidden: guarded.rejected.forbidden })

    log('info', `Analysis complete for ${ticker}`, { rsi: snapshot.rsi, score: snapshot.score, action: snapshot.action, aiSource })

    const mlFeatures: FeatureVector = {
      rsi: snapshot.rsi,
      historyChange30d: snapshot.historyChange,
      dayChange: snapshot.change,
      volumeRatio: null,
      priceToSma20: null,
      priceToSma50: null,
      atr: null,
      newsImpactScore: snapshot.newsImpact.score,
      signalCount: snapshot.signals.length,
      marketCap: null,
      peRatio: null,
      dividendYield: null,
    }
    const mlPrediction = predict(mlFeatures)

    return c.json({
      ticker,
      name: snapshot.name,
      assetClass: snapshot.assetClass,
      quote: {
        price: snapshot.price,
        change: snapshot.change,
        volume: snapshot.volume,
      },
      rsi: snapshot.rsi,
      score: snapshot.score,
      action: snapshot.action,
      risk: snapshot.risk,
      newsImpact: snapshot.newsImpact,
      signals: snapshot.signals,
      rationale: snapshot.rationale,
      analysis: aiResponse,
      aiSource,
      mlPrediction,
      monteCarlo,
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    log('error', 'Analysis failed', { error: error.message })
    return c.json({ error: error.message, code: 'ANALYSIS_ERROR' }, 500)
  }
})

const CONCURRENCY_LIMIT = 5
const MC_LOOKBACK_DAYS = Number(process.env.MC_LOOKBACK_DAYS ?? 365)
const BARS_LOOKBACK_DAYS = Math.max(MC_LOOKBACK_DAYS, 90)

interface DailyBar {
  /** epoch ms (UTC) do pregão */
  t: number
  close: number | null
  volume: number | null
}

const isoDay = (ms: number) => new Date(ms).toISOString().split('T')[0]!

/** Barras diárias (cache de 15 min, uma chamada por ticker): alimenta RSI, variação 30d, /api/predict e Monte Carlo. */
async function fetchBars(ticker: string): Promise<DailyBar[]> {
  const { value } = await barsCache.getOrLoad(`bars:${ticker}`, async () => {
    const period1 = isoDay(Date.now() - BARS_LOOKBACK_DAYS * 864e5)
    const chart = await fetchWithTimeout(
      fetchWithRetry(() => yahooFinance.chart(ticker, { period1 }), 1, 500),
      12000
    )
    const bars: DailyBar[] = ((chart?.quotes as any[]) || []).map(quote => ({
      t: new Date(quote?.date).getTime(),
      close: typeof quote?.close === 'number' ? quote.close : null,
      volume: typeof quote?.volume === 'number' ? quote.volume : null,
    }))
    return bars.length > 0 ? bars : null
  })
  return value ?? []
}

/** Fatia das barras a partir de `days` dias atrás (mesmo corte de data que o `period1` usado antes). */
function barsSince(bars: DailyBar[], days: number): DailyBar[] {
  const cutoff = Date.parse(isoDay(Date.now() - days * 864e5))
  return bars.filter(bar => bar.t >= cutoff)
}

/** Cotação recente (cache de 30 s, deduplicada); `null` se o ticker não existe. */
async function fetchLiveQuote(ticker: string): Promise<any | null> {
  const { value } = await liveQuoteCache.getOrLoad(`q:${ticker}`, async () => {
    const quote = await fetchWithTimeout(fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500), 10000) as any
    return !quote || quote.regularMarketPrice === undefined ? null : quote
  })
  return value
}

/** Pré-carrega as cotações de vários tickers numa única chamada ao Yahoo; falha aqui só desfaz o ganho. */
async function prefetchQuotes(tickers: string[]): Promise<void> {
  const missing = tickers.filter(ticker => !liveQuoteCache.has(`q:${ticker}`))
  if (missing.length < 2) return
  try {
    const quotes = await fetchWithTimeout(fetchWithRetry(() => yahooFinance.quote(missing), 1, 500), 15000) as any[]
    for (const quote of quotes ?? []) {
      if (quote?.symbol && quote.regularMarketPrice !== undefined) liveQuoteCache.set(`q:${quote.symbol}`, quote)
    }
  } catch (error: any) {
    log('warn', 'Batch quote prefetch failed; falling back to per-ticker quotes', { error: error.message })
  }
}

/** Snapshot com cache curto e deduplicação: portfólio, alertas e /api/analyze compartilham o mesmo trabalho. */
export async function buildAssetSnapshot(asset: MarketAsset): Promise<AssetSnapshot | null> {
  const { value } = await snapshotCache.getOrLoad(`snap:${asset.ticker}`, () => computeAssetSnapshot(asset))
  // o nome vem do chamador (universo, ticker puro nos alertas, texto livre no /analyze)
  return value && value.name !== asset.name ? { ...value, name: asset.name } : value
}

async function computeAssetSnapshot(asset: MarketAsset): Promise<AssetSnapshot | null> {
  try {
    const quote = await fetchLiveQuote(asset.ticker)
    if (!quote) return null

    let historyChange = 0
    let rsi: number | null = null

    try {
      const history = barsSince(await fetchBars(asset.ticker), 30)

      if (history.length > 0) {
        const pastPrice = history[0]?.close
        const currentPrice = quote.regularMarketPrice

        if (pastPrice != null && currentPrice != null && pastPrice > 0) {
          historyChange = ((currentPrice - pastPrice) / pastPrice) * 100
        }
        rsi = calculateRSI(history)
      }
    } catch (error: any) {
      log('warn', `History fetch failed for ${asset.ticker}`, { error: error.message })
    }

    const signals = await fetchMarketSignals(asset)
    const newsImpact = estimateNewsImpact(signals)
    const partialSnapshot = {
      ticker: asset.ticker,
      name: asset.name,
      assetClass: asset.assetClass,
      price: quote.regularMarketPrice,
      change: quote.regularMarketChangePercent,
      volume: quote.regularMarketVolume,
      historyChange,
      rsi,
      newsImpact,
      signals,
    }
    const score = scoreAsset(rsi, historyChange, quote.regularMarketChangePercent, signals, newsImpact.score)

    return await applyFactorModel({
      ...partialSnapshot,
      score,
      action: getAction(score),
      risk: classifyRisk(asset.assetClass, rsi, historyChange),
      rationale: buildRationale(partialSnapshot),
      scoreModel: 'legacy',
      legacyScore: score,
    })
  } catch (error: any) {
    log('warn', `Snapshot failed for ${asset.ticker}`, { error: error.message })
    return null
  }
}

function buildFactorRationale(row: FactorTableRow): string[] {
  const pct = (v: number | null, digits = 1) => (v === null ? 'n/d' : `${(v * 100).toFixed(digits)}%`)
  const out = [`Posto ${row.score}/100 no universo (${Math.round(row.coverage * 4)}/4 fatores com dado: valor, qualidade, momentum, baixa volatilidade).`]
  if (row.metrics.momentum12_1 !== null) out.push(`Momentum 12-1: ${pct(row.metrics.momentum12_1)}; volatilidade anual ${pct(row.metrics.vol, 0)}.`)
  if (row.trendOk === false) out.push('Tendência absoluta negativa (momentum abaixo do CDI): sinal limitado a "manter".')
  if (row.grahamMarginOfSafety !== null) out.push(`Margem de segurança sobre o número de Graham: ${pct(row.grahamMarginOfSafety, 0)}.`)
  if (row.metrics.piotroski !== null) out.push(`Piotroski F-Score: ${row.metrics.piotroski}/9.`)
  if (!row.hasFundamentals) out.push('Sem fundamentos disponíveis: score usa só momentum e baixa volatilidade.')
  return out
}

/** Substitui o score legado (RSI + 30d) pelo posto multifator; sem dados, mantém o legado e sinaliza. */
async function applyFactorModel(snapshot: AssetSnapshot): Promise<AssetSnapshot> {
  try {
    const table = await quantService.getFactorTable()
    const row = table?.rows.find(candidate => candidate.ticker === snapshot.ticker)
    if (!row || row.score === null) return snapshot
    return {
      ...snapshot,
      score: row.score,
      action: signalFromScore(row.score, row.trendOk),
      risk: classifyRiskByVol(row.metrics.vol, row.metrics.drawdown),
      rationale: buildFactorRationale(row),
      scoreModel: 'multifactor',
      factors: {
        ...row.groups,
        coverage: row.coverage,
        trendOk: row.trendOk,
        grahamMarginOfSafety: row.grahamMarginOfSafety,
        piotroski: row.metrics.piotroski,
        magicFormulaRank: row.magicFormulaRank,
      },
    }
  } catch (error: any) {
    log('warn', `Factor model unavailable for ${snapshot.ticker}`, { error: error.message })
    return snapshot
  }
}

/** Radar completo, com cache de 2 min e uma única geração por vez (inclui LLM e Monte Carlo, que são caros). */
export async function buildPortfolio(): ReturnType<typeof computePortfolio> {
  const { value } = await portfolioCache.getOrLoad('portfolio', computePortfolio)
  return value
}

async function computePortfolio() {
  log('info', 'Portfolio generation started')

  {
    await prefetchQuotes(MARKET_UNIVERSE.map(asset => asset.ticker))
    const quoteResults = await mapPool(MARKET_UNIVERSE, CONCURRENCY_LIMIT, asset => buildAssetSnapshot(asset))

    const quotes = quoteResults.filter((q): q is AssetSnapshot => q !== null)

    log('info', `Portfolio: ${quotes.length}/${MARKET_UNIVERSE.length} assets loaded`)

    if (quotes.length === 0) {
      throw new Error('No data available')
    }

    const monteCarlo = await runMonteCarloPortfolio(quotes.map(q => q.ticker), { days: 21, sims: 4000, engine: 'bootstrap' })
    log('info', 'Portfolio Monte Carlo', { available: monteCarlo !== null, assets: monteCarlo?.assets.length ?? 0 })

    const ranked = [...quotes].sort((a, b) => b.score - a.score)
    const mcLines = monteCarlo
      ? [monteCarlo.best.sharpe, monteCarlo.best.defensive].map(candidate => ({
          label: `Monte Carlo (${candidate.label})`,
          display: `${candidate.weights.map(w => `${w.ticker} ${(w.weight * 100).toFixed(1)}%`).join(', ')} => retorno médio ${candidate.distribution.meanPct}%, P95 ${candidate.distribution.percentiles.p95}%, prob. de lucro ${(candidate.distribution.probProfit * 100).toFixed(0)}%, CVaR95 ${candidate.distribution.cvar95Pct}%`,
        }))
      : []
    const facts: FactLine[] = [
      ...ranked.slice(0, 5).map(q => ({
        label: q.ticker,
        display: `sinal ${q.action}, score ${q.score}/100, risco ${q.risk}, 30D ${q.historyChange.toFixed(1)}%`,
      })),
      ...mcLines,
    ]

    const fallbackText = [
      '**Radar educacional de ações da B3** (ranking relativo por fatores; não é previsão nem recomendação)',
      '',
      ...ranked.slice(0, 5).map((q, i) => `${i + 1}. **${q.ticker}** — sinal ${q.action.toUpperCase()} | score ${q.score}/100 | risco ${q.risk} | 30D ${q.historyChange.toFixed(1)}%.`),
      ...(monteCarlo
        ? [
            '',
            `**Simulação Monte Carlo (${monteCarlo.days}d, médias encolhidas):**`,
            ...mcLines.map(line => `- ${line.label}: ${line.display}.`),
            'Retornos esperados são estimativas ruidosas; prefira conferir /api/portfolio/construct (HRP) para pesos baseados em risco.',
          ]
        : []),
      '',
      '**Gestão:** diversifique, respeite o seu IPS (/api/ips) e dimensione posições pelo risco, nunca pela expectativa de lucro.',
    ].join('\n')

    const guarded = await guardedExplain(
      { generate: prompt => fetchWithTimeout(llm.generate(prompt), 300000) },
      'Radar educacional de ações da B3',
      facts,
      fallbackText
    )
    const aiResponse = guarded.text
    const aiSource = guarded.source === 'llm' ? 'litellm' : 'fallback'
    if (guarded.rejected) log('warn', 'LLM portfolio answer rejected by guard', { unsupported: guarded.rejected.unsupportedNumbers, forbidden: guarded.rejected.forbidden })

    log('info', 'Portfolio generation complete', { quotesCount: quotes.length, aiSource })

    return {
      portfolio: quotes,
      recommendation: aiResponse,
      aiSource,
      monteCarlo,
      tickersAnalyzed: quotes.length,
      timestamp: new Date().toISOString()
    }
  }
}

app.get('/api/portfolio', async (c) => {
  try {
    return c.json(await buildPortfolio())
  } catch (error: any) {
    log('error', 'Portfolio generation failed', { error: error.message })
    return c.json({ error: error.message, code: 'PORTFOLIO_ERROR' }, 500)
  }
})

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function parseMcParams(c: { req: { query: (key: string) => string | undefined } }) {
  const engineParam = c.req.query('engine')
  return {
    days: clampNumber(c.req.query('days'), 21, 1, 252),
    sims: clampNumber(c.req.query('sims'), 5000, 200, 20000),
    engine: (engineParam === 'gbm' ? 'gbm' : 'bootstrap') as McEngine,
  }
}

/** Série de fechamentos para Monte Carlo, derivada das barras diárias em cache (sem nova chamada ao Yahoo). */
async function fetchCloseSeries(ticker: string, lookbackDays = MC_LOOKBACK_DAYS): Promise<AssetSeries | null> {
  const cacheKey = `series:${ticker}:${lookbackDays}`
  const cached = seriesCache.get<AssetSeries>(cacheKey)
  if (cached) return cached

  try {
    const closes = barsSince(await fetchBars(ticker), lookbackDays)
      .map(bar => bar.close)
      .filter((close): close is number => typeof close === 'number' && close > 0)

    if (closes.length < 31) return null

    const series: AssetSeries = { ticker, closes }
    seriesCache.set(cacheKey, series)
    return series
  } catch (error: any) {
    log('warn', `Monte Carlo series fetch failed for ${ticker}`, { error: error.message })
    return null
  }
}

async function runMonteCarloPortfolio(
  tickers: string[],
  params: { days: number; sims: number; engine: McEngine }
): Promise<McPortfolioResult | null> {
  const seriesResults = await mapPool(tickers, CONCURRENCY_LIMIT, ticker => fetchCloseSeries(ticker))
  const series = seriesResults.filter((item): item is AssetSeries => item !== null)
  if (series.length < 2) return null
  return optimizePortfolio(series, params)
}

function formatMcAsset(result: McAssetResult): string {
  const dist = result.distribution
  return `Monte Carlo ${result.days}d (${result.sims} simulações, ${result.engine}): retorno médio ${dist.meanPct}% | mediana ${dist.medianPct}% | P5 ${dist.percentiles.p5}% | P95 ${dist.percentiles.p95}% | prob. de lucro ${(dist.probProfit * 100).toFixed(0)}% | prob. de +10% ${(dist.probGain10 * 100).toFixed(0)}% | VaR95 ${dist.var95Pct}% | CVaR95 ${dist.cvar95Pct}% | drawdown mediano ${result.maxDrawdownP50Pct}% | Sharpe ${dist.sharpe} | Kelly ${result.kellyFraction} | vol anual ${result.volatility.annualized}% | veredito ${result.verdict}`
}

function formatMcPortfolio(result: McPortfolioResult): string {
  const describe = (label: string, candidate: McPortfolioResult['best']['sharpe']) => {
    const weights = candidate.weights.map(w => `${w.ticker} ${(w.weight * 100).toFixed(1)}%`).join(', ')
    const dist = candidate.distribution
    return `- ${label}: ${weights || 'n/d'} => retorno médio ${dist.meanPct}%, P95 ${dist.percentiles.p95}%, prob. de lucro ${(dist.probProfit * 100).toFixed(0)}%, CVaR95 ${dist.cvar95Pct}%, drawdown mediano ${candidate.maxDrawdownP50Pct}%, Sharpe ${dist.sharpe}`
  }

  return [
    `Otimização Monte Carlo (${result.candidates} alocações testadas, ${result.sims} simulações, horizonte ${result.days} dias, ${result.samples} dias de histórico):`,
    describe('Maior retorno médio simulado, com CVaR limitado', result.best.aggressive),
    describe('Melhor Sharpe', result.best.sharpe),
    describe('Defensiva (menor cauda)', result.best.defensive),
  ].join('\n')
}

app.get('/api/montecarlo/:ticker', async (c) => {
  try {
    const ticker = normalizeAsset(c.req.param('ticker'))
    const validation = tickerSchema.safeParse(ticker)
    if (!validation.success) {
      return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
    }

    const params = parseMcParams(c)
    const series = await fetchCloseSeries(ticker)
    if (!series) {
      return c.json({ error: 'Not enough history for Monte Carlo', code: 'MC_NO_HISTORY' }, 404)
    }

    const result = simulateAsset(series, params)
    if (!result) {
      return c.json({ error: 'Not enough history for Monte Carlo', code: 'MC_NO_HISTORY' }, 404)
    }

    log('info', `Monte Carlo done for ${ticker}`, { days: params.days, sims: params.sims, engine: params.engine })
    return c.json({ ...result, generatedAt: new Date().toISOString() })
  } catch (error: any) {
    log('error', 'Monte Carlo failed', { error: error.message })
    return c.json({ error: error.message, code: 'MONTECARLO_ERROR' }, 500)
  }
})

app.get('/api/portfolio/montecarlo', async (c) => {
  try {
    const params = parseMcParams(c)
    const result = await runMonteCarloPortfolio(MARKET_UNIVERSE.map(asset => asset.ticker), params)
    if (!result) {
      return c.json({ error: 'Not enough history for Monte Carlo', code: 'MC_NO_HISTORY' }, 404)
    }

    log('info', 'Monte Carlo portfolio done', { assets: result.assets.length, days: params.days, sims: params.sims })
    return c.json({ ...result, generatedAt: new Date().toISOString() })
  } catch (error: any) {
    log('error', 'Monte Carlo portfolio failed', { error: error.message })
    return c.json({ error: error.message, code: 'MONTECARLO_PORTFOLIO_ERROR' }, 500)
  }
})

function buildTrainingDrills(portfolio: AssetSnapshot[]): TrainingDrill[] {
  const ranked = [...portfolio].sort((a, b) => b.score - a.score)
  const candidates = [
    ...ranked.slice(0, 3),
    ...ranked.slice(-2),
  ].filter((asset, index, all) => all.findIndex(item => item.ticker === asset.ticker) === index)

  return candidates.map((asset, index) => ({
    id: `${asset.ticker}-${index + 1}`,
    ticker: asset.ticker,
    prompt: `Decida se voce compraria, manteria ou venderia ${asset.ticker} nas proximas 24h.`,
    context: [
      `Score ${asset.score}/100, acao sugerida ${asset.action}, risco ${asset.risk}.`,
      `30D ${asset.historyChange.toFixed(1)}%, RSI ${asset.rsi?.toFixed(0) || 'N/A'}, variacao diaria ${asset.change?.toFixed(1) || 'N/A'}%.`,
      `Impacto externo ${asset.newsImpact.label}/${asset.newsImpact.score}: ${asset.newsImpact.summary}`,
      ...asset.rationale.slice(0, 2),
    ],
    expectedDecision: asset.action,
    answer: [
      `Decisao esperada: ${asset.action.toUpperCase()}.`,
      `Motivo: ${asset.rationale.join(' ')}`,
      `Invalide a tese se o fluxo de noticias/papers mudar para bearish, se o volume confirmar rompimento contra a posicao ou se o RSI entrar em extremo oposto.`,
    ].join(' '),
  }))
}

app.get('/api/training', async (c) => {
  try {
    const result = await buildPortfolio()
    return c.json({
      generatedAt: new Date().toISOString(),
      drills: buildTrainingDrills(result.portfolio),
      source: {
        tickersAnalyzed: result.tickersAnalyzed,
        aiSource: result.aiSource,
      },
    })
  } catch (error: any) {
    log('error', 'Training generation failed', { error: error.message })
    return c.json({ error: error.message, code: 'TRAINING_ERROR' }, 500)
  }
})

app.get('/api/research/:ticker', async (c) => {
  try {
    const ticker = normalizeAsset(c.req.param('ticker'))
    const validation = tickerSchema.safeParse(ticker)
    if (!validation.success) {
      return c.json({ error: 'Invalid asset format', code: 'INVALID_TICKER' }, 400)
    }

    const asset: MarketAsset = {
      ticker,
      name: c.req.query('name') || ticker,
      assetClass: getAssetClass(ticker),
      thesis: 'Pesquisa sob demanda',
    }

    return c.json(await buildResearchBrief(asset))
  } catch (error: any) {
    log('error', 'Research generation failed', { error: error.message })
    return c.json({ error: error.message, code: 'RESEARCH_ERROR' }, 500)
  }
})

app.get('/api/predict', async (c) => {
  try {
    const ticker = normalizeAsset(c.req.query('ticker') || '')
    if (!ticker) return c.json({ error: 'ticker query param required', code: 'MISSING_TICKER' }, 400)

    const quote = await fetchLiveQuote(ticker)
    if (!quote?.regularMarketPrice) return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)

    const history = barsSince(await fetchBars(ticker), 60)

    const currentPrice = quote.regularMarketPrice
    const pastPrice = history[0]?.close ?? 0
    const historyChange30d = pastPrice > 0 ? ((currentPrice - pastPrice) / pastPrice) * 100 : 0
    const avgVolume = history.length > 0 ? history.reduce((s, d) => s + (d.volume || 0), 0) / history.length : 1
    const sma50 = history.length >= 50 ? history.slice(-50).reduce((s, d) => s + (d.close ?? 0), 0) / 50 : null

    const features: FeatureVector = {
      rsi: calculateRSI(history),
      historyChange30d,
      dayChange: quote.regularMarketChangePercent,
      volumeRatio: quote.regularMarketVolume ? quote.regularMarketVolume / avgVolume : null,
      priceToSma20: null,
      priceToSma50: sma50 ? currentPrice / sma50 : null,
      atr: null,
      newsImpactScore: 0,
      signalCount: 0,
      marketCap: quote.marketCap || null,
      peRatio: null,
      dividendYield: null,
    }

    const prediction = predict(features)

    return c.json({
      ticker,
      prediction,
      quote: { price: currentPrice, change: quote.regularMarketChangePercent },
      modelLoaded: isModelLoaded(),
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    log('error', 'Prediction failed', { error: error.message })
    return c.json({ error: error.message, code: 'PREDICT_ERROR' }, 500)
  }
})

/** Executa um comando sem bloquear o event loop (spawnSync travava todas as requisições durante o treino). */
async function runCommand(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd.split(' '), { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

app.post('/api/training/collect', async (c) => {
  try {
    const cmd = process.env.TRAINING_COLLECT_CMD || 'bun run ./training/collector.ts'
    const proc = await runCommand(cmd)
    const stdout = proc.stdout
    const stderr = proc.stderr
    log('info', 'Training collection executed', { stdout, stderr: stderr.slice(0, 200) })
    return c.json({ collected: true, stdout: stdout.slice(0, 500), exitCode: proc.exitCode })
  } catch (error: any) {
    log('error', 'Training collection trigger failed', { error: error.message })
    return c.json({ error: error.message, code: 'COLLECT_ERROR' }, 500)
  }
})

app.post('/api/training/retrain', async (c) => {
  try {
    const cmd = process.env.TRAINING_RETRAIN_CMD || 'python3 ./training/trainer.py'
    const proc = await runCommand(cmd)
    const stdout = proc.stdout
    const stderr = proc.stderr
    log('info', 'Training retrain executed', { stdout: stdout.slice(0, 300), stderr: stderr.slice(0, 200) })
    reloadModel()
    return c.json({ retrained: true, f1: stdout.match(/F1: ([\d.]+)/)?.[1] || null, exitCode: proc.exitCode })
  } catch (error: any) {
    log('error', 'Retrain trigger failed', { error: error.message })
    return c.json({ error: error.message, code: 'RETRAIN_ERROR' }, 500)
  }
})

app.get('/api/model/status', (c) => {
  return c.json({
    modelLoaded: isModelLoaded(),
    modelDir: process.env.MODEL_DIR || '/data/models',
    retrainUrl: 'POST /api/training/retrain',
    collectUrl: 'POST /api/training/collect',
  })
})

app.get('/api/alerts', (c) => {
  return c.json(getAlerts())
})

app.post('/api/alerts', async (c) => {
  try {
    const body = await c.req.json()
    const { ticker, type, condition, value } = body
    if (!ticker || !type || !condition || value === undefined) {
      return c.json({ error: 'Missing required alert fields' }, 400)
    }
    const newAlert = addAlert({
      ticker: String(ticker).toUpperCase().trim(),
      type,
      condition,
      value
    })
    return c.json(newAlert)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.put('/api/alerts/:id/toggle', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const { enable } = body
    const success = toggleAlert(id, enable !== false)
    return c.json({ success })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/api/alerts/:id', (c) => {
  const id = c.req.param('id')
  const success = deleteAlert(id)
  return c.json({ success })
})

app.get('/api/alerts/history', (c) => {
  return c.json(getHistory())
})

app.post('/api/alerts/clear-history', (c) => {
  clearHistory()
  return c.json({ success: true })
})

app.post('/api/alerts/test-telegram', async (c) => {
  try {
    const { sendTelegram } = await import('./telegram-daily.ts')
    await sendTelegram('⚡ <b>Dinheirama Alertas</b>\nConexão de teste bem-sucedida! O canal de alertas está funcionando.')
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Agendador diario do envio da carteira ao Telegram (roda no servidor 24/7).
// NOTIFY_UTC_HOUR define a hora UTC (default 11 = 08h BRT). Desativa sem TELEGRAM_*.
function msUntilNextRun(utcHour: number): number {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0, 0))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

async function scheduleDailyNotify(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    log('info', 'Daily Telegram notify disabled (no TELEGRAM_* env)')
    return
  }
  const utcHour = Number(process.env.NOTIFY_UTC_HOUR ?? 11)
  const { sendDailyPortfolio } = await import('./telegram-daily.ts')
  const run = async () => {
    try {
      await sendDailyPortfolio()
      log('info', 'Daily Telegram notify sent')
    } catch (error: any) {
      log('error', 'Daily Telegram notify failed', { error: error.message })
    }
    setTimeout(run, msUntilNextRun(utcHour))
  }
  setTimeout(run, msUntilNextRun(utcHour))
  log('info', 'Daily Telegram notify scheduled', { utcHour })
}

if (import.meta.main) {
  void scheduleDailyNotify()
  initModel()
  log('info', 'ML model init: ' + (isModelLoaded() ? 'loaded' : 'fallback'))
  // Start background alert checker (runs every 60s by default)
  startAlertsCheckLoop(buildAssetSnapshot, Number(process.env.ALERT_CHECK_INTERVAL_MS ?? 60000))
}

export default {
  port: 3000,
  fetch: app.fetch,
  idleTimeout: 255,
}

function normalizeAsset(input: string): string {
  return input.trim().toUpperCase()
}

function getAssetClass(ticker: string): AssetClass {
  return 'stock'
}

function envList(name: string): string[] {
  return String(process.env[name] || '').split(',').map(item => item.trim()).filter(Boolean)
}

function buildIntegrationStatus() {
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  const fastNewsConfigured = Boolean(process.env.FAST_NEWS_URL)
  const marketFeeds = envList('MARKET_NEWS_FEEDS')
  const paperFeeds = envList('PAPER_FEEDS')
  const notifyUtcHour = Number(process.env.NOTIFY_UTC_HOUR ?? 11)

  return {
    generatedAt: new Date().toISOString(),
    integrations: {
      llm: {
        configured: Boolean(llmConfig.apiKey),
        host: llmConfig.baseUrl.replace(/\/\/.*@/, '//redacted@'),
        model: llmConfig.model,
      },
      fastNews: {
        configured: fastNewsConfigured,
        endpoint: fastNewsConfigured ? `${process.env.FAST_NEWS_URL!.replace(/\/$/, '')}/api/rag/search` : null,
      },
      marketNewsFeeds: {
        configured: marketFeeds.length > 0,
        count: marketFeeds.length,
      },
      paperFeeds: {
        configured: paperFeeds.length > 0,
        count: paperFeeds.length,
        fallback: paperFeeds.length === 0 ? 'arxiv-default' : null,
      },
      telegram: {
        configured: telegramConfigured,
        notifyUtcHour,
      },
    },
    missingForFull24h: [
      ...(!fastNewsConfigured ? ['FAST_NEWS_URL'] : []),
      ...(marketFeeds.length === 0 ? ['MARKET_NEWS_FEEDS'] : []),
      ...(!telegramConfigured ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] : []),
    ],
  }
}

function getAction(score: number): SuggestedAction {
  if (score >= 55) return 'buy'
  if (score <= 40) return 'sell'
  return 'hold'
}

function scoreAsset(rsi: number | null, historyChange: number, dayChange: number | undefined | null, signals: MarketSignal[], newsImpactScore: number): number {
  let score = 50

  if (rsi != null) {
    if (rsi > 70) score += 25
    else if (rsi > 60) score += 8
    else if (rsi < 30) score -= 15
    else if (rsi < 40) score -= 8
  }

  if (historyChange > 12) score += 30
  else if (historyChange > 4) score += 10
  else if (historyChange < -18) score -= 12
  else if (historyChange < -8) score -= 6

  if (dayChange != null) {
    if (dayChange > 4) score += 4
    else if (dayChange < -4) score -= 4
  }

  if (signals.length > 0) score += Math.min(5, signals.length)
  score += newsImpactScore * 1.5

  return Math.max(0, Math.min(100, Math.round(score)))
}

function classifyRisk(assetClass: AssetClass, rsi: number | null, historyChange: number): AssetSnapshot['risk'] {
  if ((rsi != null && (rsi < 25 || rsi > 85)) || Math.abs(historyChange) > 25) return 'high'
  if ((rsi != null && (rsi < 35 || rsi > 75)) || Math.abs(historyChange) > 15) return 'medium'
  return 'low'
}

function buildRationale(snapshot: Omit<AssetSnapshot, 'score' | 'action' | 'risk' | 'rationale'>): string[] {
  const rationale: string[] = []
  if (snapshot.rsi != null && snapshot.rsi < 30) rationale.push(`RSI ${snapshot.rsi.toFixed(0)} indica queda forte; evitar em estratégia de momentum.`)
  if (snapshot.rsi != null && snapshot.rsi > 70) rationale.push(`RSI ${snapshot.rsi.toFixed(0)} indica forte momentum de alta (leitura clássica: sobrecomprado; score legado, use com cautela).`)
  if (snapshot.historyChange > 8) rationale.push(`Alta de ${snapshot.historyChange.toFixed(1)}% em 30 dias (curto prazo tende a reverter; veja o score multifator).`)
  if (snapshot.historyChange < -8) rationale.push(`Queda de 30 dias em ${snapshot.historyChange.toFixed(1)}%; evitar faca caindo sem catalisador.`)
  if (snapshot.newsImpact.label !== 'neutral') rationale.push(`Sinais externos com leitura ${snapshot.newsImpact.label}.`)
  if (snapshot.signals.length > 0) rationale.push(`${snapshot.signals.length} sinal(is) externo(s) para checar impacto.`)
  if (rationale.length === 0) rationale.push('Sem forte indicativo de momentum; manter em observação.')
  return rationale
}

function estimateNewsImpact(signals: MarketSignal[]): AssetSnapshot['newsImpact'] {
  if (signals.length === 0) {
    return { label: 'neutral', score: 0, summary: 'Sem sinais externos configurados ou encontrados.' }
  }

  const bullishTerms = ['alta', 'lucro', 'cresce', 'recorde', 'upgrade', 'compra', 'aprovado', 'expansao', 'bull', 'surge', 'etf', 'inflow']
  const bearishTerms = ['queda', 'prejuizo', 'corte', 'downgrade', 'venda', 'investiga', 'risco', 'multa', 'fraude', 'bear', 'outflow', 'hack']
  let rawScore = 0

  for (const signal of signals) {
    const title = signal.title.toLowerCase()
    for (const term of bullishTerms) if (title.includes(term)) rawScore += 1
    for (const term of bearishTerms) if (title.includes(term)) rawScore -= 1
  }

  const score = Math.max(-10, Math.min(10, rawScore * 2))
  const label: ImpactLabel = score > 1 ? 'bullish' : score < -1 ? 'bearish' : 'neutral'
  const summary = label === 'neutral'
    ? `${signals.length} sinal(is), sem viés textual forte.`
    : `${signals.length} sinal(is), viés ${label} por termos de manchete.`

  return { label, score, summary }
}

function stripXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? stripXml(match[1] || '') : undefined
}

function classifyTextImpact(text: string): ImpactLabel {
  const lower = text.toLowerCase()
  const bullishTerms = ['alta', 'lucro', 'cresce', 'recorde', 'upgrade', 'compra', 'aprovado', 'expansao', 'bull', 'surge', 'etf', 'inflow', 'adoption', 'growth']
  const bearishTerms = ['queda', 'prejuizo', 'corte', 'downgrade', 'venda', 'investiga', 'risco', 'multa', 'fraude', 'bear', 'outflow', 'hack', 'loss', 'recession']
  let score = 0
  for (const term of bullishTerms) if (lower.includes(term)) score++
  for (const term of bearishTerms) if (lower.includes(term)) score--
  if (score > 0) return 'bullish'
  if (score < 0) return 'bearish'
  return 'neutral'
}

function parseResearchFeed(text: string, source: string, kind: ResearchItem['kind']): ResearchItem[] {
  const blocks = [
    ...text.matchAll(/<entry[\s\S]*?<\/entry>/gi),
    ...text.matchAll(/<item[\s\S]*?<\/item>/gi),
  ].map(match => match[0])

  return blocks.slice(0, 8).map(block => {
    const title = getTag(block, 'title') || ''
    const summary = getTag(block, 'summary') || getTag(block, 'description')
    const url = getTag(block, 'id') || getTag(block, 'link') || block.match(/<link[^>]+href="([^"]+)"/i)?.[1]
    const publishedAt = getTag(block, 'published') || getTag(block, 'updated') || getTag(block, 'pubDate')

    return {
      kind,
      source,
      title: title.slice(0, 180),
      url,
      publishedAt,
      summary: summary?.slice(0, 500),
      impact: classifyTextImpact(`${title} ${summary || ''}`),
    }
  }).filter(item => item.title.length > 0)
}

function buildDefaultPaperFeed(asset: MarketAsset): string {
  const assetTerm = 'financial markets OR portfolio management OR trading'
  const query = encodeURIComponent(`all:(${assetTerm}) OR cat:q-fin.PM OR cat:q-fin.TR`)
  return `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending`
}

async function fetchResearchFeed(url: string, source: string, kind: ResearchItem['kind']): Promise<ResearchItem[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`${source} status ${res.status}`)
  return parseResearchFeed(await res.text(), source, kind)
}

async function buildResearchBrief(asset: MarketAsset): Promise<ResearchBrief> {
  const items: ResearchItem[] = []
  const fastNewsUrl = process.env.FAST_NEWS_URL?.replace(/\/$/, '')

  if (fastNewsUrl) {
    try {
      const url = `${fastNewsUrl}/api/rag/search?q=${encodeURIComponent(`${asset.ticker} ${asset.name}`)}`
      const fastNewsSignals = await fetchJsonSignals(url, 'fast-news')
      items.push(...fastNewsSignals.map(signal => ({
        ...signal,
        kind: 'fast-news' as const,
        impact: classifyTextImpact(signal.title),
      })))
    } catch (error: any) {
      log('warn', 'fast-news research fetch failed', { ticker: asset.ticker, error: error.message })
    }
  }

  const marketFeeds = String(process.env.MARKET_NEWS_FEEDS || '').split(',').map(url => url.trim()).filter(Boolean)
  const paperFeeds = String(process.env.PAPER_FEEDS || buildDefaultPaperFeed(asset)).split(',').map(url => url.trim()).filter(Boolean)

  for (const url of marketFeeds.slice(0, 3)) {
    try {
      items.push(...await fetchResearchFeed(url, 'news-feed', 'news'))
    } catch (error: any) {
      log('warn', 'market research feed failed', { ticker: asset.ticker, url, error: error.message })
    }
  }

  for (const url of paperFeeds.slice(0, 3)) {
    try {
      items.push(...await fetchResearchFeed(url, url.includes('arxiv') ? 'arxiv' : 'paper-feed', 'paper'))
    } catch (error: any) {
      log('warn', 'paper research feed failed', { ticker: asset.ticker, url, error: error.message })
    }
  }

  const impact = estimateNewsImpact(items)
  return {
    asset: asset.ticker,
    generatedAt: new Date().toISOString(),
    impact,
    items: items.slice(0, 12),
    nextQuestions: [
      `Qual item muda a tese de ${asset.ticker} nas proximas 24h?`,
      'O sinal externo confirma preço/volume ou contradiz o movimento?',
      'Qual seria o stop de tese se a noticia estiver errada ou ja precificada?',
    ],
  }
}

async function fetchJsonSignals(url: string, source: string): Promise<MarketSignal[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${source} status ${res.status}`)
  const json = await res.json() as any
  const items = Array.isArray(json) ? json : json.results || json.articles || json.data || []

  return items.slice(0, 5).map((item: any) => ({
    source,
    title: String(item.title || item.headline || item.name || item.summary || '').slice(0, 180),
    url: item.url || item.link,
  })).filter((item: MarketSignal) => item.title.length > 0)
}

async function fetchTextFeedSignals(url: string, source: string, query: string): Promise<MarketSignal[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${source} status ${res.status}`)
  const text = await res.text()
  const matches = [...text.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/gi)]
  return matches
    .map(match => (match[1] || match[2] || '').replace(/<[^>]+>/g, '').trim())
    .filter(title => title && title.toLowerCase().includes(query.toLowerCase().split('.')[0]!))
    .slice(0, 5)
    .map(title => ({ source, title }))
}

async function fetchMarketSignals(asset: MarketAsset): Promise<MarketSignal[]> {
  const cacheKey = `signals:${asset.ticker}`
  const cached = signalCache.get<MarketSignal[]>(cacheKey)
  if (cached) return cached

  const signals: MarketSignal[] = []
  const fastNewsUrl = process.env.FAST_NEWS_URL?.replace(/\/$/, '')
  const query = `${asset.ticker} ${asset.name}`

  if (fastNewsUrl) {
    try {
      const url = `${fastNewsUrl}/api/rag/search?q=${encodeURIComponent(query)}`
      signals.push(...await fetchJsonSignals(url, 'fast-news'))
    } catch (error: any) {
      log('warn', 'fast-news signal fetch failed', { ticker: asset.ticker, error: error.message })
    }
  }

  const feedUrls = [
    ...String(process.env.MARKET_NEWS_FEEDS || '').split(','),
    ...String(process.env.PAPER_FEEDS || '').split(','),
  ].map(url => url.trim()).filter(Boolean)

  for (const url of feedUrls.slice(0, 4)) {
    try {
      signals.push(...await fetchTextFeedSignals(url, url.includes('arxiv') ? 'paper-feed' : 'news-feed', query))
    } catch (error: any) {
      log('warn', 'external signal fetch failed', { ticker: asset.ticker, url, error: error.message })
    }
  }

  const unique = signals.filter((signal, index, all) =>
    all.findIndex(candidate => candidate.title === signal.title) === index
  ).slice(0, 8)

  signalCache.set(cacheKey, unique)
  return unique
}
