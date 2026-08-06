import { describe, expect, test } from 'bun:test'
import {
  createRandom,
  optimizePortfolio,
  percentile,
  simulateAsset,
  toLogReturns,
  type AssetSeries,
} from './monte-carlo.ts'

function seriesFrom(ticker: string, dailyReturns: number[], start = 100): AssetSeries {
  const closes = [start]
  for (const r of dailyReturns) closes.push((closes[closes.length - 1] as number) * (1 + r))
  return { ticker, closes }
}

function syntheticSeries(ticker: string, drift: number, vol: number, seed: number, size = 260): AssetSeries {
  const rand = createRandom(seed)
  const returns = Array.from({ length: size }, () => drift + vol * (rand() * 2 - 1))
  return seriesFrom(ticker, returns)
}

describe('helpers', () => {
  test('toLogReturns ignora preços inválidos', () => {
    expect(toLogReturns([100, 110, 0, 121]).length).toBe(1)
  })

  test('percentile interpola linearmente', () => {
    const sorted = Float64Array.from([0, 10, 20, 30])
    expect(percentile(sorted, 0)).toBe(0)
    expect(percentile(sorted, 1)).toBe(30)
    expect(percentile(sorted, 0.5)).toBe(15)
  })

  test('PRNG é determinístico com a mesma semente', () => {
    const a = createRandom(42)
    const b = createRandom(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('simulateAsset', () => {
  test('retorna null sem histórico suficiente', () => {
    expect(simulateAsset({ ticker: 'X.SA', closes: [1, 2, 3] })).toBeNull()
  })

  test('ativo sem volatilidade converge para o drift determinístico', () => {
    const series = seriesFrom('FLAT.SA', Array.from({ length: 200 }, () => 0.001))
    const result = simulateAsset(series, { days: 21, sims: 500 })!

    expect(result.volatility.daily).toBe(0)
    // 21 dias a 0,1% ao dia => ~2,12%
    expect(result.distribution.meanPct).toBeCloseTo(2.12, 1)
    expect(result.distribution.probProfit).toBe(1)
    expect(result.maxDrawdownP50Pct).toBe(0)
  })

  test('percentis ficam ordenados e o preço-alvo acompanha', () => {
    const result = simulateAsset(syntheticSeries('VOL.SA', 0.0005, 0.02, 7), { sims: 2000 })!
    const p = result.distribution.percentiles

    expect(p.p5).toBeLessThan(p.p25)
    expect(p.p25).toBeLessThan(p.p50)
    expect(p.p50).toBeLessThan(p.p75)
    expect(p.p75).toBeLessThan(p.p95)
    expect(result.priceTargets.p5).toBeLessThan(result.priceTargets.p95)
    expect(result.distribution.cvar95Pct).toBeLessThanOrEqual(result.distribution.var95Pct)
    expect(result.maxDrawdownP50Pct).toBeLessThanOrEqual(0)
  })

  test('mesma semente produz o mesmo resultado', () => {
    const series = syntheticSeries('SEED.SA', 0.0004, 0.015, 11)
    const a = simulateAsset(series, { sims: 800, seed: 99 })
    const b = simulateAsset(series, { sims: 800, seed: 99 })
    expect(a).toEqual(b)
  })

  test('ativo em queda persistente vira veredito de venda', () => {
    const series = seriesFrom('DOWN.SA', Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? -0.004 : -0.002)))
    const result = simulateAsset(series, { sims: 1000 })!
    expect(result.verdict).toBe('sell')
    expect(result.distribution.meanPct).toBeLessThan(0)
  })

  test('engine gbm também produz distribuição coerente', () => {
    const result = simulateAsset(syntheticSeries('GBM.SA', 0.0006, 0.018, 3), { engine: 'gbm', sims: 2000 })!
    expect(result.engine).toBe('gbm')
    expect(result.distribution.percentiles.p5).toBeLessThan(result.distribution.percentiles.p95)
    expect(result.kellyFraction).toBeGreaterThanOrEqual(0)
    expect(result.kellyFraction).toBeLessThanOrEqual(1)
  })
})

describe('optimizePortfolio', () => {
  const assets: AssetSeries[] = [
    syntheticSeries('WIN.SA', 0.0012, 0.012, 1),
    syntheticSeries('MID.SA', 0.0004, 0.014, 2),
    syntheticSeries('FLAT.SA', 0.0001, 0.010, 3),
    syntheticSeries('LOSS.SA', -0.0008, 0.020, 4),
  ]

  test('retorna null com menos de dois ativos utilizáveis', () => {
    expect(optimizePortfolio([assets[0] as AssetSeries])).toBeNull()
    expect(optimizePortfolio([{ ticker: 'A.SA', closes: [1, 2] }, { ticker: 'B.SA', closes: [1, 2] }])).toBeNull()
  })

  test('pesos somam 1 e respeitam o teto de concentração', () => {
    const result = optimizePortfolio(assets, { sims: 600, candidates: 300, maxWeight: 0.5 })!

    for (const candidate of Object.values(result.best)) {
      const total = candidate.weights.reduce((sum, w) => sum + w.weight, 0)
      expect(total).toBeGreaterThan(0.95)
      expect(total).toBeLessThanOrEqual(1.001)
      for (const allocation of candidate.weights) {
        expect(allocation.weight).toBeLessThanOrEqual(0.5 + 1e-9)
        expect(result.assets).toContain(allocation.ticker)
      }
    }
  })

  test('carteira agressiva não rende menos que a defensiva', () => {
    const result = optimizePortfolio(assets, { sims: 800, candidates: 500 })!
    expect(result.best.aggressive.distribution.meanPct)
      .toBeGreaterThanOrEqual(result.best.defensive.distribution.meanPct)
  })

  test('sobrepondera o ativo de melhor retorno/risco', () => {
    const result = optimizePortfolio(assets, { sims: 800, candidates: 800 })!
    const win = result.best.sharpe.weights.find(w => w.ticker === 'WIN.SA')?.weight ?? 0
    const loss = result.best.sharpe.weights.find(w => w.ticker === 'LOSS.SA')?.weight ?? 0
    expect(win).toBeGreaterThan(loss)
  })

  test('respeita o piso de CVaR na carteira agressiva', () => {
    const result = optimizePortfolio(assets, { sims: 800, candidates: 500, cvarFloor: -0.05 })!
    expect(result.best.aggressive.distribution.cvar95Pct).toBeGreaterThanOrEqual(-5)
  })

  test('expõe fronteira e simulação por ativo', () => {
    const result = optimizePortfolio(assets, { sims: 600, candidates: 300 })!
    expect(result.frontier.length).toBeGreaterThan(1)
    expect(result.perAsset.map(a => a.ticker).sort()).toEqual(['FLAT.SA', 'LOSS.SA', 'MID.SA', 'WIN.SA'])
    expect(result.best.sharpe.maxDrawdownP50Pct).toBeLessThanOrEqual(0)
  })
})
