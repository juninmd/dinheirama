import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { z } from 'zod'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { Ollama } from 'ollama'
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

const app = new Hono()

const tickerSchema = z.string().regex(/^[A-Z0-9]{4,6}\.[A-Z]{2}$/, 'Invalid B3 ticker format (ex: PETR4.SA)')

interface CacheEntry<T> {
  data: T
  timestamp: number
}

class CacheManager {
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly ttl: number

  constructor(ttlMinutes = 5) {
    this.ttl = ttlMinutes * 60 * 1000
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }
    return entry.data as T
  }

  set<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  has(key: string): boolean {
    return this.get<unknown>(key) !== null
  }

  invalidate(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }
}

const quoteCache = new CacheManager(5)
const chartCache = new CacheManager(10)
const signalCache = new CacheManager(30)

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

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' })

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
app.use('/*', serveStatic({ root: './public' }))
app.get('*', serveStatic({ path: './public/index.html' }))

app.get('/', (c) => {
  return c.text('B3 Stock Analyzer API')
})

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache: {
      quoteCacheSize: quoteCache['cache']?.size ?? 0,
      chartCacheSize: chartCache['cache']?.size ?? 0
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

  const cacheKey = `quote:${ticker}`
  const cached = quoteCache.get<unknown>(cacheKey)
  if (cached) {
    log('info', `Cache hit for ${ticker}`)
    return c.json({ ...cached as object, cached: true })
  }

  try {
    const quote = await fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500) as Record<string, any>

    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)
    }

    quoteCache.set(cacheKey, quote)
    return c.json(quote)
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

  const cacheKey = `history:${ticker}`
  const cached = chartCache.get<unknown>(cacheKey)
  if (cached) {
    return c.json({ ...cached as object, cached: true })
  }

  try {
    const result = await fetchWithRetry(
      () => yahooFinance.historical(ticker, { period1: '2023-01-01' }),
      2,
      500
    )
    chartCache.set(cacheKey, result)
    return c.json(result)
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

    const prompt = `
Você é um assistente 24h de ações da B3. Objetivo: maximizar o lucro de forma muito agressiva e focar exclusivamente em estratégias de altíssimo rendimento.
Objetivo principal: montar um portfólio para ganhar muito dinheiro com estratégias ultra agressivas de altíssimo rendimento.
Ativo: ${snapshot.ticker} (${snapshot.assetClass})
Preço: ${snapshot.price} | variação diária: ${snapshot.change?.toFixed(2) || 'N/A'}%
30D: ${snapshot.historyChange.toFixed(2)}% | RSI: ${snapshot.rsi?.toFixed(2) || 'N/A'}
Score proprietário: ${snapshot.score}/100 | ação sugerida: ${snapshot.action} | risco: ${snapshot.risk}
Impacto de notícias/papers: ${snapshot.newsImpact.label} (${snapshot.newsImpact.score}) - ${snapshot.newsImpact.summary}
Sinais externos:
${snapshot.signals.length ? snapshot.signals.map(signal => `- ${signal.source}: ${signal.title}`).join('\n') : '- Nenhum sinal externo encontrado'}

Responda em Markdown curto com:
1. Decisão: comprar, manter ou vender.
2. Tese em 3 bullets.
3. Riscos e gatilhos de invalidação.
4. O que monitorar nas próximas 24h.
`.trim()

    let aiResponse = ''
    let aiSource = 'ollama'

    try {
      const ollamaResponse = await fetchWithTimeout(
        ollama.generate({ model: 'llama3', prompt, stream: false }),
        300000
      )
      aiResponse = ollamaResponse.response
    } catch (ollamaError: any) {
      log('warn', 'Ollama unavailable, using fallback', { error: ollamaError.message })
      aiSource = 'fallback'
      aiResponse = [
        `**Decisão:** ${snapshot.action.toUpperCase()} (${snapshot.score}/100, risco ${snapshot.risk}).`,
        '',
        `**Tese:** ${snapshot.rationale.join(' ')}`,
        '',
        `**Impacto externo:** ${snapshot.newsImpact.summary}.`,
        '',
        `**Gatilho de invalidação:** queda forte com volume acima da média, notícia adversa ou perda do suporte recente.`,
        '',
        `**Próximas 24h:** monitorar preço, volume, RSI e novos sinais em fast-news/papers.`,
        '',
        '*Análise automática. Não é recomendação formal de investimento.*',
      ].join('\n')
    }

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
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    log('error', 'Analysis failed', { error: error.message })
    return c.json({ error: error.message, code: 'ANALYSIS_ERROR' }, 500)
  }
})

const MARKET_UNIVERSE: MarketAsset[] = [
  { ticker: 'PETR4.SA', name: 'Petrobras PN', assetClass: 'stock', thesis: 'energia, petroleo e dividendos' },
  { ticker: 'VALE3.SA', name: 'Vale ON', assetClass: 'stock', thesis: 'minerio, China e commodities' },
  { ticker: 'ITUB4.SA', name: 'Itau Unibanco PN', assetClass: 'stock', thesis: 'banco, credito e juros' },
  { ticker: 'WEGE3.SA', name: 'WEG ON', assetClass: 'stock', thesis: 'industria, energia e crescimento global' },
  { ticker: 'BBAS3.SA', name: 'Banco do Brasil ON', assetClass: 'stock', thesis: 'banco publico, dividendos e agro' },
  { ticker: 'BBDC4.SA', name: 'Bradesco PN', assetClass: 'stock', thesis: 'banco, turnaround e credito' },
  { ticker: 'RENT3.SA', name: 'Localiza ON', assetClass: 'stock', thesis: 'locacao, juros e mobilidade' },
  { ticker: 'PRIO3.SA', name: 'Prio ON', assetClass: 'stock', thesis: 'petroleo, producao e crescimento' },
  { ticker: 'MGLU3.SA', name: 'Magazine Luiza ON', assetClass: 'stock', thesis: 'varejo, ecommerce e juros' },
  { ticker: 'B3SA3.SA', name: 'B3 ON', assetClass: 'stock', thesis: 'bolsa, volume financeiro e mercado de capitais' },
  { ticker: 'GGBR4.SA', name: 'Gerdau PN', assetClass: 'stock', thesis: 'aco, ciclo industrial e commodities' },
  { ticker: 'JBSS3.SA', name: 'JBS ON', assetClass: 'stock', thesis: 'proteina global, cambio e margens' },
  { ticker: 'TOTS3.SA', name: 'TOTVS ON', assetClass: 'stock', thesis: 'software, recorrencia e margens' },
  { ticker: 'RADL3.SA', name: 'Raia Drogasil ON', assetClass: 'stock', thesis: 'saude, varejo defensivo e expansao' },
  { ticker: 'VIVT3.SA', name: 'Telefonica Brasil ON', assetClass: 'stock', thesis: 'telecom, dividendos e defensivo' },
  { ticker: 'TAEE11.SA', name: 'Taesa Unit', assetClass: 'stock', thesis: 'transmissao, dividendos e inflacao' },
  { ticker: 'SUZB3.SA', name: 'Suzano ON', assetClass: 'stock', thesis: 'papel, celulose e dolar' },
  { ticker: 'EQTL3.SA', name: 'Equatorial ON', assetClass: 'stock', thesis: 'energia, crescimento e turnaround' },
  { ticker: 'CSNA3.SA', name: 'CSN ON', assetClass: 'stock', thesis: 'siderurgia, minerio e commodities' },
  { ticker: 'LREN3.SA', name: 'Lojas Renner ON', assetClass: 'stock', thesis: 'varejo de moda e consumo' },
  { ticker: 'BBSE3.SA', name: 'BB Seguridade ON', assetClass: 'stock', thesis: 'seguros, agro e dividendos' },
  { ticker: 'CMIG4.SA', name: 'Cemig PN', assetClass: 'stock', thesis: 'energia, estatal e dividendos' },
  { ticker: 'CPLE6.SA', name: 'Copel PNB', assetClass: 'stock', thesis: 'energia, privatizacao e turnaround' },
  { ticker: 'CYRE3.SA', name: 'Cyrela ON', assetClass: 'stock', thesis: 'construcao civil e juros' },
  { ticker: 'ELET3.SA', name: 'Eletrobras ON', assetClass: 'stock', thesis: 'energia, privatizacao e eficiencia' },
  { ticker: 'SBSP3.SA', name: 'Sabesp ON', assetClass: 'stock', thesis: 'saneamento, privatizacao e dividendos' },
  { ticker: 'ASAI3.SA', name: 'Assai ON', assetClass: 'stock', thesis: 'varejo alimentar e expansao' },
  { ticker: 'NTCO3.SA', name: 'Natura ON', assetClass: 'stock', thesis: 'cosmeticos, reestruturacao e consumo' },
  { ticker: 'HAPV3.SA', name: 'Hapvida ON', assetClass: 'stock', thesis: 'saude, sinergias e crescimento' },
]

const CONCURRENCY_LIMIT = 5

export async function buildAssetSnapshot(asset: MarketAsset): Promise<AssetSnapshot | null> {
  try {
    const quote = await fetchWithTimeout(
      fetchWithRetry(() => yahooFinance.quote(asset.ticker), 2, 500),
      10000
    ) as any

    if (!quote || quote.regularMarketPrice === undefined) {
      return null
    }

    const date = new Date()
    date.setDate(date.getDate() - 30)
    const period1Str = date.toISOString().split('T')[0]!

    let historyChange = 0
    let rsi: number | null = null

    try {
      const chart = await fetchWithTimeout(
        fetchWithRetry(() => yahooFinance.chart(asset.ticker, { period1: period1Str }), 1, 500),
        10000
      )
      const history = chart?.quotes ? (chart.quotes as any[]) : []

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

    return {
      ...partialSnapshot,
      score,
      action: getAction(score),
      risk: classifyRisk(asset.assetClass, rsi, historyChange),
      rationale: buildRationale(partialSnapshot),
    }
  } catch (error: any) {
    log('warn', `Snapshot failed for ${asset.ticker}`, { error: error.message })
    return null
  }
}

async function chunkedPromiseAll<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = CONCURRENCY_LIMIT
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency)
    const chunkResults = await Promise.all(chunk.map(fn))
    results.push(...chunkResults)
  }
  return results
}

export async function buildPortfolio() {
  log('info', 'Portfolio generation started')

  {
    const quoteResults = await chunkedPromiseAll(MARKET_UNIVERSE, buildAssetSnapshot, CONCURRENCY_LIMIT)

    const quotes = quoteResults.filter((q): q is AssetSnapshot => q !== null)

    log('info', `Portfolio: ${quotes.length}/${MARKET_UNIVERSE.length} assets loaded`)

    if (quotes.length === 0) {
      throw new Error('No data available')
    }

    const quotesSummary = quotes.map(q =>
      `- ${q.ticker} (${q.assetClass}): ${q.price?.toFixed(2) || 'N/A'} | Diário ${q.change?.toFixed(2) || 'N/A'}% | 30D ${q.historyChange?.toFixed(2) || 'N/A'}% | RSI ${q.rsi?.toFixed(2) || 'N/A'} | score ${q.score} | ação ${q.action} | risco ${q.risk} | impacto ${q.newsImpact.label}/${q.newsImpact.score} | sinais ${q.signals.length}`
    ).join('\n')

    const prompt = `
Você é um assistente 24h de ações da B3. Objetivo: maximizar o lucro de forma muito agressiva e focar exclusivamente em estratégias de altíssimo rendimento.
Objetivo principal: montar um portfólio para ganhar muito dinheiro com estratégias ultra agressivas de altíssimo rendimento.

Dados dos ativos disponíveis:
${quotesSummary}

Selecione 3 a 5 oportunidades entre ações com:
- tese clara
- catalisador monitorável
- limite de risco
- motivo para comprar, manter ou vender

Monte um radar de alocação. Nunca prometa retorno. Use português e Markdown curto.

Responda em português, formato Markdown.
`.trim()

    let aiResponse = ''
    let aiSource = 'ollama'

    try {
      const ollamaResponse = await fetchWithTimeout(
        ollama.generate({ model: 'llama3', prompt, stream: false }),
        300000
      )
      aiResponse = ollamaResponse.response
    } catch (ollamaError: any) {
      log('warn', 'Ollama unavailable for portfolio', { error: ollamaError.message })
      aiSource = 'fallback'

      const ranked = [...quotes].sort((a, b) => b.score - a.score)
      aiResponse = `**Radar automático ações da B3**\n\n`
      ranked.slice(0, 5).forEach((q, i) => {
        aiResponse += `${i + 1}. **${q.ticker}** (${q.assetClass}) - ${q.action.toUpperCase()} | score ${q.score}/100 | risco ${q.risk} | impacto ${q.newsImpact.label}/${q.newsImpact.score} | 30D ${q.historyChange.toFixed(1)}% | RSI ${q.rsi?.toFixed(0) || 'N/A'}.\n`
      })
      aiResponse += `\n**Gestão:** buscar retornos altíssimos e lucro de forma muito agressiva, priorizando ganhos exponenciais e oportunidades de alto impacto.\n\n*Análise automática. Não é recomendação formal de investimento.*`
    }

    log('info', 'Portfolio generation complete', { quotesCount: quotes.length, aiSource })

    return {
      portfolio: quotes,
      recommendation: aiResponse,
      aiSource,
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

    const quote = await fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500) as any
    if (!quote?.regularMarketPrice) return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)

    const chart = await yahooFinance.chart(ticker, { period1: new Date(Date.now() - 60 * 864e5).toISOString().split('T')[0] })
    const history = chart?.quotes || []

    const currentPrice = quote.regularMarketPrice
    const pastPrice = history[0]?.close
    const historyChange30d = pastPrice > 0 ? ((currentPrice - pastPrice) / pastPrice) * 100 : 0
    const avgVolume = history.length > 0 ? history.reduce((s: number, d: any) => s + (d.volume || 0), 0) / history.length : 1
    const sma50 = history.length >= 50 ? history.slice(-50).reduce((s: number, d: any) => s + d.close, 0) / 50 : null

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

app.post('/api/training/collect', async (c) => {
  try {
    const cmd = process.env.TRAINING_COLLECT_CMD || 'bun run ./training/collector.ts'
    const proc = Bun.spawnSync(cmd.split(' '), { cwd: import.meta.dir })
    const stdout = proc.stdout?.toString() || ''
    const stderr = proc.stderr?.toString() || ''
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
    const proc = Bun.spawnSync(cmd.split(' '), { cwd: import.meta.dir })
    const stdout = proc.stdout?.toString() || ''
    const stderr = proc.stderr?.toString() || ''
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
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
  const notifyUtcHour = Number(process.env.NOTIFY_UTC_HOUR ?? 11)

  return {
    generatedAt: new Date().toISOString(),
    integrations: {
      ollama: {
        configured: Boolean(ollamaHost),
        host: ollamaHost.replace(/\/\/.*@/, '//redacted@'),
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
  if (snapshot.rsi != null && snapshot.rsi > 70) rationale.push(`RSI ${snapshot.rsi.toFixed(0)} indica forte momentum de alta; oportunidade agressiva.`)
  if (snapshot.historyChange > 8) rationale.push(`Força de 30 dias em ${snapshot.historyChange.toFixed(1)}%. Alta rentabilidade.`)
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
  const res = await fetchWithTimeout(fetch(url), 8000)
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
  const res = await fetchWithTimeout(fetch(url), 5000)
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
  const res = await fetchWithTimeout(fetch(url), 5000)
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
