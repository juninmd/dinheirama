import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { cors } from 'hono/cors'
import { z } from 'zod'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import { Ollama } from 'ollama'

const app = new Hono()

const tickerSchema = z.string().regex(/^[A-Z0-9]{4,6}\.[A-Z]{2}$/, 'Invalid B3 ticker format (ex: PETR4.SA)')

interface CacheEntry<T> {
  data: T
  timestamp: number
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
    const quote = await fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500) as {
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
    const ticker = body.ticker?.trim()?.toUpperCase()

    if (!ticker) {
      return c.json({ error: 'Ticker is required', code: 'MISSING_TICKER' }, 400)
    }

    const validation = tickerSchema.safeParse(ticker)
    if (!validation.success) {
      return c.json({
        error: 'Invalid ticker format. Use format: PETR4.SA, VALE3.SA, etc.',
        code: 'INVALID_TICKER'
      }, 400)
    }

    log('info', `Analyzing ticker: ${ticker}`)

    const quotePromise = fetchWithRetry(() => yahooFinance.quote(ticker), 2, 500)
    const quote = await fetchWithTimeout(quotePromise, 10000) as any

    if (!quote || quote.regularMarketPrice === undefined) {
      return c.json({ error: 'Ticker not found on B3', code: 'NOT_FOUND' }, 404)
    }

    const date = new Date()
    date.setDate(date.getDate() - 30)
    const period1Str = date.toISOString().split('T')[0]!

    const chartPromise = yahooFinance.chart(ticker, { period1: period1Str })
    const chart = await fetchWithTimeout(chartPromise, 15000)
    const history = chart.quotes as any[]
    const rsi = calculateRSI(history)

    const prompt = `
Você é um analista financeiro especialista no mercado brasileiro (B3) e focado EXCLUSIVAMENTE em MAXIMIZAR LUCROS ABSURDOS.
Ação: ${ticker}
Preço Atual: R$ ${quote.regularMarketPrice} ${quote.currency}
Variação: ${quote.regularMarketChangePercent?.toFixed(2) || 'N/A'}%
RSI (14 dias): ${rsi !== null ? rsi.toFixed(2) : 'N/A'}
Volume: ${quote.regularMarketVolume?.toLocaleString() || 'N/A'}

Resumo do histórico de 30 dias:
${history.length > 0 ? history.slice(-14).map((h: any) => `Data: ${h.date.toISOString().split('T')[0]}, Fechamento: R$ ${h.close?.toFixed(2)}`).join('\n') : 'Dados insuficientes'}

Forneça uma análise BRUTAL E AGRESSIVA focada em rentabilidade extrema.
- Se RSI < 30: exalte a oportunidade de repique violento (sobrevenda extrema)
- Se RSI > 70: recomende surfar a euforia (sobrecompra, momentum)
- Se 30 <= RSI <= 70: destaque consolidação e próximos catalisadores

Responda em português, em formato Markdown limpo.
`.trim()

    let aiResponse = ''
    let aiSource = 'ollama'

    try {
      const ollamaResponse = await fetchWithTimeout(
        ollama.generate({ model: 'llama3', prompt, stream: false }),
        20000
      )
      aiResponse = ollamaResponse.response
    } catch (ollamaError: any) {
      log('warn', 'Ollama unavailable, using fallback', { error: ollamaError.message })
      aiSource = 'fallback'

      if (rsi !== null && rsi < 30) {
        aiResponse = `**ANÁLISE EXTREMA (Oportunidade de Alto Ganho)**\n\nA ação **${ticker}** está em **SOBREVENDA EXTREMA** (RSI ${rsi.toFixed(2)}).\n\n**COMPRE AGORA!** A reprecificação será violenta. Sangue nas ruas é o momento de ficar rico. Alavanque na recuperação rápida.\n\n*⚠️ Análise automática baseada em RSI (sem IA]*`
      } else if (rsi !== null && rsi > 70) {
        aiResponse = `**ANÁLISE DE MOMENTUM (Força Irresistível)**\n\nA ação **${ticker}** mostra RSI de ${rsi.toFixed(2)} - sobrecompra extrema mas **o foguete ainda tem combustível!**\n\n**FOGUETE NÃO TEM RÉ!** Momentum absurdo. Entre rasgando para surfar a alta dos grandes players.\n\n*⚠️ Análise automática baseada em RSI (sem IA]*`
      } else if (quote.regularMarketChangePercent > 0) {
        aiResponse = `**ANÁLISE BULL (Viés Positivo)**\n\n**${ticker}** em alta de +${quote.regularMarketChangePercent.toFixed(2)}% hoje. RSI em ${rsi?.toFixed(2) || 'N/A'} indica espaço para continuidade.\n\n**COMPRE O MOMENTUM!** O mercado recompensa os corajosos.\n\n*⚠️ Análise automática baseada em RSI (sem IA]*`
      } else {
        aiResponse = `**ANÁLISE CONSOLIDAÇÃO (Aguarde Oportunidade)**\n\n**${ticker}** em leve retração de ${quote.regularMarketChangePercent?.toFixed(2) || 0}% (RSI ${rsi?.toFixed(2) || 'N/A'}).\n\nAguarde confirmação de entrada. O mercado é um mercado de probabilidades.\n\n*⚠️ Análise automática baseada em RSI (sem IA]*`
      }
    }

    log('info', `Analysis complete for ${ticker}`, { rsi, aiSource })

    return c.json({
      ticker,
      quote: {
        price: quote.regularMarketPrice,
        change: quote.regularMarketChangePercent,
        volume: quote.regularMarketVolume,
        currency: quote.currency
      },
      rsi,
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

app.get('/api/portfolio', async (c) => {
  try {
    log('info', 'Portfolio generation started')

    const date = new Date()
    date.setDate(date.getDate() - 30)
    const period1Str = date.toISOString().split('T')[0]

    const quoteResults = await chunkedPromiseAll(B3_TICKERS, async (ticker) => {
      try {
        const quote = await fetchWithTimeout(
          fetchWithRetry(() => yahooFinance.quote(ticker), 1, 500),
          8000
        ) as any

        if (!quote || quote.regularMarketPrice === undefined) {
          return null
        }

        let historyChange = 0
        let rsi = null

        try {
          const chart = await fetchWithTimeout(
            fetchWithRetry(() => yahooFinance.chart(ticker, { period1: period1Str! }), 1, 500),
            10000
          )
          const history = chart.quotes as any[]

          if (history && history.length > 0) {
            const pastPrice = history[0]?.close
            const currentPrice = quote.regularMarketPrice

            if (pastPrice != null && currentPrice != null && pastPrice > 0) {
              historyChange = ((currentPrice - pastPrice) / pastPrice) * 100
            }
            rsi = calculateRSI(history)
          }
        } catch (e) {
          log('warn', `History fetch failed for ${ticker}`)
        }

        return {
          ticker,
          price: quote.regularMarketPrice,
          change: quote.regularMarketChangePercent,
          volume: quote.regularMarketVolume,
          historyChange,
          rsi,
          valid: true
        }
      } catch (e) {
        log('warn', `Quote fetch failed for ${ticker}`)
        return null
      }
    }, CONCURRENCY_LIMIT)

    const quotes = quoteResults.filter((q): q is NonNullable<typeof q> => q !== null && q.valid)

    log('info', `Portfolio: ${quotes.length}/${B3_TICKERS.length} tickers loaded`)

    if (quotes.length === 0) {
      return c.json({ error: 'No data available', code: 'NO_DATA' }, 500)
    }

    const quotesSummary = quotes.map(q =>
      `- ${q.ticker}: R$ ${q.price?.toFixed(2) || 'N/A'} | Diário ${q.change?.toFixed(2) || 'N/A'}% | 30D ${q.historyChange?.toFixed(2) || 'N/A'}% | RSI ${q.rsi?.toFixed(2) || 'N/A'}`
    ).join('\n')

    const prompt = `
Você é um analista financeiro especialista no mercado brasileiro (B3) e um gestor de carteiras EXTREMAMENTE AGRESSIVO. O objetivo é MAXIMIZAR OS LUCROS.

Dados das ações disponíveis:
${quotesSummary}

Selecione as 3 a 5 ações com maior potencial de ganho baseado em:
- RSI < 30: oportunidade de repique violento (sobrevenda extrema)
- RSI > 70: momentum explosivo (sobrecompra com força)
- historyChange: desempenho recente

Monte um portfólio agressivo com pesos que concentrem capital nas melhores oportunidades.

Responda em português, formato Markdown.
`.trim()

    let aiResponse = ''
    let aiSource = 'ollama'

    try {
      const ollamaResponse = await fetchWithTimeout(
        ollama.generate({ model: 'llama3', prompt, stream: false }),
        30000
      )
      aiResponse = ollamaResponse.response
    } catch (ollamaError: any) {
      log('warn', 'Ollama unavailable for portfolio', { error: ollamaError.message })
      aiSource = 'fallback'

      const sortedByRSI = [...quotes].filter(q => q.rsi !== null && q.rsi < 35)
        .sort((a, b) => (a.rsi ?? 100) - (b.rsi ?? 100))

      const sortedByMomentum = [...quotes].sort((a, b) =>
        (b.historyChange || 0) - (a.historyChange || 0)
      )

      aiResponse = `**PORTFÓLIO ULTRA-AGRESSIVO B3 (Análise Automática)**\n\n`

      if (sortedByRSI.length > 0) {
        aiResponse += `**🎯 OPORTUNIDADES DE REPIQUE:**\n`
        sortedByRSI.slice(0, 3).forEach((q, i) => {
          aiResponse += `${i + 1}. **${q.ticker}** - RSI ${q.rsi?.toFixed(2)}, -30D ${q.historyChange?.toFixed(2) || 0}% - SANGUE NAS RUAS, COMPRE AGORA!\n`
        })
        aiResponse += `\n`
      }

      if (sortedByMomentum.length > 0) {
        aiResponse += `**🚀 MOMENTUM DE ALTA:**\n`
        sortedByMomentum.slice(0, 3).forEach((q, i) => {
          aiResponse += `${i + 1}. **${q.ticker}** - +${q.historyChange?.toFixed(2) || 0}% (30D) - COMPRE O MOMENTUM, SURFE A ALTA!\n`
        })
      }

      aiResponse += `\n*⚠️ Análise automática (sem IA)*`
    }

    log('info', 'Portfolio generation complete', { quotesCount: quotes.length, aiSource })

    return c.json({
      portfolio: quotes,
      recommendation: aiResponse,
      aiSource,
      tickersAnalyzed: quotes.length,
      timestamp: new Date().toISOString()
    })

  } catch (error: any) {
    log('error', 'Portfolio generation failed', { error: error.message })
    return c.json({ error: error.message, code: 'PORTFOLIO_ERROR' }, 500)
  }
})

export default {
  port: 3000,
  fetch: app.fetch,
}