// Provedor alternativo de cotações da B3 (brapi.dev).
//
// O Yahoo continua sendo a fonte primária: o brapi só é chamado quando a cotação do Yahoo
// falha ou volta sem preço. Os nomes de campo foram escolhidos para coincidir com os do
// Yahoo (`regularMarketPrice`, `regularMarketChangePercent`, ...), então o objeto entra no
// mesmo caminho de cache, snapshot e UI sem conversão extra no chamador.
//
// Sem BRAPI_TOKEN a API responde apenas para alguns tickers de demonstração; com o token
// gratuito ela cobre ações e FIIs. Cripto (`BTC-USD`) e índice (`^BVSP`) não existem lá.

export interface BrapiQuote {
  /** Ticker no formato do Yahoo (ex.: `PETR4.SA`), para casar com as chaves de cache. */
  symbol: string
  shortName: string
  longName?: string
  currency: string
  regularMarketPrice: number
  regularMarketChange: number | null
  regularMarketChangePercent: number | null
  regularMarketPreviousClose: number | null
  regularMarketTime: string | null
  source: 'brapi'
}

export interface BrapiQuoteSourceOptions {
  /** Token do brapi.dev. Opcional: sem ele, só tickers de demonstração respondem. */
  token?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
  /** Recebe falhas do provedor; o chamador decide se loga. Nunca lança. */
  onError?: (message: string) => void
}

const QUOTE_URL = 'https://brapi.dev/api/quote'

/** Yahoo usa `PETR4.SA`; o brapi usa `PETR4`. */
export function toBrapiTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.SA$/, '')
}

/** Só ações (4 letras + 1-2 dígitos) e FIIs (4 letras + 11); cripto e índice ficam de fora. */
export function isBrapiTicker(ticker: string): boolean {
  return /^[A-Z]{4}\d{1,2}$/.test(toBrapiTicker(ticker))
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Converte a resposta de `/api/quote/:ticker` no subconjunto do Yahoo usado pelo app. */
export function parseBrapiQuote(ticker: string, payload: unknown): BrapiQuote | null {
  const results = (payload as { results?: unknown } | null)?.results
  const first = Array.isArray(results) ? (results[0] as Record<string, unknown> | undefined) : undefined
  if (!first) return null

  const price = num(first.regularMarketPrice)
  // Preço ausente ou não positivo nunca vira zero: o chamador trata como "sem cotação".
  if (price === null || price <= 0) return null

  const longName = text(first.longName)
  return {
    symbol: ticker.trim().toUpperCase(),
    shortName: text(first.shortName) ?? toBrapiTicker(ticker),
    ...(longName ? { longName } : {}),
    currency: text(first.currency) ?? 'BRL',
    regularMarketPrice: price,
    regularMarketChange: num(first.regularMarketChange),
    regularMarketChangePercent: num(first.regularMarketChangePercent),
    regularMarketPreviousClose: num(first.regularMarketPreviousClose),
    regularMarketTime: text(first.regularMarketTime),
    source: 'brapi',
  }
}

export function createBrapiQuoteSource(options: BrapiQuoteSourceOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? 6000
  const token = options.token?.trim() ?? ''

  const fail = (message: string) => options.onError?.(`[brapi] ${message}`)

  return async function fetchBrapiQuote(ticker: string): Promise<BrapiQuote | null> {
    if (!isBrapiTicker(ticker)) return null

    const symbol = toBrapiTicker(ticker)
    const url = new URL(`${QUOTE_URL}/${encodeURIComponent(symbol)}`)
    if (token) url.searchParams.set('token', token)

    // AbortController em vez de Promise.race: a requisição é de fato cancelada no timeout.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchFn(url.toString(), { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!res.ok) {
        fail(`HTTP ${res.status} para ${symbol}`)
        return null
      }
      return parseBrapiQuote(ticker, await res.json())
    } catch (error: any) {
      fail(`falha ao buscar ${symbol}: ${error?.message ?? String(error)}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
