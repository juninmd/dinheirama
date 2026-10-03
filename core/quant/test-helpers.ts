// Dados sintéticos determinísticos para testes (sem rede).

import { createRandom } from '../monte-carlo.ts'
import type { MarketData } from './data.ts'
import type { Fundamentals } from './fundamentals.ts'
import { type RawSeries } from './panel.ts'

/** Dias úteis (seg-sex) a partir de uma data ISO. */
export function businessDates(start: string, count: number): string[] {
  const out: string[] = []
  const d = new Date(`${start}T12:00:00Z`)
  while (out.length < count) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

export interface SyntheticAsset {
  ticker: string
  drift: number
  vol: number
  /** Sensibilidade ao fator de mercado comum. */
  beta?: number
  seed: number
  /** Primeiro índice com preço (simula IPO tardio). */
  startIndex?: number
}

export function syntheticSeries(
  dates: string[],
  asset: SyntheticAsset,
  market: number[]
): RawSeries {
  const rand = createRandom(asset.seed)
  let price = 20 + (asset.seed % 30)
  const closes: Array<number | null> = []
  const volumes: Array<number | null> = []
  for (let i = 0; i < dates.length; i++) {
    const shock = gaussian(rand)
    price *= Math.exp(asset.drift - 0.5 * asset.vol ** 2 + asset.vol * shock + (asset.beta ?? 0) * (market[i] as number))
    const visible = i >= (asset.startIndex ?? 0)
    closes.push(visible ? price : null)
    volumes.push(visible ? 2_000_000 + Math.floor(rand() * 500_000) : null)
  }
  return { ticker: asset.ticker, dates, closes, volumes }
}

export function syntheticMarket(dates: string[], seed = 7, vol = 0.01): number[] {
  const rand = createRandom(seed)
  return dates.map(() => vol * gaussian(rand))
}

export const DEFAULT_SYNTH_ASSETS: SyntheticAsset[] = [
  { ticker: 'AAAA3.SA', drift: 0.0009, vol: 0.012, beta: 0.8, seed: 11 },
  { ticker: 'BBBB3.SA', drift: 0.0006, vol: 0.015, beta: 1.0, seed: 12 },
  { ticker: 'CCCC3.SA', drift: 0.0003, vol: 0.010, beta: 0.6, seed: 13 },
  { ticker: 'DDDD3.SA', drift: 0.0000, vol: 0.018, beta: 1.2, seed: 14 },
  { ticker: 'EEEE3.SA', drift: -0.0004, vol: 0.022, beta: 1.3, seed: 15 },
  { ticker: 'FFFF3.SA', drift: 0.0005, vol: 0.013, beta: 0.9, seed: 16 },
  { ticker: 'GGGG3.SA', drift: 0.0002, vol: 0.011, beta: 0.7, seed: 17 },
  { ticker: 'HHHH3.SA', drift: 0.0007, vol: 0.016, beta: 1.1, seed: 18 },
]

export function syntheticFundamentals(ticker: string, i: number): Fundamentals {
  const quality = 1 - i * 0.08
  return {
    ticker,
    asOf: '2025-12-31',
    isFinancial: false,
    price: 20 + i,
    marketCap: 10e9 * (1 + i * 0.1),
    enterpriseValue: 12e9 * (1 + i * 0.1),
    trailingPE: 6 + i * 2,
    priceToBook: 0.8 + i * 0.3,
    eps: 3 - i * 0.2,
    bookValuePerShare: 25 - i,
    dividendYield: Math.max(0, 0.07 - i * 0.008),
    payoutRatio: 0.4,
    roe: 0.22 * quality,
    ebit: 2e9 * quality,
    ebitda: 2.6e9 * quality,
    netDebt: 3e9 * (1 + i * 0.2),
    currentRatio: 1.2 + quality,
    debtToEquity: 0.6 + i * 0.1,
    freeCashFlow: 1.2e9 * quality,
    operatingMargin: 0.2 * quality,
    grossMargin: 0.4,
    revenueGrowth: 0.08,
    earningsGrowth: 0.1,
    beta: 0.9 + i * 0.05,
    statements: [
      { endDate: '2025-12-31', revenue: 10e9, grossProfit: 4.2e9, netIncome: 1.5e9 * quality, ebit: 2e9 * quality, totalAssets: 20e9, currentAssets: 6e9, currentLiabilities: 4e9, longTermDebt: 4e9, sharesOutstanding: 500e6, operatingCashFlow: 2.2e9 * quality, capex: 0.9e9, equity: 9e9 },
      { endDate: '2024-12-31', revenue: 9.2e9, grossProfit: 3.7e9, netIncome: 1.2e9 * quality, ebit: 1.7e9 * quality, totalAssets: 19e9, currentAssets: 5.4e9, currentLiabilities: 4.1e9, longTermDebt: 4.5e9, sharesOutstanding: 500e6, operatingCashFlow: 1.9e9 * quality, capex: 0.8e9, equity: 8.4e9 },
      { endDate: '2023-12-31', revenue: 8.5e9, grossProfit: 3.4e9, netIncome: 1.0e9 * quality, ebit: 1.5e9 * quality, totalAssets: 18e9, currentAssets: 5e9, currentLiabilities: 4e9, longTermDebt: 4.6e9, sharesOutstanding: 500e6, operatingCashFlow: 1.7e9 * quality, capex: 0.8e9, equity: 8e9 },
    ],
  }
}

export interface SyntheticMarketDataOptions {
  days?: number
  assets?: SyntheticAsset[]
  withBenchmark?: boolean
  withCdi?: boolean
  withFundamentals?: boolean
  start?: string
}

/** MarketData em memória com séries sintéticas (mesmo dataset para todos os testes). */
export function syntheticMarketData(options: SyntheticMarketDataOptions = {}): MarketData & { dates: string[] } {
  const days = options.days ?? 1800
  const dates = businessDates(options.start ?? '2016-01-04', days)
  const market = syntheticMarket(dates)
  const assets = options.assets ?? DEFAULT_SYNTH_ASSETS
  const series = new Map(assets.map(a => [a.ticker, syntheticSeries(dates, a, market)]))

  const slice = (raw: RawSeries, years: number): RawSeries => {
    const keep = Math.min(raw.dates.length, Math.ceil(years * 252))
    const from = raw.dates.length - keep
    return {
      ticker: raw.ticker,
      dates: raw.dates.slice(from),
      closes: raw.closes.slice(from),
      volumes: raw.volumes?.slice(from),
    }
  }

  const benchClose: Array<number | null> = []
  let level = 100000
  for (const m of market) {
    level *= Math.exp(0.0003 + m)
    benchClose.push(level)
  }

  return {
    dates,
    async priceSeries(ticker, years) {
      const raw = series.get(ticker)
      return raw ? slice(raw, years) : null
    },
    async benchmarkSeries(years) {
      return options.withBenchmark === false ? null : slice({ ticker: '^BVSP', dates, closes: benchClose }, years)
    },
    async cdiDaily() {
      if (options.withCdi === false) return null
      const map = new Map<string, number>()
      for (const d of dates) map.set(d, 0.0004)
      return map
    },
    async fundamentals(ticker) {
      if (options.withFundamentals === false) return null
      const idx = assets.findIndex(a => a.ticker === ticker)
      return idx >= 0 ? syntheticFundamentals(ticker, idx) : null
    },
  }
}
