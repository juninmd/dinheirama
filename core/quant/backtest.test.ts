import { describe, expect, test } from 'bun:test'
import { compareStrategies, runBacktest, toApiResult } from './backtest.ts'
import { type PricePanel, alignPanel, monthStartIndexes } from './panel.ts'
import {
  type Strategy,
  type StrategyContext,
  defaultStrategies,
  eligibleTickers,
  legacyScore,
  momentumStrategy,
} from './strategies.ts'
import { DEFAULT_SYNTH_ASSETS, businessDates, syntheticMarket, syntheticSeries } from './test-helpers.ts'

const dates = businessDates('2018-01-02', 700)
const WARMUP = 30

function panelOf(columns: Record<string, (i: number) => number>): PricePanel {
  return alignPanel(
    Object.entries(columns).map(([ticker, fn]) => ({
      ticker,
      dates,
      closes: dates.map((_, i) => fn(i)),
      volumes: dates.map(() => 5_000_000),
    }))
  )
}

const hold = (ticker: string, w = 1): Strategy => ({ name: `hold-${ticker}`, label: 'hold', rebalance: () => ({ [ticker]: w }) })
const noCost = { cost: null, tax: null, warmup: WARMUP, riskFreeAnnual: 0, rebalanceBand: 0 }

describe('backtest', () => {
  test('sem custos nem IR, o retorno diário iguala o do ativo mantido', () => {
    const panel = panelOf({ A: i => 10 * 1.0005 ** i })
    const r = runBacktest(panel, hold('A'), noCost)!
    const tail = r.series.strategy.slice(5)
    for (const x of tail) expect(x).toBeCloseTo(0.0005, 8)
    expect(r.totalCosts).toBe(0)
    expect(r.totalTax).toBe(0)
  })

  test('caixa rende CDI quando a estratégia não tem posições', () => {
    const panel = panelOf({ A: i => 10 + i * 0 })
    const rf = dates.map(() => 0.0004)
    const r = runBacktest(panel, { name: 'cash', label: 'cash', rebalance: () => ({}) }, { ...noCost, cdiDaily: rf })!
    for (const x of r.series.strategy) expect(x).toBeCloseTo(0.0004, 8)
    expect(r.net.cagr).toBeCloseTo(1.0004 ** 252 - 1, 3)
  })

  test('execução atrasada: salto no pregão t+2 é capturado com lag 1, mas não com lag 2', () => {
    const sig = monthStartIndexes(dates).find(i => i >= WARMUP) as number
    const panel = panelOf({ B: i => (i >= sig + 2 ? 150 : 100) })
    const lag1 = runBacktest(panel, hold('B'), { ...noCost, executionLagDays: 1 })!
    const lag2 = runBacktest(panel, hold('B'), { ...noCost, executionLagDays: 2 })!
    expect(lag1.net.totalReturn).toBeCloseTo(0.5, 6)
    expect(lag2.net.totalReturn).toBeCloseTo(0, 6)
  })

  test('lag 0 é tratado como 1 (executar no fechamento do sinal seria look-ahead)', () => {
    const sig = monthStartIndexes(dates).find(i => i >= WARMUP) as number
    const panel = panelOf({ B: i => (i >= sig + 1 ? 150 : 100) })
    const r = runBacktest(panel, hold('B'), { ...noCost, executionLagDays: 0 })!
    expect(r.net.totalReturn).toBeCloseTo(0, 6) // salto em sig+1 acontece antes da compra em sig+1
  })

  test('custos reduzem o resultado líquido e geram giro', () => {
    const assets = DEFAULT_SYNTH_ASSETS.slice(0, 4)
    const market = syntheticMarket(dates)
    const panel = alignPanel(assets.map(a => syntheticSeries(dates, a, market)))
    const strat = momentumStrategy({ topN: 2, absolute: false, filter: { minHistory: 40, minAdv: 0 } })
    const r = runBacktest(panel, strat, { warmup: 60, riskFreeAnnual: 0.1, tax: null })!
    expect(r.totalCosts).toBeGreaterThan(0)
    expect(r.net.totalReturn).toBeLessThan(r.gross.totalReturn)
    expect(r.turnoverAnnual).toBeGreaterThan(0)
  })

  test('IR de 15% incide sobre o lucro realizado acima de R$ 20 mil em vendas', () => {
    const exits = monthStartIndexes(dates).filter(i => i >= WARMUP)
    const secondSignal = exits[1] as number
    // sobe 30% entre a compra e a venda e cai para caixa na 2a rebalanceada
    const growth = (i: number) => 10 * (1 + 0.3 * Math.min(1, Math.max(0, (i - (exits[0] as number)) / (secondSignal - (exits[0] as number)))))
    const panel = panelOf({ A: growth })
    const strat: Strategy = { name: 'in-out', label: 'in-out', rebalance: ctx => (ctx.t === exits[0] ? { A: 1 } : ({} as Record<string, number>)) }

    const big = runBacktest(panel, strat, { ...noCost, tax: { rate: 0.15, monthlySalesExemption: 20000 }, initialCapital: 100_000 })!
    expect(big.totalTax).toBeGreaterThan(3500)
    expect(big.totalTax).toBeLessThan(4600)
    expect(big.net.totalReturn).toBeLessThan(big.gross.totalReturn)

    const small = runBacktest(panel, strat, { ...noCost, tax: { rate: 0.15, monthlySalesExemption: 20000 }, initialCapital: 10_000 })!
    expect(small.totalTax).toBe(0)
  })

  test('toApiResult remove as séries diárias', () => {
    const panel = panelOf({ A: i => 10 * 1.0003 ** i })
    const r = runBacktest(panel, hold('A'), noCost)!
    expect('series' in toApiResult(r)).toBe(false)
    expect(r.equityCurve.length).toBeLessThanOrEqual(401)
    expect(r.caveats.some(c => c.includes('sobrevivência'))).toBe(true)
  })

  test('compareStrategies calcula o Sharpe deflacionado', () => {
    const market = syntheticMarket(dates)
    const panel = alignPanel(DEFAULT_SYNTH_ASSETS.map(a => syntheticSeries(dates, a, market)))
    const results = compareStrategies(panel, defaultStrategies(3), { warmup: 260, riskFreeAnnual: 0.1 })
    expect(results.length).toBeGreaterThanOrEqual(5)
    for (const r of results) {
      expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0)
      expect(r.deflatedSharpe).toBeLessThanOrEqual(1)
    }
  })
})

describe('estratégias não olham o futuro', () => {
  const market = syntheticMarket(dates)
  const panel = alignPanel(DEFAULT_SYNTH_ASSETS.map(a => syntheticSeries(dates, a, market)))
  const t = 400
  const mutate = (p: PricePanel): PricePanel => ({
    ...p,
    close: Object.fromEntries(Object.entries(p.close).map(([k, col]) => [k, col.map((v, i) => (i > t && v !== null ? v * (1 + ((i * 7) % 5)) : v))])),
  })
  const ctx = (p: PricePanel): StrategyContext => ({ panel: p, t, date: dates[t] as string, prevWeights: {}, riskFree12m: 0.1 })

  for (const strategy of defaultStrategies(3)) {
    test(`${strategy.name}: pesos em t não mudam se o futuro mudar`, () => {
      expect(strategy.rebalance(ctx(mutate(panel)))).toEqual(strategy.rebalance(ctx(panel)))
    })
  }

  test('universo elegível exige histórico mínimo e liquidez', () => {
    const late = alignPanel([
      { ticker: 'OLD', dates, closes: dates.map(() => 10), volumes: dates.map(() => 1_000_000) },
      { ticker: 'NEW', dates: dates.slice(300), closes: dates.slice(300).map(() => 10), volumes: dates.slice(300).map(() => 1_000_000) },
      { ticker: 'ILLIQ', dates, closes: dates.map(() => 10), volumes: dates.map(() => 10) },
    ])
    const c = ctx(late)
    expect(eligibleTickers(c)).toEqual(['OLD'])
  })

  test('score legado reproduz as regras antigas (RSI > 70 e +30d somam muito)', () => {
    expect(legacyScore(75, 15, 0)).toBe(100)
    expect(legacyScore(25, -20, -5)).toBe(19)
    expect(legacyScore(null, 0, null)).toBe(50)
  })
})
