// Estratégias de referência para o backtest. Cada uma decide só com dados até o índice t.

import { type Fundamentals } from './fundamentals.ts'
import { type FactorInput, MIN_HISTORY_FOR_MOMENTUM, type PriceFactorValues, priceFactors, rsi, scoreUniverse } from './factors.ts'
import { type PricePanel, averageDollarVolume, priceAt } from './panel.ts'

export type Weights = Record<string, number>

export interface StrategyContext {
  panel: PricePanel
  /** Índice do dia do sinal (dados até t, inclusive). */
  t: number
  date: string
  prevWeights: Weights
  /** Retorno livre de risco acumulado em 12 meses até t. */
  riskFree12m: number
  /** Fundamentos ponto-no-tempo (opcional). */
  fundamentalsAt?: (ticker: string, date: string, price: number | null) => Fundamentals | null
  /** Pertencimento ao universo na data do sinal (universo histórico). */
  isMember?: (ticker: string) => boolean
  /**
   * Memoização de `priceFactors` por (ticker, t), válida só para ESTE painel: a função é pura e a chave inclui t,
   * então reaproveitar entre estratégias/execuções não introduz look-ahead. Os valores são somente leitura.
   */
  factorCache?: Map<string, PriceFactorValues>
}

/** Fatores de preço de `ticker` em ctx.t, memoizados em ctx.factorCache quando houver. */
function factorsAt(ctx: StrategyContext, ticker: string): PriceFactorValues {
  const column = ctx.panel.close[ticker] as Array<number | null>
  const cache = ctx.factorCache
  if (!cache) return priceFactors(column, ctx.t)
  const key = `${ticker}|${ctx.t}`
  let hit = cache.get(key)
  if (!hit) {
    hit = priceFactors(column, ctx.t)
    cache.set(key, hit)
  }
  return hit
}

export interface Strategy {
  name: string
  label: string
  rebalance(ctx: StrategyContext): Weights
}

export interface UniverseFilter {
  /** Histórico mínimo (pregões) para entrar no universo. */
  minHistory: number
  /** ADV mínimo em R$ (ignorado quando não há dado de volume). */
  minAdv: number
}

export const DEFAULT_UNIVERSE_FILTER: UniverseFilter = { minHistory: MIN_HISTORY_FOR_MOMENTUM, minAdv: 1_000_000 }

/** Ativos negociáveis em t: preço atual, histórico suficiente e liquidez mínima. */
export function eligibleTickers(ctx: StrategyContext, filter: UniverseFilter = DEFAULT_UNIVERSE_FILTER): string[] {
  const { panel, t } = ctx
  return panel.tickers.filter(ticker => {
    const col = panel.close[ticker]
    if (!col || typeof col[t] !== 'number') return false
    if (ctx.isMember && !ctx.isMember(ticker)) return false
    const first = col.findIndex(v => typeof v === 'number')
    if (first < 0 || t - first + 1 < filter.minHistory) return false
    const adv = averageDollarVolume(panel, ticker, t)
    return adv === null || adv >= filter.minAdv
  })
}

function equalWeights(tickers: string[], slots: number): Weights {
  const out: Weights = {}
  for (const t of tickers) out[t] = 1 / slots
  return out
}

function factorInputs(ctx: StrategyContext, tickers: string[]): FactorInput[] {
  return tickers.map(ticker => ({
    ticker,
    price: factorsAt(ctx, ticker),
    fundamentals: ctx.fundamentalsAt ? ctx.fundamentalsAt(ticker, ctx.date, priceAt(ctx.panel, ticker, ctx.t)) : null,
  }))
}

/** Pesos iguais em todo o universo elegível (referência 1/N). */
export function equalWeightStrategy(filter?: UniverseFilter): Strategy {
  return {
    name: 'equal-weight',
    label: 'Igual-ponderada (1/N)',
    rebalance: ctx => {
      const tickers = eligibleTickers(ctx, filter)
      return equalWeights(tickers, Math.max(1, tickers.length))
    },
  }
}

export interface MomentumOptions {
  topN: number
  /** Momentum absoluto (Antonacci): só mantém ativos com momentum > retorno livre de risco. */
  absolute: boolean
  filter?: UniverseFilter
}

/** Momentum 12-1 (Jegadeesh-Titman) com filtro opcional de momentum absoluto. */
export function momentumStrategy(options: MomentumOptions): Strategy {
  return {
    name: `momentum-${options.topN}${options.absolute ? '-abs' : ''}`,
    label: `Momentum 12-1 top ${options.topN}${options.absolute ? ' + momentum absoluto' : ''}`,
    rebalance: ctx => {
      const ranked = eligibleTickers(ctx, options.filter)
        .map(ticker => ({ ticker, m: factorsAt(ctx, ticker).momentum12_1 }))
        .filter((e): e is { ticker: string; m: number } => e.m !== null)
        .filter(e => !options.absolute || e.m > ctx.riskFree12m)
        .sort((a, b) => b.m - a.m)
        .slice(0, options.topN)
      return equalWeights(ranked.map(e => e.ticker), options.topN)
    },
  }
}

export interface LowVolOptions {
  topN: number
  filter?: UniverseFilter
}

/** Baixa volatilidade (Ang, Hodrick, Xing, Zhang): os topN menos voláteis em 12 meses. */
export function lowVolStrategy(options: LowVolOptions): Strategy {
  return {
    name: `low-vol-${options.topN}`,
    label: `Baixa volatilidade top ${options.topN}`,
    rebalance: ctx => {
      const ranked = eligibleTickers(ctx, options.filter)
        .map(ticker => ({ ticker, v: factorsAt(ctx, ticker).vol }))
        .filter((e): e is { ticker: string; v: number } => e.v !== null)
        .sort((a, b) => a.v - b.v)
        .slice(0, options.topN)
      return equalWeights(ranked.map(e => e.ticker), options.topN)
    },
  }
}

export interface MultiFactorOptions {
  topN: number
  requireTrend: boolean
  filter?: UniverseFilter
}

/**
 * Multifator: usa os mesmos fatores do score ao vivo. Sem fundamentos ponto-no-tempo só
 * momentum e baixa volatilidade existem (value/quality ficam de fora e o peso é re-normalizado).
 */
export function multiFactorStrategy(options: MultiFactorOptions): Strategy {
  return {
    name: `multifactor-${options.topN}`,
    label: `Multifator top ${options.topN}`,
    rebalance: ctx => {
      const tickers = eligibleTickers(ctx, options.filter)
      const scored = scoreUniverse(factorInputs(ctx, tickers), { riskFree12m: ctx.riskFree12m })
        .filter(s => s.composite !== null)
        .filter(s => !options.requireTrend || s.trendOk !== false)
        .sort((a, b) => (b.composite as number) - (a.composite as number))
        .slice(0, options.topN)
      return equalWeights(scored.map(s => s.ticker), options.topN)
    },
  }
}

/** Score antigo do app (RSI + variação de ~30 dias), reproduzido para comparação honesta. */
export function legacyScore(rsiValue: number | null, change30d: number, dayChange: number | null): number {
  let score = 50
  if (rsiValue !== null) {
    if (rsiValue > 70) score += 25
    else if (rsiValue > 60) score += 8
    else if (rsiValue < 30) score -= 15
    else if (rsiValue < 40) score -= 8
  }
  if (change30d > 12) score += 30
  else if (change30d > 4) score += 10
  else if (change30d < -18) score -= 12
  else if (change30d < -8) score -= 6
  if (dayChange !== null) {
    if (dayChange > 4) score += 4
    else if (dayChange < -4) score -= 4
  }
  return Math.max(0, Math.min(100, Math.round(score)))
}

export interface LegacyOptions {
  topN: number
  /** Score mínimo para "buy" (app antigo: 55). */
  buyThreshold: number
  filter?: UniverseFilter
}

export function legacyStrategy(options: LegacyOptions): Strategy {
  return {
    name: `legacy-rsi-${options.topN}`,
    label: `Score antigo (RSI + 30d) top ${options.topN}`,
    rebalance: ctx => {
      const { panel, t } = ctx
      const ranked = eligibleTickers(ctx, { ...(options.filter ?? DEFAULT_UNIVERSE_FILTER), minHistory: 60 })
        .map(ticker => {
          const col = panel.close[ticker] as Array<number | null>
          const window = col.slice(Math.max(0, t - 120), t + 1).filter((v): v is number => typeof v === 'number')
          const p = col[t] as number
          const p21 = col[t - 21]
          const p1 = col[t - 1]
          const change30 = typeof p21 === 'number' ? (p / p21 - 1) * 100 : 0
          const day = typeof p1 === 'number' ? (p / p1 - 1) * 100 : null
          return { ticker, score: legacyScore(rsi(window), change30, day) }
        })
        .filter(e => e.score >= options.buyThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topN)
      return equalWeights(ranked.map(e => e.ticker), options.topN)
    },
  }
}

/** Conjunto padrão usado pela API: baseline, concorrentes simples e o multifator. */
export function defaultStrategies(topN = 8): Strategy[] {
  return [
    equalWeightStrategy(),
    legacyStrategy({ topN, buyThreshold: 55 }),
    momentumStrategy({ topN, absolute: false }),
    momentumStrategy({ topN, absolute: true }),
    lowVolStrategy({ topN }),
    multiFactorStrategy({ topN, requireTrend: true }),
  ]
}
