// Acesso a dados de mercado (Yahoo Finance, BCB) por trás de uma interface injetável.
// Os módulos quantitativos recebem `MarketData`, então testes usam dados sintéticos sem rede.

import { type Fundamentals, parseYahooFundamentals } from './fundamentals.ts'
import { type PricePanel, type RawSeries, alignDailyRate, alignPanel } from './panel.ts'

export interface MarketData {
  priceSeries(ticker: string, years: number): Promise<RawSeries | null>
  benchmarkSeries(years: number): Promise<RawSeries | null>
  /** CDI diário (fração) por data ISO; null se indisponível. */
  cdiDaily(years: number): Promise<Map<string, number> | null>
  fundamentals(ticker: string, isFinancial?: boolean): Promise<Fundamentals | null>
}

export const BENCHMARK_TICKER = '^BVSP'

type Loose = Record<string, any>

interface YahooLike {
  chart(symbol: string, options: Record<string, unknown>): Promise<any>
  quoteSummary(symbol: string, options: Record<string, unknown>, moduleOptions?: Record<string, unknown>): Promise<any>
  fundamentalsTimeSeries?(symbol: string, options: Record<string, unknown>, moduleOptions?: Record<string, unknown>): Promise<any>
}

class TtlCache {
  private readonly store = new Map<string, { at: number; value: unknown }>()
  constructor(private readonly ttlMs: number) {}
  get<T>(key: string): T | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key)
      return undefined
    }
    return hit.value as T
  }
  set(key: string, value: unknown): void {
    if (this.store.size >= 500) {
      // varre expirados; se ainda estiver cheio, descarta o mais antigo (chaves livres como /api/valuation/:ticker)
      const now = Date.now()
      for (const [k, v] of this.store) if (now - v.at > this.ttlMs) this.store.delete(k)
      if (this.store.size >= 500) this.store.delete(this.store.keys().next().value as string)
    }
    this.store.set(key, { at: Date.now(), value })
  }
}

export function isoDate(d: Date | string | number): string {
  return new Date(d).toISOString().slice(0, 10)
}

export function yearsAgoIso(years: number, now = new Date()): string {
  return isoDate(new Date(now.getTime() - years * 365.25 * 864e5))
}

/** Converte a resposta de chart() do Yahoo em RawSeries (fechamento ajustado + volume). */
export function parseChartQuotes(ticker: string, quotes: Loose[] | undefined | null): RawSeries | null {
  if (!quotes || quotes.length === 0) return null
  // Se a série tem fechamento ajustado, só ele vale: misturar ajustado com não ajustado cria saltos falsos.
  const hasAdjusted = quotes.some(q => typeof q?.adjclose === 'number')
  const dates: string[] = []
  const closes: Array<number | null> = []
  const volumes: Array<number | null> = []
  for (const q of quotes) {
    const when = q?.date ? new Date(q.date) : null
    if (!when || Number.isNaN(when.getTime())) continue // linha com data inválida não derruba o ticker
    const raw = hasAdjusted ? q.adjclose : q.close
    dates.push(isoDate(when))
    closes.push(typeof raw === 'number' && raw > 0 ? raw : null)
    volumes.push(typeof q.volume === 'number' ? q.volume : null)
  }
  return dates.length > 0 ? { ticker, dates, closes, volumes } : null
}

/** Resposta SGS 12 do BCB: [{data:'dd/MM/yyyy', valor:'0.043739'}] em % ao dia -> fração diária por data ISO. */
export function parseBcbDaily(json: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(json)) return out
  for (const row of json) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(row?.data ?? ''))
    const text = String(row?.valor ?? '').trim()
    if (text === '') continue // valor vazio não vira CDI de 0%
    const value = Number(text.replace(',', '.'))
    if (m && Number.isFinite(value)) out.set(`${m[3]}-${m[2]}-${m[1]}`, value / 100)
  }
  return out
}

function brDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export interface MarketDataOptions {
  fetchFn?: typeof fetch
  priceTtlMs?: number
  fundamentalsTtlMs?: number
  timeoutMs?: number
}

export function createYahooMarketData(yahoo: YahooLike, options: MarketDataOptions = {}): MarketData {
  const fetchFn = options.fetchFn ?? fetch
  const prices = new TtlCache(options.priceTtlMs ?? 3 * 3600_000)
  const funds = new TtlCache(options.fundamentalsTtlMs ?? 12 * 3600_000)
  const timeout = options.timeoutMs ?? 15000

  const withTimeout = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))])

  async function series(ticker: string, years: number): Promise<RawSeries | null> {
    const key = `px:${ticker}:${years}`
    const cached = prices.get<RawSeries | null>(key)
    if (cached !== undefined) return cached
    try {
      const chart = await withTimeout(yahoo.chart(ticker, { period1: yearsAgoIso(years), interval: '1d' }))
      const parsed = parseChartQuotes(ticker, chart?.quotes)
      prices.set(key, parsed)
      return parsed
    } catch {
      return null
    }
  }

  return {
    priceSeries: series,
    benchmarkSeries: years => series(BENCHMARK_TICKER, years),

    async cdiDaily(years) {
      const key = `cdi:${years}`
      const cached = prices.get<Map<string, number> | null>(key)
      if (cached !== undefined) return cached
      try {
        const window = Math.min(years, 9.5)
        const url =
          `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json` +
          `&dataInicial=${brDate(yearsAgoIso(window))}&dataFinal=${brDate(isoDate(new Date()))}`
        const res = await withTimeout(fetchFn(url))
        if (!res.ok) throw new Error(`BCB HTTP ${res.status}`)
        const map = parseBcbDaily(await res.json())
        const result = map.size > 0 ? map : null
        prices.set(key, result)
        return result
      } catch {
        return null
      }
    },

    async fundamentals(ticker, isFinancial) {
      const key = `fd:${ticker}`
      const cached = funds.get<Fundamentals | null>(key)
      if (cached !== undefined) return cached
      try {
        const summary = await withTimeout(
          // validateResult:false evita que um campo novo/ausente do Yahoo derrube a resposta inteira
          yahoo.quoteSummary(ticker, { modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'price'] }, { validateResult: false })
        )
        let timeSeries: Loose[] | null = null
        if (yahoo.fundamentalsTimeSeries) {
          try {
            timeSeries = await withTimeout(
              yahoo.fundamentalsTimeSeries(ticker, { period1: yearsAgoIso(6), type: 'annual', module: 'all' }, { validateResult: false })
            )
          } catch {
            timeSeries = null
          }
        }
        const parsed = parseYahooFundamentals(ticker, summary, timeSeries, { isFinancial })
        funds.set(key, parsed)
        return parsed
      } catch {
        return null
      }
    },
  }
}

export interface LoadedPanel {
  panel: PricePanel
  benchmark: Array<number | null> | undefined
  cdiDaily: number[] | undefined
  cdiSource: 'bcb' | 'constant'
  missing: string[]
}

/** Baixa e alinha preços do universo + benchmark + CDI (fallback: taxa constante). */
export async function loadPanel(
  data: MarketData,
  tickers: string[],
  years: number,
  riskFreeAnnual: number,
  concurrency = 6
): Promise<LoadedPanel | null> {
  const results: Array<RawSeries | null> = []
  for (let i = 0; i < tickers.length; i += concurrency) {
    const chunk = tickers.slice(i, i + concurrency)
    results.push(...(await Promise.all(chunk.map(t => data.priceSeries(t, years)))))
  }
  const loaded = results.filter((r): r is RawSeries => r !== null && r.dates.length > 60)
  const missing = tickers.filter(t => !loaded.some(s => s.ticker === t))
  if (loaded.length < 2) return null

  const [benchRaw, cdiMap] = await Promise.all([data.benchmarkSeries(years), data.cdiDaily(years)])
  const panel = alignPanel(loaded)

  let benchmark: Array<number | null> | undefined
  if (benchRaw) {
    const aligned = alignPanel([benchRaw, ...loaded])
    // reindexa o benchmark nas datas do painel de ativos
    const index = new Map(aligned.dates.map((d, i) => [d, i]))
    const col = aligned.close[benchRaw.ticker] as Array<number | null>
    benchmark = panel.dates.map(d => col[index.get(d) as number] ?? null)
  }

  return {
    panel,
    benchmark,
    cdiDaily: cdiMap ? alignDailyRate(panel.dates, cdiMap, riskFreeAnnual) : undefined,
    cdiSource: cdiMap ? 'bcb' : 'constant',
    missing,
  }
}
