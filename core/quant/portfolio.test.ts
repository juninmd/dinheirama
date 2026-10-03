import { describe, expect, test } from 'bun:test'
import { createRandom } from '../monte-carlo.ts'
import {
  applyCaps,
  constructPortfolio,
  equalRiskContribution,
  fractionalKelly,
  hierarchicalOrder,
  hierarchicalRiskParity,
  inverseVolatility,
  ledoitWolfCovariance,
  minimumVariance,
  portfolioVariance,
  projectCappedSimplex,
  riskContributions,
  shrinkMeans,
} from './portfolio.ts'
import { correlationFromCovariance, covarianceMatrix } from './stats.ts'

function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/** T×N com 2 clusters correlacionados (0,1,2) e (3,4) e um independente (5). */
function clusteredReturns(t = 500, seed = 5): number[][] {
  const rand = createRandom(seed)
  const vols = [0.010, 0.012, 0.015, 0.020, 0.022, 0.008]
  return Array.from({ length: t }, () => {
    const f1 = gaussian(rand)
    const f2 = gaussian(rand)
    return [
      vols[0]! * (0.9 * f1 + 0.44 * gaussian(rand)),
      vols[1]! * (0.9 * f1 + 0.44 * gaussian(rand)),
      vols[2]! * (0.9 * f1 + 0.44 * gaussian(rand)),
      vols[3]! * (0.9 * f2 + 0.44 * gaussian(rand)),
      vols[4]! * (0.9 * f2 + 0.44 * gaussian(rand)),
      vols[5]! * gaussian(rand),
    ]
  })
}

const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)

describe('covariância encolhida', () => {
  test('intensidade em [0,1], diagonal positiva e simétrica', () => {
    const { cov, shrinkage } = ledoitWolfCovariance(clusteredReturns())
    expect(shrinkage).toBeGreaterThanOrEqual(0)
    expect(shrinkage).toBeLessThanOrEqual(1)
    cov.forEach((row, i) => {
      expect(row[i]).toBeGreaterThan(0)
      row.forEach((v, j) => expect(v).toBeCloseTo((cov[j] as number[])[i] as number, 12))
    })
  })

  test('encolhe mais com poucas observações do que com muitas', () => {
    const few = ledoitWolfCovariance(clusteredReturns(40)).shrinkage
    const many = ledoitWolfCovariance(clusteredReturns(2000)).shrinkage
    expect(few).toBeGreaterThan(many)
  })

  test('é bem condicionada quando T < N (a amostral é singular)', () => {
    const rows = clusteredReturns(5)
    const { cov } = ledoitWolfCovariance(rows)
    // todos os autovalores positivos <=> variância de qualquer carteira > 0
    expect(portfolioVariance([1, -1, 1, -1, 1, -1], cov)).toBeGreaterThan(0)
  })

  test('shrinkMeans aproxima as médias da média global', () => {
    const { shrunk, intensity } = shrinkMeans([0.001, 0.002, -0.001, 0.0005], [0.0004, 0.0004, 0.0004, 0.0004], 100)
    expect(intensity).toBeGreaterThan(0)
    const grand = (0.001 + 0.002 - 0.001 + 0.0005) / 4
    expect(Math.abs((shrunk[1] as number) - grand)).toBeLessThan(Math.abs(0.002 - grand))
  })
})

describe('alocações', () => {
  const { cov } = ledoitWolfCovariance(clusteredReturns())

  test('inverso da volatilidade pesa mais o ativo menos volátil', () => {
    const w = inverseVolatility(cov)
    expect(sum(w)).toBeCloseTo(1, 10)
    expect(w[5]).toBeGreaterThan(w[4] as number)
  })

  test('ERC iguala as contribuições de risco', () => {
    const w = equalRiskContribution(cov)
    const rc = riskContributions(w, cov)
    for (const c of rc) expect(c).toBeCloseTo(1 / 6, 3)
  })

  test('HRP: soma 1, pesos positivos e cluster correlacionado não domina', () => {
    const w = hierarchicalRiskParity(cov)
    expect(sum(w)).toBeCloseTo(1, 10)
    expect(w.every(x => x > 0)).toBe(true)
    const clusterA = (w[0] as number) + (w[1] as number) + (w[2] as number)
    expect(clusterA).toBeLessThan(0.7)
    // o ativo independente e de baixa vol recebe peso relevante
    expect(w[5]).toBeGreaterThan(0.15)
  })

  test('ordem hierárquica mantém ativos correlacionados adjacentes', () => {
    const order = hierarchicalOrder(correlationFromCovariance(cov))
    expect(order.length).toBe(6)
    const pos = (i: number) => order.indexOf(i)
    const spanA = Math.max(pos(0), pos(1), pos(2)) - Math.min(pos(0), pos(1), pos(2))
    expect(spanA).toBe(2)
    expect(Math.abs(pos(3) - pos(4))).toBe(1)
  })

  test('mínima variância respeita teto e supera 1/N em variância', () => {
    const w = minimumVariance(cov, 0.3)
    expect(sum(w)).toBeCloseTo(1, 6)
    expect(Math.max(...w)).toBeLessThanOrEqual(0.3 + 1e-9)
    expect(portfolioVariance(w, cov)).toBeLessThan(portfolioVariance(Array.from({ length: 6 }, () => 1 / 6), cov))
  })

  test('projeção no simplex com teto', () => {
    const w = projectCappedSimplex([5, 1, 0.5, 0.2], 0.4)
    expect(sum(w)).toBeCloseTo(1, 8)
    expect(Math.max(...w)).toBeLessThanOrEqual(0.4 + 1e-9)
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0)
  })

  test('tetos por ativo e por setor são respeitados', () => {
    const w = applyCaps([0.6, 0.2, 0.1, 0.05, 0.05], ['X', 'X', 'Y', 'Z', 'W'], { maxWeight: 0.3, maxSector: 0.4 })
    expect(sum(w)).toBeCloseTo(1, 6)
    expect(Math.max(...w)).toBeLessThanOrEqual(0.3 + 1e-6)
    expect((w[0] as number) + (w[1] as number)).toBeLessThanOrEqual(0.4 + 1e-6)
  })

  test('Kelly fracionado é limitado e zero sem vantagem', () => {
    expect(fractionalKelly(0.0005, 0.0001, 0.25, 0.2)).toBeCloseTo(0.2, 8)
    expect(fractionalKelly(0.00001, 0.0004, 0.25, 0.2)).toBeCloseTo(0.25 * 0.025, 8)
    expect(fractionalKelly(-0.001, 0.0004)).toBe(0)
    expect(fractionalKelly(0.001, 0)).toBe(0)
  })
})

describe('constructPortfolio', () => {
  const returns = clusteredReturns()
  const tickers = ['A', 'B', 'C', 'D', 'E', 'F']
  const sectors = ['S1', 'S1', 'S1', 'S2', 'S2', 'S3']

  for (const method of ['hrp', 'erc', 'ivol', 'minvar', 'meanvar'] as const) {
    test(`${method}: pesos válidos e diagnósticos coerentes`, () => {
      const result = constructPortfolio({ tickers, returns, sectors, method, maxWeight: 0.4, maxSector: 0.6 })!
      const total = result.weights.reduce((a, w) => a + w.weight, 0)
      expect(total).toBeGreaterThan(0.99)
      expect(total).toBeLessThan(1.01)
      expect(Math.max(...result.weights.map(w => w.weight))).toBeLessThanOrEqual(0.4 + 1e-3)
      expect(result.diagnostics.effectiveN).toBeGreaterThan(1)
      expect(result.diagnostics.diversificationRatio).toBeGreaterThanOrEqual(1)
      expect(result.diagnostics.annualVol).toBeGreaterThan(0)
    })
  }

  test('retorna null com dados insuficientes', () => {
    expect(constructPortfolio({ tickers, returns: returns.slice(0, 20), method: 'hrp', maxWeight: 0.3, maxSector: 0.5 })).toBeNull()
  })

  test('mesma entrada => mesma saída (determinístico)', () => {
    const a = constructPortfolio({ tickers, returns, sectors, method: 'hrp', maxWeight: 0.3, maxSector: 0.5 })
    const b = constructPortfolio({ tickers, returns, sectors, method: 'hrp', maxWeight: 0.3, maxSector: 0.5 })
    expect(a).toEqual(b)
  })

  test('covarianceMatrix coincide com variância/covariância amostral', () => {
    const cov = covarianceMatrix([[1, 2], [2, 4], [3, 6]])
    expect(cov[0]?.[0]).toBeCloseTo(1, 10)
    expect(cov[0]?.[1]).toBeCloseTo(2, 10)
  })
})
