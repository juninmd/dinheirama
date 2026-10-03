// Motor multifator (valor, qualidade, momentum, baixa volatilidade).
// O MESMO código roda no backtest (só com fatores de preço) e no score ao vivo (com fundamentos):
// o que foi validado é o que é publicado.
//
// Base: Fama-French/Carhart (fatores), Jegadeesh-Titman e Antonacci (momentum 12-1, absoluto),
// George-Hwang (proximidade da máxima de 52 semanas), Asness et al. (qualidade), Ang et al. (baixa vol),
// DeMiguel et al. (2009): pesos iguais entre fatores = sem otimização in-sample.

import { type Fundamentals, deriveMetrics, grahamMarginOfSafety } from './fundamentals.ts'
import { TRADING_DAYS_YEAR, logReturns, percentileRanks, stdDev, zScores } from './stats.ts'

export interface PriceFactorValues {
  /** Retorno de t-252 até t-21 (pula o último mês: reversão de curto prazo). */
  momentum12_1: number | null
  momentum6_1: number | null
  /** Retorno do último mês (informativo; fraco/reverso). */
  return1m: number | null
  /** Volatilidade anualizada (até 252 pregões). */
  vol: number | null
  /** Preço / máxima de 252 pregões (1 = na máxima). */
  proximity52w: number | null
  /** Queda atual desde a máxima de 252 pregões (<= 0). */
  drawdown: number | null
  rsi14: number | null
}

export const MIN_HISTORY_FOR_MOMENTUM = 253

function at(closes: Array<number | null>, i: number): number | null {
  const v = closes[i]
  return typeof v === 'number' && v > 0 ? v : null
}

/** RSI de Wilder (informativo — não entra no score de compra). */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number)
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number)
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** Fatores de preço usando SOMENTE dados até o índice t (sem look-ahead). */
export function priceFactors(closes: Array<number | null>, t: number): PriceFactorValues {
  const p = at(closes, t)
  const p21 = at(closes, t - 21)
  const p126 = at(closes, t - 126)
  const p252 = at(closes, t - 252)

  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null ? a / b - 1 : null)

  let vol: number | null = null
  const from = Math.max(0, t - 252)
  const window: number[] = []
  for (let i = from; i <= t; i++) {
    const v = at(closes, i)
    if (v === null) {
      window.length = 0 // lacuna: reinicia janela contígua
      continue
    }
    window.push(v)
  }
  if (window.length >= 60) vol = stdDev(logReturns(window)) * Math.sqrt(TRADING_DAYS_YEAR)

  let high: number | null = null
  for (let i = Math.max(0, t - 252); i <= t; i++) {
    const v = at(closes, i)
    if (v !== null && (high === null || v > high)) high = v
  }

  const contiguous = window.length >= 15 ? window : []
  return {
    momentum12_1: ratio(p21, p252),
    momentum6_1: ratio(p21, p126),
    return1m: ratio(p, p21),
    vol,
    proximity52w: p !== null && high !== null ? p / high : null,
    drawdown: p !== null && high !== null ? p / high - 1 : null,
    rsi14: contiguous.length >= 15 ? rsi(contiguous.slice(-120)) : null,
  }
}

export interface FactorWeights {
  value: number
  quality: number
  momentum: number
  lowVol: number
}

/** 1/N entre fatores: nenhum peso foi ajustado a dados passados. */
export const DEFAULT_FACTOR_WEIGHTS: FactorWeights = { value: 0.25, quality: 0.25, momentum: 0.25, lowVol: 0.25 }

export interface FactorInput {
  ticker: string
  price: PriceFactorValues
  fundamentals?: Fundamentals | null
}

export interface FactorGroups {
  value: number | null
  quality: number | null
  momentum: number | null
  lowVol: number | null
}

export interface FactorScore {
  ticker: string
  /** Composto (média ponderada de z-scores dos grupos disponíveis); null se dados insuficientes. */
  composite: number | null
  /** Posto percentual 0..100 no universo. */
  score: number | null
  groups: FactorGroups
  /** Grupos com dado / 4. */
  coverage: number
  /** Tendência absoluta positiva: momentum 12-1 acima do retorno livre de risco do período. */
  trendOk: boolean | null
  grahamMarginOfSafety: number | null
  magicFormulaRank: number | null
  metrics: {
    momentum12_1: number | null
    vol: number | null
    drawdown: number | null
    earningsYield: number | null
    bookToPrice: number | null
    fcfYield: number | null
    dividendYield: number | null
    roe: number | null
    roic: number | null
    netDebtToEbitda: number | null
    piotroski: number | null
  }
}

export interface ScoreOptions {
  weights?: FactorWeights
  /** Retorno livre de risco de 12 meses (para o filtro de momentum absoluto). */
  riskFree12m?: number
  /** Exige ao menos este nº de grupos com dado (default 2). */
  minGroups?: number
}

function avgAvailable(values: Array<number | null>): number | null {
  const valid = values.filter((v): v is number => v !== null)
  return valid.length === 0 ? null : valid.reduce((a, b) => a + b, 0) / valid.length
}

/** Posto da Fórmula Mágica (Greenblatt): soma dos postos de earnings yield e ROIC; menor é melhor. */
export function magicFormulaRanks(rows: Array<{ ey: number | null; roic: number | null }>): Array<number | null> {
  const eyRank = percentileRanks(rows.map(r => r.ey))
  const roicRank = percentileRanks(rows.map(r => r.roic))
  const combined = rows.map((_, i) => (eyRank[i] !== null && roicRank[i] !== null ? (eyRank[i] as number) + (roicRank[i] as number) : null))
  // converte soma de postos percentuais em posição 1..N (1 = melhor)
  const order = combined
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => e.v !== null)
    .sort((a, b) => b.v - a.v)
  const out: Array<number | null> = rows.map(() => null)
  order.forEach((e, k) => { out[e.i] = k + 1 })
  return out
}

/** Pontua o universo de forma cross-sectional. */
export function scoreUniverse(inputs: FactorInput[], options: ScoreOptions = {}): FactorScore[] {
  const weights = options.weights ?? DEFAULT_FACTOR_WEIGHTS
  const minGroups = options.minGroups ?? 2
  const derived = inputs.map(i => (i.fundamentals ? deriveMetrics(i.fundamentals) : null))

  const z = (pick: (i: number) => number | null | undefined) => zScores(inputs.map((_, i) => pick(i)))

  const zEy = z(i => derived[i]?.earningsYield)
  const zBp = z(i => derived[i]?.bookToPrice)
  const zFcf = z(i => derived[i]?.fcfYield)
  const zDy = z(i => derived[i]?.dividendYield)
  const zRoe = z(i => derived[i]?.roe)
  const zRoic = z(i => derived[i]?.roic)
  const zMargin = z(i => derived[i]?.operatingMargin)
  const zLev = z(i => {
    const lev = derived[i]?.netDebtToEbitda
    return lev === null || lev === undefined ? null : -lev
  })
  const zF = z(i => derived[i]?.piotroski?.scaled)
  const zMom = z(i => inputs[i]!.price.momentum12_1)
  const zProx = z(i => inputs[i]!.price.proximity52w)
  const zVol = z(i => {
    const v = inputs[i]!.price.vol
    return v === null ? null : -v
  })

  const groupsList: FactorGroups[] = inputs.map((_, i) => ({
    value: avgAvailable([zEy[i]!, zBp[i]!, zFcf[i]!, zDy[i]!]),
    quality: avgAvailable([zRoe[i]!, zRoic[i]!, zMargin[i]!, zLev[i]!, zF[i]!]),
    momentum: avgAvailable([zMom[i]!, zProx[i]!]),
    lowVol: zVol[i] ?? null,
  }))

  const composites = groupsList.map(g => {
    const parts: Array<[number, number | null]> = [
      [weights.value, g.value], [weights.quality, g.quality], [weights.momentum, g.momentum], [weights.lowVol, g.lowVol],
    ]
    const available = parts.filter(([, v]) => v !== null) as Array<[number, number]>
    if (available.length < minGroups) return null
    const wSum = available.reduce((a, [w]) => a + w, 0)
    return wSum === 0 ? null : available.reduce((a, [w, v]) => a + w * v, 0) / wSum
  })

  const scores = percentileRanks(composites)
  const magic = magicFormulaRanks(derived.map(d => ({ ey: d?.earningsYield ?? null, roic: d?.roic ?? null })))

  return inputs.map((input, i) => {
    const g = groupsList[i] as FactorGroups
    const d = derived[i]
    const m12 = input.price.momentum12_1
    const rf = options.riskFree12m
    return {
      ticker: input.ticker,
      composite: composites[i] ?? null,
      score: scores[i] === null || scores[i] === undefined ? null : Math.round(scores[i] as number),
      groups: g,
      coverage: [g.value, g.quality, g.momentum, g.lowVol].filter(v => v !== null).length / 4,
      trendOk: m12 !== null && rf !== undefined ? m12 > rf : null,
      grahamMarginOfSafety: input.fundamentals ? grahamMarginOfSafety(input.fundamentals) : null,
      magicFormulaRank: magic[i] ?? null,
      metrics: {
        momentum12_1: m12,
        vol: input.price.vol,
        drawdown: input.price.drawdown,
        earningsYield: d?.earningsYield ?? null,
        bookToPrice: d?.bookToPrice ?? null,
        fcfYield: d?.fcfYield ?? null,
        dividendYield: d?.dividendYield ?? null,
        roe: d?.roe ?? null,
        roic: d?.roic ?? null,
        netDebtToEbitda: d?.netDebtToEbitda ?? null,
        piotroski: d?.piotroski?.score ?? null,
      },
    }
  })
}

export type SuggestedSignal = 'buy' | 'hold' | 'sell'

/**
 * Sinal educacional a partir do posto: quintil superior com tendência absoluta positiva => 'buy';
 * quintil inferior => 'sell'; demais => 'hold'. É um ranking relativo, não uma previsão.
 */
export function signalFromScore(score: number | null, trendOk: boolean | null): SuggestedSignal {
  if (score === null) return 'hold'
  if (score >= 80) return trendOk === false ? 'hold' : 'buy'
  if (score <= 20) return 'sell'
  return 'hold'
}

/** Risco por volatilidade anualizada e drawdown atual (substitui a heurística por RSI). */
export function classifyRiskByVol(vol: number | null, drawdown: number | null): 'low' | 'medium' | 'high' {
  if (vol === null) return 'medium'
  if (vol >= 0.45 || (drawdown !== null && drawdown <= -0.4)) return 'high'
  if (vol >= 0.3 || (drawdown !== null && drawdown <= -0.25)) return 'medium'
  return 'low'
}
