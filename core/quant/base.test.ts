import { describe, expect, test } from 'bun:test'
import { CostBasisBook, checkLiquidity, monthlySwingTax, tradeCostRate } from './costs.ts'
import { benchmarkRelative, computeMetrics, deflatedSharpe, equityFromReturns, maxDrawdownOf, probabilisticSharpe } from './metrics.ts'
import { alignPanel, averageDollarVolume, monthStartIndexes } from './panel.ts'
import { correlation, excessKurtosis, normalCdf, normalInv, ols, percentileRanks, quantile, skewness, stdDev, winsorize, zScores } from './stats.ts'
import { businessDates } from './test-helpers.ts'

describe('stats', () => {
  test('normalInv é a inversa de normalCdf', () => {
    for (const p of [0.001, 0.05, 0.3, 0.5, 0.9, 0.999]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 4)
    }
    expect(normalInv(0.975)).toBeCloseTo(1.95996, 3)
  })

  test('zScores mantém dado ausente como null e padroniza o resto', () => {
    const z = zScores([1, 2, 3, 4, null, 5, 6, 7, 8, 9, 10], 0)
    expect(z[4]).toBeNull()
    const valid = z.filter((v): v is number => v !== null)
    expect(valid.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6)
    expect(stdDev(valid)).toBeCloseTo(1, 6)
  })

  test('zScores retorna tudo null com poucos dados', () => {
    expect(zScores([1, 2, null]).every(v => v === null)).toBe(true)
  })

  test('winsorize limita outliers', () => {
    const w = winsorize([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000], 0.1, 0.9)
    expect(Math.max(...w)).toBeLessThan(1000)
  })

  test('percentileRanks: maior valor = 100 e empates recebem posto médio', () => {
    const r = percentileRanks([10, 20, 20, 30, null])
    expect(r[3]).toBe(100)
    expect(r[0]).toBe(0)
    expect(r[1]).toBe(r[2])
    expect(r[4]).toBeNull()
  })

  test('ols recupera alfa e beta', () => {
    const x = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 0.02)
    const y = x.map(v => 0.001 + 1.5 * v)
    const fit = ols(y, x)
    expect(fit.beta).toBeCloseTo(1.5, 6)
    expect(fit.alpha).toBeCloseTo(0.001, 6)
    expect(fit.r2).toBeCloseTo(1, 6)
  })

  test('assimetria e curtose de dados simétricos', () => {
    const data = [-3, -2, -1, 0, 1, 2, 3]
    expect(skewness(data)).toBeCloseTo(0, 6)
    expect(excessKurtosis(data)).toBeLessThan(0)
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 8)
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  })
})

describe('panel', () => {
  test('alignPanel preenche lacunas curtas mas nunca para trás', () => {
    const panel = alignPanel([
      { ticker: 'A', dates: ['2024-01-02', '2024-01-05', '2024-01-08'], closes: [10, 11, 12] },
      { ticker: 'B', dates: ['2024-01-03', '2024-01-04', '2024-01-05'], closes: [5, 6, 7] },
    ])
    expect(panel.dates).toEqual(['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'])
    expect(panel.close.A).toEqual([10, 10, 10, 11, 12])
    // B só existe a partir do dia 03: nada de preenchimento para trás (look-ahead)
    expect(panel.close.B).toEqual([null, 5, 6, 7, 7])
  })

  test('limita o preenchimento a maxFillDays', () => {
    const panel = alignPanel(
      [
        { ticker: 'A', dates: ['2024-01-02'], closes: [10] },
        { ticker: 'B', dates: ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'], closes: [1, 1, 1, 1, 1] },
      ],
      2
    )
    expect(panel.close.A).toEqual([10, 10, 10, null, null])
  })

  test('monthStartIndexes e ADV', () => {
    const dates = businessDates('2024-01-29', 12)
    const idx = monthStartIndexes(dates)
    expect(idx[0]).toBe(0)
    expect(dates[idx[1] as number]!.startsWith('2024-02')).toBe(true)
    const panel = alignPanel([{ ticker: 'A', dates, closes: dates.map(() => 10), volumes: dates.map(() => 1000) }])
    expect(averageDollarVolume(panel, 'A', 11, 10)).toBe(10000)
    expect(averageDollarVolume(panel, 'A', 3, 60)).toBeNull() // amostra insuficiente
  })
})

describe('custos e IR', () => {
  test('custo de ordem cresce com a participação no volume', () => {
    const small = tradeCostRate(10_000, 10_000_000)
    const big = tradeCostRate(1_000_000, 10_000_000)
    expect(big).toBeGreaterThan(small)
    expect(small).toBeGreaterThan(0.000325)
  })

  test('liquidez: recusa ordem acima de 10% do ADV e sem dado', () => {
    expect(checkLiquidity(50_000, 1_000_000).ok).toBe(true)
    expect(checkLiquidity(200_000, 1_000_000).ok).toBe(false)
    expect(checkLiquidity(1000, null).ok).toBe(false)
  })

  test('IR swing: isento até R$ 20 mil em vendas', () => {
    const r = monthlySwingTax({ sales: 19_000, realizedPnl: 5_000 }, 0)
    expect(r.tax).toBe(0)
    expect(r.exempt).toBe(true)
  })

  test('IR swing: 15% sobre o lucro acima da isenção e compensação de prejuízo', () => {
    const profit = monthlySwingTax({ sales: 50_000, realizedPnl: 10_000 }, 0)
    expect(profit.tax).toBeCloseTo(1500, 6)

    const loss = monthlySwingTax({ sales: 50_000, realizedPnl: -4_000 }, 1_000)
    expect(loss.tax).toBe(0)
    expect(loss.lossCarryAfter).toBe(5_000)

    const offset = monthlySwingTax({ sales: 50_000, realizedPnl: 10_000 }, 4_000)
    expect(offset.tax).toBeCloseTo(900, 6)
    expect(offset.lossCarryAfter).toBe(0)
  })

  test('custo médio: lucro realizado considera preço médio e taxas', () => {
    const book = new CostBasisBook()
    book.buy('A', 100, 10, 0)
    book.buy('A', 100, 20, 0)
    expect(book.quantity('A')).toBe(200)
    const pnl = book.sell('A', 100, 30, 5) // custo médio 15
    expect(pnl).toBeCloseTo(100 * 15 - 5, 6)
    expect(book.quantity('A')).toBe(100)
  })
})

describe('métricas', () => {
  test('retorno constante: CAGR, drawdown nulo e Sharpe sobre CDI', () => {
    const daily = 0.0004
    const returns = Array.from({ length: 252 }, () => daily)
    const m = computeMetrics(returns, 0.0003)
    expect(m.cagr).toBeCloseTo((1 + daily) ** 252 - 1, 6)
    expect(m.maxDrawdown).toBe(0)
    expect(m.annVol).toBeCloseTo(0, 8)
  })

  test('drawdown máximo', () => {
    expect(maxDrawdownOf(equityFromReturns([0.1, -0.2, 0.05, -0.1]))).toBeCloseTo(0.8316 / 1.1 - 1, 6)
    expect(maxDrawdownOf([1, 2, 1, 3, 1.5])).toBeCloseTo(-0.5, 8)
  })

  test('PSR aumenta com o tamanho da amostra e DSR é menor que PSR com muitas tentativas', () => {
    const base = Array.from({ length: 250 }, (_, i) => 0.0006 + 0.01 * Math.sin(i * 1.7))
    const long = [...base, ...base, ...base, ...base]
    expect(probabilisticSharpe(long)).toBeGreaterThan(probabilisticSharpe(base))

    const psr = probabilisticSharpe(base)
    const trials = Array.from({ length: 50 }, (_, i) => 0.01 + 0.004 * Math.sin(i))
    expect(deflatedSharpe(base, trials)).toBeLessThan(psr)
    expect(deflatedSharpe(base, [0.05])).toBeCloseTo(psr, 8)
  })

  test('alfa/beta contra benchmark', () => {
    const bench = Array.from({ length: 300 }, (_, i) => 0.01 * Math.sin(i * 0.9))
    const strat = bench.map(b => 0.0002 + 0.8 * b)
    const rel = benchmarkRelative(strat, bench, 0)
    expect(rel.beta).toBeCloseTo(0.8, 6)
    expect(rel.alphaAnnual).toBeCloseTo(0.0002 * 252, 4)
  })
})
