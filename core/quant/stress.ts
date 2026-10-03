// Testes de estresse e diagnóstico de cauda (Taleb, Howard Marks): a volatilidade normal subestima o risco.
// Replays históricos usam o preço real dos ativos nas janelas de crise; choques hipotéticos usam betas.

import { type PricePanel } from './panel.ts'
import {
  correlation,
  excessKurtosis,
  mean,
  normalInv,
  ols,
  quantile,
  skewness,
  stdDev,
} from './stats.ts'

export interface TailDiagnostics {
  observations: number
  skew: number
  excessKurtosis: number
  historicalVar95: number
  historicalCvar95: number
  historicalVar99: number
  historicalCvar99: number
  normalVar95: number
  normalVar99: number
  /** Cornish-Fisher: corrige o quantil normal por assimetria e curtose. */
  cornishFisherVar99: number
  /** Quanto o VaR 99% normal subestima o histórico (1 = igual). */
  normalUnderestimation99: number
  worstDay: number
  worstWeek: number
}

/** Diagnóstico de cauda de retornos diários (perdas como números negativos). */
export function tailDiagnostics(returns: number[]): TailDiagnostics {
  const n = returns.length
  const empty: TailDiagnostics = {
    observations: n, skew: 0, excessKurtosis: 0, historicalVar95: 0, historicalCvar95: 0, historicalVar99: 0,
    historicalCvar99: 0, normalVar95: 0, normalVar99: 0, cornishFisherVar99: 0, normalUnderestimation99: 1,
    worstDay: 0, worstWeek: 0,
  }
  if (n < 30) return empty

  const sorted = Float64Array.from(returns).sort()
  const cvar = (q: number) => {
    const v = quantile(sorted, q)
    const tail = Array.from(sorted).filter(r => r <= v)
    return tail.length ? mean(tail) : v
  }
  const m = mean(returns)
  const s = stdDev(returns)
  const sk = skewness(returns)
  const ek = excessKurtosis(returns)
  const z99 = normalInv(0.01)
  const cfZ = z99 + ((z99 * z99 - 1) * sk) / 6 + ((z99 ** 3 - 3 * z99) * ek) / 24 - ((2 * z99 ** 3 - 5 * z99) * sk * sk) / 36

  const hist99 = quantile(sorted, 0.01)
  const normal99 = m + z99 * s

  let worstWeek = 0
  for (let i = 5; i <= n; i++) {
    const week = returns.slice(i - 5, i).reduce((a, r) => a * (1 + r), 1) - 1
    if (week < worstWeek) worstWeek = week
  }

  return {
    observations: n,
    skew: sk,
    excessKurtosis: ek,
    historicalVar95: quantile(sorted, 0.05),
    historicalCvar95: cvar(0.05),
    historicalVar99: hist99,
    historicalCvar99: cvar(0.01),
    normalVar95: m + normalInv(0.05) * s,
    normalVar99: normal99,
    cornishFisherVar99: m + cfZ * s,
    normalUnderestimation99: normal99 !== 0 ? hist99 / normal99 : 1,
    worstDay: sorted[0] as number,
    worstWeek,
  }
}

export interface Scenario {
  id: string
  name: string
  from: string
  to: string
  note: string
}

/** Janelas aproximadas das crises; confira contra o benchmark. */
export const HISTORICAL_SCENARIOS: Scenario[] = [
  { id: 'gfc-2008', name: 'Crise global 2008', from: '2008-05-20', to: '2008-10-27', note: 'Máxima do Ibovespa de maio até a mínima de outubro de 2008.' },
  { id: 'brasil-2015', name: 'Crise fiscal e rebaixamento 2015', from: '2015-04-01', to: '2015-09-30', note: 'Recessão, perda do grau de investimento e Lava Jato.' },
  { id: 'jbs-2017', name: 'Joesley Day 2017', from: '2017-05-16', to: '2017-05-18', note: 'Queda de dois pregões após a delação da JBS.' },
  { id: 'covid-2020', name: 'Pandemia Covid-19', from: '2020-01-23', to: '2020-03-23', note: 'Da máxima de janeiro à mínima de março de 2020.' },
  { id: 'fiscal-2024', name: 'Estresse fiscal 2024', from: '2024-09-30', to: '2024-12-18', note: 'Juros futuros e dólar em máxima no fim de 2024.' },
]

export interface ScenarioResult {
  id: string
  name: string
  from: string
  to: string
  /** Soma dos pesos com preço disponível no início/fim da janela. */
  coverage: number
  portfolioReturn: number | null
  maxDrawdown: number | null
  benchmarkReturn: number | null
  worstAsset: { ticker: string; ret: number } | null
  missing: string[]
}

function firstIndexOnOrAfter(dates: string[], date: string): number {
  return dates.findIndex(d => d >= date)
}

function lastIndexOnOrBefore(dates: string[], date: string): number {
  for (let i = dates.length - 1; i >= 0; i--) if ((dates[i] as string) <= date) return i
  return -1
}

/** Replay buy-and-hold dos pesos atuais numa janela histórica (re-normaliza entre ativos com dados). */
export function replayScenario(
  panel: PricePanel,
  weights: Record<string, number>,
  scenario: Scenario,
  benchmark?: Array<number | null>
): ScenarioResult {
  const a = firstIndexOnOrAfter(panel.dates, scenario.from)
  const b = lastIndexOnOrBefore(panel.dates, scenario.to)
  const base: ScenarioResult = {
    id: scenario.id, name: scenario.name, from: scenario.from, to: scenario.to, coverage: 0,
    portfolioReturn: null, maxDrawdown: null, benchmarkReturn: null, worstAsset: null, missing: Object.keys(weights),
  }
  if (a < 0 || b <= a) return base
  // exige que a janela esteja realmente coberta pelo painel (primeiro pregão perto do início)
  if (new Date(panel.dates[a] as string).getTime() - new Date(scenario.from).getTime() > 7 * 864e5) return base

  const used: Array<{ ticker: string; w: number }> = []
  const missing: string[] = []
  for (const [ticker, w] of Object.entries(weights)) {
    const col = panel.close[ticker]
    const p0 = col?.[a]
    const p1 = col?.[b]
    if (typeof p0 === 'number' && typeof p1 === 'number') used.push({ ticker, w })
    else missing.push(ticker)
  }
  const coverage = used.reduce((acc, u) => acc + u.w, 0)
  if (used.length === 0 || coverage === 0) return { ...base, missing }

  let worst: { ticker: string; ret: number } | null = null
  const path: number[] = []
  for (let i = a; i <= b; i++) {
    let value = 0
    for (const u of used) {
      const col = panel.close[u.ticker] as Array<number | null>
      const p0 = col[a] as number
      const p = typeof col[i] === 'number' ? (col[i] as number) : p0
      value += (u.w / coverage) * (p / p0)
    }
    path.push(value)
  }
  for (const u of used) {
    const col = panel.close[u.ticker] as Array<number | null>
    const ret = (col[b] as number) / (col[a] as number) - 1
    if (!worst || ret < worst.ret) worst = { ticker: u.ticker, ret }
  }
  let peak = -Infinity
  let maxDd = 0
  for (const v of path) {
    if (v > peak) peak = v
    maxDd = Math.min(maxDd, v / peak - 1)
  }
  const bm0 = benchmark?.[a]
  const bm1 = benchmark?.[b]
  return {
    ...base,
    coverage,
    portfolioReturn: (path[path.length - 1] as number) - 1,
    maxDrawdown: maxDd,
    benchmarkReturn: typeof bm0 === 'number' && typeof bm1 === 'number' ? bm1 / bm0 - 1 : null,
    worstAsset: worst,
    missing,
  }
}

/** Betas contra o benchmark (retornos diários, últimos `lookback` pregões). */
export function estimateBetas(panel: PricePanel, benchmark: Array<number | null>, lookback = 504): Record<string, number> {
  const n = panel.dates.length
  const from = Math.max(0, n - lookback)
  const out: Record<string, number> = {}
  for (const ticker of panel.tickers) {
    const x: number[] = []
    const y: number[] = []
    const col = panel.close[ticker] as Array<number | null>
    for (let i = from + 1; i < n; i++) {
      const b0 = benchmark[i - 1]
      const b1 = benchmark[i]
      const p0 = col[i - 1]
      const p1 = col[i]
      if (typeof b0 === 'number' && typeof b1 === 'number' && typeof p0 === 'number' && typeof p1 === 'number') {
        x.push(b1 / b0 - 1)
        y.push(p1 / p0 - 1)
      }
    }
    if (x.length >= 60) out[ticker] = ols(y, x).beta
  }
  return out
}

export interface ShockResult {
  marketShock: number
  portfolioReturn: number
  /** Ativos sem beta estimado usam beta 1. */
  assumedBeta1: string[]
}

/** Choque hipotético de mercado propagado por beta (aproximação linear). */
export function betaShock(weights: Record<string, number>, betas: Record<string, number>, marketShock: number): ShockResult {
  let ret = 0
  const assumed: string[] = []
  for (const [ticker, w] of Object.entries(weights)) {
    const beta = betas[ticker]
    if (beta === undefined) assumed.push(ticker)
    ret += w * (beta ?? 1) * marketShock
  }
  // posição em caixa (soma dos pesos < 1) não sofre o choque
  return { marketShock, portfolioReturn: ret, assumedBeta1: assumed }
}

/** Retornos diários ponderados da carteira (pesos constantes, apenas dias com todos os preços). */
export function portfolioDailyReturns(panel: PricePanel, weights: Record<string, number>, lookback = 756): number[] {
  const tickers = Object.keys(weights).filter(t => panel.close[t])
  const n = panel.dates.length
  const out: number[] = []
  for (let i = Math.max(1, n - lookback); i < n; i++) {
    let r = 0
    let ok = true
    for (const t of tickers) {
      const p0 = (panel.close[t] as Array<number | null>)[i - 1]
      const p1 = (panel.close[t] as Array<number | null>)[i]
      if (typeof p0 !== 'number' || typeof p1 !== 'number') { ok = false; break }
      r += (weights[t] as number) * (p1 / p0 - 1)
    }
    if (ok) out.push(r)
  }
  return out
}

export interface StressReport {
  tail: TailDiagnostics
  scenarios: ScenarioResult[]
  shocks: ShockResult[]
  correlationInCrisis: { normal: number | null; stressed: number | null } | null
  worstScenarioLoss: number | null
}

/** Correlação média entre ativos e o benchmark em dias normais vs. nos 10% piores dias do mercado. */
export function crisisCorrelation(panel: PricePanel, benchmark: Array<number | null>, tickers: string[]): { normal: number | null; stressed: number | null } {
  const days: number[] = []
  const bench: number[] = []
  const benchByDay = new Map<number, number>()
  for (let i = 1; i < panel.dates.length; i++) {
    const b0 = benchmark[i - 1]
    const b1 = benchmark[i]
    if (typeof b0 === 'number' && typeof b1 === 'number') {
      days.push(i)
      bench.push(b1 / b0 - 1)
      benchByDay.set(i, b1 / b0 - 1)
    }
  }
  if (bench.length < 100) return { normal: null, stressed: null }
  const cut = quantile(bench, 0.1)
  const stressIdx = days.filter((_, k) => (bench[k] as number) <= cut)
  const normalIdx = days.filter((_, k) => (bench[k] as number) > cut)
  const avgCorr = (idx: number[]) => {
    const vals: number[] = []
    for (const t of tickers) {
      const col = panel.close[t] as Array<number | null>
      const x: number[] = []
      const y: number[] = []
      for (const i of idx) {
        const p0 = col[i - 1]
        const p1 = col[i]
        if (typeof p0 === 'number' && typeof p1 === 'number') {
          x.push(p1 / p0 - 1)
          y.push(benchByDay.get(i) as number)
        }
      }
      if (x.length >= 20) vals.push(correlation(x, y))
    }
    return vals.length ? mean(vals) : null
  }
  return { normal: avgCorr(normalIdx), stressed: avgCorr(stressIdx) }
}

export function buildStressReport(
  panel: PricePanel,
  weights: Record<string, number>,
  benchmark?: Array<number | null>,
  shocks: number[] = [-0.1, -0.2, -0.3]
): StressReport {
  const scenarios = HISTORICAL_SCENARIOS.map(s => replayScenario(panel, weights, s, benchmark))
  const betas = benchmark ? estimateBetas(panel, benchmark) : {}
  const losses = scenarios.map(s => s.portfolioReturn).filter((v): v is number => v !== null)
  return {
    tail: tailDiagnostics(portfolioDailyReturns(panel, weights)),
    scenarios,
    shocks: shocks.map(s => betaShock(weights, betas, s)),
    correlationInCrisis: benchmark ? crisisCorrelation(panel, benchmark, Object.keys(weights)) : null,
    worstScenarioLoss: losses.length ? Math.min(...losses) : null,
  }
}

