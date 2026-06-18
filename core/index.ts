import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { z } from 'zod'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { Ollama } from 'ollama'

const app = new Hono()

const tickerSchema = z.string().regex(/^(BTC|BTC-USD|[A-Z]{4}\d{1,2}(\.SA)?)$/, 'Invalid ticker format (ex: PETR4, PETR4.SA, BTC)')

interface CacheEntry<T> {
  data: T
  timestamp: number
}

interface AssetProfile {
  input: string
  symbol: string
  kind: 'b3' | 'crypto'
  displayName: string
  irUrl?: string
  researchQueries: string[]
}

interface DecisionModel {
  action: 'comprar' | 'acompanhar' | 'reduzir'
  score: number
  confidence: 'baixa' | 'media' | 'alta'
  fairZone: {
    entry: number
    stop: number
    target: number
  }
  reasons: string[]
  risks: string[]
}

const IR_URLS: Record<string, string> = {
  PETR4: 'https://www.investidorpetrobras.com.br/',
  VALE3: 'https://vale.com/pt/investidores',
  ITUB4: 'https://www.itau.com.br/relacoes-com-investidores',
  BBDC4: 'https://www.bradescori.com.br/',
  BBAS3: 'https://ri.bb.com.br/',
  WEGE3: 'https://ri.weg.net/',
  MGLU3: 'https://ri.magazineluiza.com.br/',
  B3SA3: 'https://ri.b3.com.br/',
  PRIO3: 'https://ri.prio3.com.br/',
  RENT3: 'https://ri.localiza.com/',
}

function normalizeTicker(rawTicker: string): AssetProfile | null {
  const input = rawTicker.trim().toUpperCase()
  const parsed = tickerSchema.safeParse(input)
  if (!parsed.success) return null

  if (input === 'BTC' || input === 'BTC-USD') {
    return {
      input,
      symbol: 'BTC-USD',
      kind: 'crypto',
      displayName: 'Bitcoin',
      researchQueries: [
        'bitcoin market efficiency institutional adoption paper',
        'bitcoin portfolio diversification academic paper',
      ],
    }
  }

  const baseTicker = input.replace('.SA', '')
  return {
    input,
    symbol: `${baseTicker}.SA`,
    kind: 'b3',
    displayName: baseTicker,
    irUrl: IR_URLS[baseTicker] ?? `https://www.google.com/search?q=${encodeURIComponent(`${baseTicker} relações com investidores resultados trimestrais`)}`,
    researchQueries: [
      `${baseTicker} B3 valuation paper`,
      `${baseTicker} equity research Brazil paper`,
      `${baseTicker} resultados trimestrais RI`,
    ],
  }
}

function sourceLinks(profile: AssetProfile) {
  return {
    investorRelations: profile.irUrl ?? null,
    papers: profile.researchQueries.map((query) => ({
      title: query,
      url: `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
    })),
  }
}

class CacheManager {
  private cache = new Map<string, CacheEntry<unknown>>()
  private ttl: number

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

function calculateDecisionModel(
  profile: AssetProfile,
  quote: any,
  history: any[],
  rsi: number | null
): DecisionModel {
  const price = Number(quote.regularMarketPrice)
  const dayChange = Number(quote.regularMarketChangePercent ?? 0)
  const firstClose = Number(history[0]?.close ?? price)
  const lastClose = Number(history.at(-1)?.close ?? price)
  const change30d = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0
  const volatility = calculateVolatility(history)

  let score = 50
  const reasons: string[] = []
  const risks: string[] = []

  if (rsi !== null && rsi < 35) {
    score += 18
    reasons.push(`RSI ${rsi.toFixed(1)} indica sobrevenda e possível assimetria de entrada.`)
  } else if (rsi !== null && rsi > 70) {
    score -= 12
    risks.push(`RSI ${rsi.toFixed(1)} indica sobrecompra; risco de correção aumenta.`)
  } else if (rsi !== null) {
    score += 4
    reasons.push(`RSI ${rsi.toFixed(1)} está em zona neutra, sem estresse técnico extremo.`)
  }

  if (change30d > 8) {
    score += 10
    reasons.push(`Momentum de 30 dias positivo (${change30d.toFixed(1)}%).`)
  } else if (change30d < -12) {
    score -= 8
    risks.push(`Queda de 30 dias relevante (${change30d.toFixed(1)}%); pode haver deterioração fundamental.`)
  }

  if (dayChange > 2) reasons.push(`Fluxo diário comprador (${dayChange.toFixed(1)}%).`)
  if (dayChange < -2) risks.push(`Pressão vendedora no dia (${dayChange.toFixed(1)}%).`)

  if (volatility > 5) {
    score -= profile.kind === 'crypto' ? 4 : 8
    risks.push(`Volatilidade recente alta (${volatility.toFixed(1)}% ao dia).`)
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const action = score >= 68 ? 'comprar' : score <= 38 ? 'reduzir' : 'acompanhar'
  const confidence = history.length >= 20 && rsi !== null ? 'media' : 'baixa'

  return {
    action,
    score,
    confidence,
    fairZone: {
      entry: roundMoney(price * (action === 'comprar' ? 0.98 : 0.94)),
      stop: roundMoney(price * (profile.kind === 'crypto' ? 0.9 : 0.92)),
      target: roundMoney(price * (action === 'reduzir' ? 1.03 : 1.12)),
    },
    reasons: reasons.length ? reasons : ['Dados atuais não mostram vantagem clara; aguarde melhor assimetria.'],
    risks: risks.length ? risks : ['Risco principal: tese depende de preço, liquidez e próximos eventos corporativos.'],
  }
}

function calculateVolatility(history: any[]): number {
  if (history.length < 3) return 0
  const returns = history
    .slice(1)
    .map((quote, index) => {
      const previousClose = Number(history[index]?.close)
      const close = Number(quote.close)
      return previousClose > 0 ? ((close - previousClose) / previousClose) * 100 : 0
    })
    .filter(Number.isFinite)

  if (!returns.length) return 0
  const average = returns.reduce((sum, item) => sum + item, 0) / returns.length
  const variance = returns.reduce((sum, item) => sum + Math.pow(item - average, 2), 0) / returns.length
  return Math.sqrt(variance)
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2))
}

function fallbackAnalysis(profile: AssetProfile, model: DecisionModel, currency: string): string {
  return [
    `**Decisão:** ${model.action.toUpperCase()} | Score ${model.score}/100 | Confiança ${model.confidence}.`,
    '',
    `**Zona operacional:** entrada até ${formatCurrency(model.fairZone.entry, currency)}, stop em ${formatCurrency(model.fairZone.stop, currency)}, alvo inicial em ${formatCurrency(model.fairZone.target, currency)}.`,
    '',
    `**Tese:** ${model.reasons.join(' ')}`,
    '',
    `**Riscos:** ${model.risks.join(' ')}`,
    '',
    profile.kind === 'b3'
      ? `**Próximo passo:** ler o RI (${profile.irUrl}) e checar resultado trimestral antes de executar.`
      : '**Próximo passo:** acompanhar fluxo macro, liquidez global e dominância BTC antes de executar.',
    '',
    '*Uso educacional. Não considera seu patrimônio, prazo, imposto ou tolerância a risco.*',
  ].join('\n')
}

function formatCurrency(value: number | null | undefined, currency = 'BRL'): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const prefix = currency === 'USD' ? 'US$' : 'R$'
  return `${prefix} ${value.toFixed(2)}`
}

function log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const logEntry = { timestamp, level, message, ...data }
  console.log(JSON.stringify(logEntry))
}

const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://ollama.ai.svc.cluster.local' })

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

async function generateAnalysis(prompt: string): Promise<{ text: string; source: string }> {
  const liteLlmBaseUrl = process.env.LITELLM_API_BASE
  const liteLlmApiKey = process.env.LITELLM_API_KEY
  const liteLlmModel = process.env.LITELLM_MODEL || 'gpt-4o-mini'

  if (liteLlmBaseUrl && liteLlmApiKey) {
    try {
      const response = await fetchWithTimeout(fetch(`${liteLlmBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${liteLlmApiKey}`,
        },
        body: JSON.stringify({
          model: liteLlmModel,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: 'Você é um analista financeiro prudente. Não promete retorno. Distingue dado, inferência e risco.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      }), 25000)

      if (!response.ok) throw new Error(`LiteLLM status ${response.status}`)
      const data = await response.json() as any
      const content = data.choices?.[0]?.message?.content
      if (content) return { text: content, source: 'litellm' }
    } catch (error: any) {
      log('warn', 'LiteLLM unavailable, trying Ollama', { error: error.message })
    }
  }

  try {
    const ollamaResponse = await fetchWithTimeout(
      ollama.generate({ model: process.env.OLLAMA_MODEL || 'llama3', prompt, stream: false }),
      20000
    )
    return { text: ollamaResponse.response, source: 'ollama' }
  } catch (error: any) {
    log('warn', 'Ollama unavailable, using local model', { error: error.message })
    return { text: '', source: 'local-model-v0' }
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
  throw lastError!
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

app.get('/api/quote/:ticker', async (c) => {
  const profile = normalizeTicker(c.req.param('ticker'))

  if (!profile) {
    return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
  }

  const cacheKey = `quote:${profile.symbol}`
  const cached = quoteCache.get<unknown>(cacheKey)
  if (cached) {
    log('info', `Cache hit for ${profile.symbol}`)
    return c.json({ ...cached as object, cached: true })
  }

  try {
    const quote = await fetchWithRetry(() => yahooFinance.quote(profile.symbol), 2, 500) as {
      regularMarketPrice?: number
      regularMarketChangePercent?: number
      regularMarketVolume?: number
      currency?: string
      [key: string]: any
    }

    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)
    }

    quoteCache.set(cacheKey, quote)
    return c.json(quote)
  } catch (error: any) {
    log('error', `Failed to fetch quote for ${profile.symbol}`, { error: error.message })
    return c.json({ error: 'Failed to fetch quote', code: 'QUOTE_ERROR' }, 500)
  }
})

app.get('/api/history/:ticker', async (c) => {
  const profile = normalizeTicker(c.req.param('ticker'))

  if (!profile) {
    return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
  }

  const cacheKey = `history:${profile.symbol}`
  const cached = chartCache.get<unknown>(cacheKey)
  if (cached) {
    return c.json({ ...cached as object, cached: true })
  }

  try {
    const result = await fetchWithRetry(
      () => yahooFinance.historical(profile.symbol, { period1: '2023-01-01' }),
      2,
      500
    )
    chartCache.set(cacheKey, result)
    return c.json(result)
  } catch (error: any) {
    log('error', `Failed to fetch history for ${profile.symbol}`, { error: error.message })
    return c.json({ error: 'Failed to fetch history', code: 'HISTORY_ERROR' }, 500)
  }
})

app.post('/api/analyze', async (c) => {
  try {
    const body = await c.req.json()
    const profile = normalizeTicker(body.ticker ?? '')

    if (!body.ticker) {
      return c.json({ error: 'Ticker is required', code: 'MISSING_TICKER' }, 400)
    }

    if (!profile) {
      return c.json({
        error: 'Invalid ticker format. Use: PETR4, PETR4.SA, VALE3.SA, BTC.',
        code: 'INVALID_TICKER'
      }, 400)
    }

    log('info', `Analyzing ticker: ${profile.symbol}`)

    const quotePromise = fetchWithRetry(() => yahooFinance.quote(profile.symbol), 2, 500)
    const quote = await fetchWithTimeout(quotePromise, 10000) as any

    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Ticker not found', code: 'NOT_FOUND' }, 404)
    }

    const date = new Date()
    date.setDate(date.getDate() - 30)
    const period1Str = date.toISOString().split('T')[0]!

    const chartPromise = yahooFinance.chart(profile.symbol, { period1: period1Str })
    const chart = await fetchWithTimeout(chartPromise, 15000)
    const history = chart.quotes as any[]
    const rsi = calculateRSI(history)
    const model = calculateDecisionModel(profile, quote, history, rsi)
    const sources = sourceLinks(profile)

    const prompt = `
Ativo: ${profile.symbol} (${profile.kind})
Preço Atual: ${formatCurrency(quote.regularMarketPrice, quote.currency)} ${quote.currency}
Variação: ${quote.regularMarketChangePercent?.toFixed(2) || 'N/A'}%
RSI (14 dias): ${rsi !== null ? rsi.toFixed(2) : 'N/A'}
Volume: ${quote.regularMarketVolume?.toLocaleString() || 'N/A'}
Modelo local: ação=${model.action}, score=${model.score}, confiança=${model.confidence}, entrada=${model.fairZone.entry}, stop=${model.fairZone.stop}, alvo=${model.fairZone.target}
Fontes para checar:
- RI: ${sources.investorRelations ?? 'N/A'}
- Pesquisa: ${sources.papers.map((paper) => paper.url).join(' | ')}

Resumo do histórico de 30 dias:
${history.length > 0 ? history.slice(-14).map((h: any) => `Data: ${h.date.toISOString().split('T')[0]}, Fechamento: ${formatCurrency(h.close, quote.currency)}`).join('\n') : 'Dados insuficientes'}

Responda em português, Markdown curto, com:
1. decisão operacional: comprar, acompanhar ou reduzir;
2. preço bom: entrada, stop e alvo inicial;
3. tese de investimento;
4. riscos que invalidam a tese;
5. próximos documentos a ler.
Não prometa retorno. Não personalize por patrimônio. Se os dados forem fracos, diga que a confiança é baixa.
`.trim()

    const llm = await generateAnalysis(prompt)
    const aiResponse = llm.text || fallbackAnalysis(profile, model, quote.currency)
    const aiSource = llm.text ? llm.source : 'local-model-v0'

    log('info', `Analysis complete for ${profile.symbol}`, { rsi, aiSource, score: model.score })

    return c.json({
      ticker: profile.symbol,
      profile,
      quote: {
        price: quote.regularMarketPrice,
        change: quote.regularMarketChangePercent,
        volume: quote.regularMarketVolume,
        currency: quote.currency
      },
      rsi,
      decision: model,
      sources,
      analysis: aiResponse,
      aiSource,
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    log('error', 'Analysis failed', { error: error.message })
    return c.json({ error: error.message, code: 'ANALYSIS_ERROR' }, 500)
  }
})

const B3_TICKERS = [
  'PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA', 'BBDC4.SA',
  'RENT3.SA', 'PRIO3.SA', 'MGLU3.SA', 'B3SA3.SA', 'GGBR4.SA', 'JBSS3.SA',
  'PETZ3.SA', 'CVCB3.SA', 'BHIA3.SA', 'AMER3.SA', 'COGN3.SA', 'LWSA3.SA',
  'TOTS3.SA', 'GOLL4.SA', 'ALPA4.SA', 'CSNA3.SA', 'RADL3.SA', 'HYPE3.SA',
  'VIVT3.SA', 'TIMS3.SA', 'EQTL3.SA', 'TAEE11.SA', 'TRPL4.SA'
]

const DEFAULT_ASSETS = [...B3_TICKERS, 'BTC-USD']

const CONCURRENCY_LIMIT = 5

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
    const date = new Date()
    date.setDate(date.getDate() - 30)
    const period1Str = date.toISOString().split('T')[0]

    const quoteResults = await chunkedPromiseAll(DEFAULT_ASSETS, async (ticker) => {
      try {
        const profile = normalizeTicker(ticker)
        if (!profile) return null

        const quote = await fetchWithTimeout(
          fetchWithRetry(() => yahooFinance.quote(profile.symbol), 1, 500),
          8000
        ) as any

        if (!quote || quote.regularMarketPrice === undefined) {
          return null
        }

        let historyChange = 0
        let rsi = null
        let history: any[] = []

        try {
          const chart = await fetchWithTimeout(
            fetchWithRetry(() => yahooFinance.chart(profile.symbol, { period1: period1Str! }), 1, 500),
            10000
          )
          history = chart.quotes as any[]

          if (history && history.length > 0) {
            const pastPrice = history[0]?.close
            const currentPrice = quote.regularMarketPrice

            if (pastPrice != null && currentPrice != null && pastPrice > 0) {
              historyChange = ((currentPrice - pastPrice) / pastPrice) * 100
            }
            rsi = calculateRSI(history)
          }
        } catch (e) {
          log('warn', `History fetch failed for ${profile.symbol}`)
        }

        const decision = calculateDecisionModel(profile, quote, history, rsi)

        return {
          ticker: profile.symbol,
          profile,
          price: quote.regularMarketPrice,
          change: quote.regularMarketChangePercent,
          volume: quote.regularMarketVolume,
          currency: quote.currency,
          historyChange,
          rsi,
          decision,
          sources: sourceLinks(profile),
          valid: true
        }
      } catch (e) {
        log('warn', `Quote fetch failed for ${ticker}`)
        return null
      }
    }, CONCURRENCY_LIMIT)

    const quotes = quoteResults.filter((q): q is NonNullable<typeof q> => q !== null && q.valid)

    log('info', `Portfolio: ${quotes.length}/${DEFAULT_ASSETS.length} tickers loaded`)

    if (quotes.length === 0) {
      throw new Error('No data available')
    }

    const quotesSummary = quotes.map(q =>
      `- ${q.ticker}: ${formatCurrency(q.price, q.currency)} | Diário ${q.change?.toFixed(2) || 'N/A'}% | 30D ${q.historyChange?.toFixed(2) || 'N/A'}% | RSI ${q.rsi?.toFixed(2) || 'N/A'} | decisão ${q.decision.action} | score ${q.decision.score}`
    ).join('\n')

    const prompt = `
Você é um analista financeiro prudente para B3 + Bitcoin.

Dados das ações disponíveis:
${quotesSummary}

Selecione 3 a 6 ativos por assimetria risco/retorno. Inclua pesos sugeridos, ativos a evitar/reduzir, preço bom e riscos.
Não prometa retorno. Não personalize por patrimônio. Seja direto.
`.trim()

    const llm = await generateAnalysis(prompt)
    const ranked = [...quotes].sort((a, b) => b.decision.score - a.decision.score)
    const aiResponse = llm.text || [
      '**Carteira sugerida pelo modelo local v0**',
      '',
      ...ranked.slice(0, 5).map((q, index) =>
        `${index + 1}. **${q.ticker}** - ${q.decision.action}, score ${q.decision.score}/100, entrada até ${formatCurrency(q.decision.fairZone.entry, q.currency)}, stop ${formatCurrency(q.decision.fairZone.stop, q.currency)}.`
      ),
      '',
      '**Reduzir/evitar agora:**',
      ...ranked.slice(-3).reverse().map((q) => `- **${q.ticker}** - score ${q.decision.score}/100.`),
      '',
      '*Uso educacional. Requer leitura de RI/pesquisa antes de executar.*',
    ].join('\n')
    const aiSource = llm.text ? llm.source : 'local-model-v0'

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
}

export default {
  port: 3000,
  fetch: app.fetch,
}
