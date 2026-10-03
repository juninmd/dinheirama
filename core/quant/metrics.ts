// Métricas de desempenho e de significância estatística (anti-overfitting).
// Referências: Bailey & López de Prado (2012, 2014) — PSR e Sharpe Deflacionado.

import {
  TRADING_DAYS_YEAR,
  excessKurtosis,
  mean,
  normalCdf,
  normalInv,
  ols,
  quantile,
  skewness,
  stdDev,
} from './stats.ts'

export interface PerformanceMetrics {
  days: number
  totalReturn: number
  cagr: number
  annVol: number
  sharpe: number
  sortino: number
  maxDrawdown: number
  calmar: number
  skew: number
  excessKurtosis: number
  var95Daily: number
  cvar95Daily: number
  hitRateMonthly: number | null
  /** Probabilidade de o Sharpe verdadeiro ser > 0 dada a amostra (PSR). */
  psr: number
}

export interface BenchmarkRelative {
  alphaAnnual: number
  beta: number
  r2: number
  trackingError: number
  informationRatio: number
  excessCagr: number
}

export function equityFromReturns(returns: number[], start = 1): number[] {
  const out = [start]
  for (const r of returns) out.push((out[out.length - 1] as number) * (1 + r))
  return out
}

export function maxDrawdownOf(equity: number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of equity) {
    if (v > peak) peak = v
    const dd = peak > 0 ? v / peak - 1 : 0
    if (dd < worst) worst = dd
  }
  return worst
}

/** Sharpe por período (não anualizado) sobre retornos em excesso. */
export function periodSharpe(excess: number[]): number {
  const s = stdDev(excess)
  return s === 0 ? 0 : mean(excess) / s
}

/** Probabilistic Sharpe Ratio: P(SR > benchmarkSr) ajustado por assimetria/curtose/tamanho da amostra. */
export function probabilisticSharpe(excess: number[], benchmarkSr = 0): number {
  const n = excess.length
  if (n < 10) return 0.5
  const sr = periodSharpe(excess)
  const g3 = skewness(excess)
  const g4 = excessKurtosis(excess) + 3
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr))
  return normalCdf(((sr - benchmarkSr) * Math.sqrt(n - 1)) / denom)
}

/**
 * Sharpe Deflacionado: corrige o PSR pelo número de estratégias testadas (seleção).
 * `trialSharpes` = Sharpes por período de TODAS as variantes tentadas (inclusive as descartadas).
 */
export function deflatedSharpe(excess: number[], trialSharpes: number[]): number {
  const trials = Math.max(1, trialSharpes.length)
  if (trials === 1) return probabilisticSharpe(excess, 0)
  const variance = stdDev(trialSharpes) ** 2
  const gamma = 0.5772156649
  const expectedMax =
    Math.sqrt(variance) * ((1 - gamma) * normalInv(1 - 1 / trials) + gamma * normalInv(1 - 1 / (trials * Math.E)))
  return probabilisticSharpe(excess, expectedMax)
}

/** Retornos mensais compostos a partir de retornos diários e datas. */
export function monthlyReturns(dailyReturns: number[], dates: string[]): number[] {
  const out: number[] = []
  let acc = 1
  let month = ''
  for (let i = 0; i < dailyReturns.length; i++) {
    const m = (dates[i + 1] ?? '').slice(0, 7)
    if (month && m !== month) {
      out.push(acc - 1)
      acc = 1
    }
    month = m
    acc *= 1 + (dailyReturns[i] as number)
  }
  if (month) out.push(acc - 1)
  return out
}

/**
 * @param returns retornos simples diários da estratégia
 * @param rfDaily taxa livre de risco diária (escalar ou série alinhada)
 * @param dates datas alinhadas (length = returns.length + 1) para o hit rate mensal
 */
export function computeMetrics(returns: number[], rfDaily: number | number[], dates?: string[]): PerformanceMetrics {
  const n = returns.length
  if (n === 0) {
    return {
      days: 0, totalReturn: 0, cagr: 0, annVol: 0, sharpe: 0, sortino: 0, maxDrawdown: 0, calmar: 0,
      skew: 0, excessKurtosis: 0, var95Daily: 0, cvar95Daily: 0, hitRateMonthly: null, psr: 0.5,
    }
  }
  const rf = (i: number) => (Array.isArray(rfDaily) ? (rfDaily[i] as number) ?? 0 : rfDaily)
  const excess = returns.map((r, i) => r - rf(i))
  const equity = equityFromReturns(returns)
  const totalReturn = (equity[equity.length - 1] as number) - 1
  const years = n / TRADING_DAYS_YEAR
  const cagr = years > 0 && equity[equity.length - 1]! > 0 ? Math.pow(equity[equity.length - 1] as number, 1 / years) - 1 : -1
  const annVol = stdDev(returns) * Math.sqrt(TRADING_DAYS_YEAR)
  const sharpe = periodSharpe(excess) * Math.sqrt(TRADING_DAYS_YEAR)
  const downside = Math.sqrt(mean(excess.map(x => Math.min(0, x) ** 2)))
  const sortino = downside === 0 ? 0 : (mean(excess) / downside) * Math.sqrt(TRADING_DAYS_YEAR)
  const maxDrawdown = maxDrawdownOf(equity)
  const sorted = Float64Array.from(returns).sort()
  const var95 = quantile(sorted, 0.05)
  const tail = Array.from(sorted).filter(r => r <= var95)
  let hit: number | null = null
  if (dates && dates.length === n + 1) {
    const monthly = monthlyReturns(returns, dates)
    if (monthly.length > 0) hit = monthly.filter(m => m > 0).length / monthly.length
  }
  return {
    days: n,
    totalReturn,
    cagr,
    annVol,
    sharpe,
    sortino,
    maxDrawdown,
    calmar: maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : 0,
    skew: skewness(returns),
    excessKurtosis: excessKurtosis(returns),
    var95Daily: var95,
    cvar95Daily: tail.length > 0 ? mean(tail) : var95,
    hitRateMonthly: hit,
    psr: probabilisticSharpe(excess, 0),
  }
}

export function benchmarkRelative(returns: number[], bench: number[], rfDaily: number | number[]): BenchmarkRelative {
  const n = Math.min(returns.length, bench.length)
  const r = returns.slice(0, n)
  const b = bench.slice(0, n)
  const rf = (i: number) => (Array.isArray(rfDaily) ? (rfDaily[i] as number) ?? 0 : rfDaily)
  const re = r.map((x, i) => x - rf(i))
  const be = b.map((x, i) => x - rf(i))
  const fit = ols(re, be)
  const active = r.map((x, i) => x - (b[i] as number))
  const te = stdDev(active) * Math.sqrt(TRADING_DAYS_YEAR)
  const cagr = (xs: number[]) => {
    const eq = equityFromReturns(xs)
    const years = xs.length / TRADING_DAYS_YEAR
    return years > 0 ? Math.pow(eq[eq.length - 1] as number, 1 / years) - 1 : 0
  }
  const excessCagr = cagr(r) - cagr(b)
  return {
    alphaAnnual: fit.alpha * TRADING_DAYS_YEAR,
    beta: fit.beta,
    r2: fit.r2,
    trackingError: te,
    informationRatio: te === 0 ? 0 : (mean(active) * TRADING_DAYS_YEAR) / te,
    excessCagr,
  }
}
