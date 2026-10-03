import { describe, expect, test } from 'bun:test'
import { createRandom } from '../monte-carlo.ts'
import {
  blackLittermanPosterior,
  constructPortfolio,
  factorViews,
  impliedEquilibriumReturns,
  invertMatrix,
  ledoitWolfCovariance,
  meanVarianceShrunk,
  portfolioVariance,
} from './portfolio.ts'
import { DEFAULT_DIVIDEND_RULES, DEFAULT_TAX_RULES, type Trade, computeTaxReport, dividendNet, jcpNet } from './tax.ts'
import { probabilityOfBacktestOverfitting } from './validation.ts'

function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

describe('IR: calculadora de operações', () => {
  const buy = (date: string, ticker: string, qty: number, price: number, extra: Partial<Trade> = {}): Trade => ({ date, ticker, side: 'buy', qty, price, ...extra })
  const sell = (date: string, ticker: string, qty: number, price: number, extra: Partial<Trade> = {}): Trade => ({ date, ticker, side: 'sell', qty, price, ...extra })

  test('swing de ações: isento até R$ 20 mil em vendas, mesmo com lucro', () => {
    const r = computeTaxReport([buy('2024-01-02', 'A', 100, 100), sell('2024-02-05', 'A', 100, 150)]) // vende R$ 15 mil
    const feb = r.months.find(m => m.month === '2024-02')!
    expect(feb.swingAcoes.pnl).toBeCloseTo(5000, 6)
    expect(feb.swingAcoes.exemptGain).toBeCloseTo(5000, 6)
    expect(feb.totalTax).toBe(0)
  })

  test('swing de ações acima de R$ 20 mil: 15% sobre o lucro', () => {
    const r = computeTaxReport([buy('2024-01-02', 'A', 1000, 100), sell('2024-02-05', 'A', 1000, 130)]) // vende R$ 130 mil, lucro 30 mil
    const feb = r.months.find(m => m.month === '2024-02')!
    expect(feb.swingAcoes.tax).toBeCloseTo(4500, 6)
    expect(feb.irrfWithheld).toBeCloseTo(130_000 * 0.00005, 6)
    expect(feb.darfDue).toBeCloseTo(4500 - 6.5, 6)
  })

  test('prejuízo de um mês compensa o lucro do seguinte (mesma cesta)', () => {
    const r = computeTaxReport([
      buy('2024-01-02', 'A', 1000, 100), sell('2024-01-20', 'A', 1000, 90), // -10 mil
      buy('2024-02-02', 'B', 1000, 100), sell('2024-02-20', 'B', 1000, 130), // +30 mil
    ])
    const feb = r.months.find(m => m.month === '2024-02')!
    expect(feb.swingAcoes.taxable).toBeCloseTo(20_000, 6)
    expect(feb.swingAcoes.tax).toBeCloseTo(3000, 6)
    expect(feb.swingAcoes.lossCarryAfter).toBe(0)
  })

  test('day trade: 20%, sem isenção, IRRF de 1% sobre o ganho e prejuízo em cesta própria', () => {
    const r = computeTaxReport([
      buy('2024-03-04', 'A', 100, 10), sell('2024-03-04', 'A', 100, 12), // +200
    ])
    const m = r.months[0]!
    expect(m.dayTrade.pnl).toBeCloseTo(200, 6)
    expect(m.dayTrade.tax).toBeCloseTo(40, 6)
    expect(m.irrfWithheld).toBeCloseTo(2, 6)
    expect(m.darfDue).toBeCloseTo(38, 6)

    // prejuízo de day trade não abate lucro de swing
    const mix = computeTaxReport([
      buy('2024-04-02', 'A', 1000, 100), sell('2024-04-03', 'A', 1000, 130), // swing +30 mil
      buy('2024-04-05', 'B', 100, 50), sell('2024-04-05', 'B', 100, 40), // day trade -1000
    ])
    const apr = mix.months[0]!
    expect(apr.dayTrade.pnl).toBeCloseTo(-1000, 6)
    expect(apr.swingAcoes.tax).toBeCloseTo(4500, 6)
  })

  test('quantidade casada no dia é day trade e o excedente segue como swing pelo custo médio', () => {
    const r = computeTaxReport([
      buy('2024-01-02', 'A', 1000, 10), // posição de swing
      buy('2024-05-06', 'A', 500, 20), sell('2024-05-06', 'A', 1500, 30), // casa 500 (day trade), vende 1000 da posição
    ])
    const may = r.months.find(m => m.month === '2024-05')!
    expect(may.dayTrade.pnl).toBeCloseTo(500 * (30 - 20), 6)
    expect(may.swingAcoes.pnl).toBeCloseTo(1000 * (30 - 10), 6)
    expect(r.positions).toEqual([])
  })

  test('ETF não tem isenção e FII paga 20% em cesta separada', () => {
    const etf = computeTaxReport([buy('2024-01-02', 'BOVA11', 100, 100, { kind: 'etf' }), sell('2024-02-02', 'BOVA11', 100, 120, { kind: 'etf' })])
    expect(etf.months[1]!.swingEtf.tax).toBeCloseTo(300, 6) // 15% de 2 mil, apesar de vender só R$ 12 mil

    const fii = computeTaxReport([buy('2024-01-02', 'XPLG11', 100, 100, { kind: 'fii' }), sell('2024-02-02', 'XPLG11', 100, 120, { kind: 'fii' })])
    expect(fii.months[1]!.fii.tax).toBeCloseTo(400, 6)
  })

  test('DARF abaixo de R$ 10 acumula para o mês seguinte', () => {
    const r = computeTaxReport([
      buy('2024-01-02', 'BOVA11', 100, 100, { kind: 'etf' }), sell('2024-01-10', 'BOVA11', 100, 100.5, { kind: 'etf' }), // lucro 50 => 7,5 de IR (menos IRRF)
      buy('2024-02-02', 'BOVA11', 100, 100, { kind: 'etf' }), sell('2024-02-10', 'BOVA11', 100, 120, { kind: 'etf' }),
    ])
    expect(r.months[0]!.darfDue).toBe(0)
    expect(r.months[1]!.darfDue).toBeGreaterThan(290)
  })

  test('venda acima da posição gera aviso e operações inválidas são ignoradas', () => {
    const r = computeTaxReport([sell('2024-01-02', 'A', 100, 10), buy('2024-01-03', 'A', -1, 10)])
    expect(r.warnings.length).toBe(2)
    expect(r.totalTax).toBe(0)
  })

  test('JCP e dividendos', () => {
    expect(jcpNet(1000).net).toBeCloseTo(850, 8)
    expect(dividendNet(40_000).withheld).toBe(0)
    expect(dividendNet(60_000).withheld).toBeCloseTo(6000, 8)
    expect(DEFAULT_DIVIDEND_RULES.highDividendMonthlyThreshold).toBe(50_000)
    expect(DEFAULT_TAX_RULES.swingMonthlyExemption).toBe(20_000)
  })
})

describe('PBO por CSCV', () => {
  test('ruído puro: PBO médio entre amostras fica perto de 50% e há degradação dentro→fora da amostra', () => {
    // numa única amostra o PBO de ruído puro oscila muito (≈0,25 a ≈0,9); a expectativa é ~0,5
    const pbos: number[] = []
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = createRandom(seed)
      const variants: Record<string, number[]> = {}
      for (let v = 0; v < 20; v++) variants[`v${v}`] = Array.from({ length: 1200 }, () => 0.01 * gaussian(rand))
      const r = probabilityOfBacktestOverfitting(variants, 12)!
      expect(r.combinations).toBe(924)
      expect(r.meanIsSharpe).toBeGreaterThan(r.meanOosSharpe)
      expect(Object.values(r.selectionShare).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8)
      pbos.push(r.pbo)
    }
    const avg = pbos.reduce((a, b) => a + b, 0) / pbos.length
    expect(avg).toBeGreaterThan(0.3)
    expect(avg).toBeLessThan(0.7)
  })

  test('uma variante com edge real: PBO baixo', () => {
    const rand = createRandom(2)
    const variants: Record<string, number[]> = {}
    for (let v = 0; v < 8; v++) variants[`noise${v}`] = Array.from({ length: 1600 }, () => 0.01 * gaussian(rand))
    variants.edge = Array.from({ length: 1600 }, () => 0.0025 + 0.01 * gaussian(rand))
    const r = probabilityOfBacktestOverfitting(variants, 16)!
    expect(r.combinations).toBe(12870)
    expect(r.pbo).toBeLessThan(0.15)
    expect(r.selectionShare.edge).toBeGreaterThan(0.8)
    expect(r.probOosLoss).toBeLessThan(0.1)
  })

  test('entradas insuficientes retornam null', () => {
    expect(probabilityOfBacktestOverfitting({ a: [1, 2, 3] })).toBeNull()
    expect(probabilityOfBacktestOverfitting({ a: Array(20).fill(0.1), b: Array(20).fill(0.2) }, 16)).toBeNull()
  })
})

describe('Black-Litterman', () => {
  const rand = createRandom(4)
  const vols = [0.012, 0.015, 0.018, 0.010]
  const rows = Array.from({ length: 800 }, () => {
    const m = gaussian(rand)
    return vols.map(v => v * (0.6 * m + 0.8 * gaussian(rand)))
  })
  const { cov } = ledoitWolfCovariance(rows)
  const market = [0.4, 0.3, 0.2, 0.1]

  test('inversa de matriz e detecção de singularidade', () => {
    const inv = invertMatrix([[4, 7], [2, 6]])!
    expect(inv[0]![0]).toBeCloseTo(0.6, 10)
    expect(inv[0]![1]).toBeCloseTo(-0.7, 10)
    expect(invertMatrix([[1, 2], [2, 4]])).toBeNull()
  })

  test('sem visões, a carteira ótima reproduz os pesos de mercado (propriedade central do modelo)', () => {
    const pi = impliedEquilibriumReturns(cov, market, 2.5)
    const w = meanVarianceShrunk(pi, cov, 2.5, 1, 20000)
    market.forEach((m, i) => expect(w[i]).toBeCloseTo(m, 2))
  })

  test('uma visão positiva aumenta o retorno esperado e o peso do ativo; confiança maior desvia mais', () => {
    const pi = impliedEquilibriumReturns(cov, market, 2.5)
    const view = (confidence: number) => [{ p: [0, 0, 1, 0], q: (pi[2] as number) + 0.0004, confidence }]
    const low = blackLittermanPosterior(cov, market, view(0.1))!
    const high = blackLittermanPosterior(cov, market, view(0.9))!
    expect(low.posteriorMean[2]).toBeGreaterThan(pi[2] as number)
    expect(high.posteriorMean[2]).toBeGreaterThan(low.posteriorMean[2] as number)
    expect(high.posteriorMean[2]).toBeLessThanOrEqual((pi[2] as number) + 0.0004 + 1e-12)
    const wLow = meanVarianceShrunk(low.posteriorMean, low.posteriorCov, 2.5, 1, 20000)
    const wHigh = meanVarianceShrunk(high.posteriorMean, high.posteriorCov, 2.5, 1, 20000)
    expect(wLow[2]).toBeGreaterThan(market[2] as number)
    expect(wHigh[2]).toBeGreaterThan(wLow[2] as number)
  })

  test('visão com confiança ~1 fixa o posterior quase no valor da visão', () => {
    const pi = impliedEquilibriumReturns(cov, market, 2.5)
    const q = (pi[1] as number) + 0.001
    const r = blackLittermanPosterior(cov, market, [{ p: [0, 1, 0, 0], q, confidence: 0.99 }], 1)!
    expect(Math.abs((r.posteriorMean[1] as number) - q)).toBeLessThan(Math.abs(0.001) * 0.1)
  })

  test('visões de fator: z positivo => q acima do equilíbrio, nulos não geram visão', () => {
    const pi = impliedEquilibriumReturns(cov, market, 2.5)
    const variances = cov.map((r, i) => r[i] as number)
    const views = factorViews([1.5, -1, null, 0], variances, pi, { ic: 0.05, confidence: 0.3 })
    expect(views.length).toBe(3)
    expect(views[0]!.q).toBeGreaterThan(pi[0] as number)
    expect(views[1]!.q).toBeLessThan(pi[1] as number)
    expect(views[2]!.q).toBeCloseTo(pi[3] as number, 12)
  })

  test('constructPortfolio(bl): pesos válidos, tetos respeitados e diagnósticos do modelo', () => {
    const tickers = ['A', 'B', 'C', 'D']
    const result = constructPortfolio({
      tickers, returns: rows, sectors: ['X', 'X', 'Y', 'Z'], method: 'bl', maxWeight: 0.5, maxSector: 0.8,
      marketWeights: market, factorScores: [1.2, 0.3, -0.8, null], blIc: 0.05, blConfidence: 0.4,
    })!
    const total = result.weights.reduce((a, w) => a + w.weight, 0)
    expect(total).toBeGreaterThan(0.99)
    expect(total).toBeLessThan(1.01)
    expect(Math.max(...result.weights.map(w => w.weight))).toBeLessThanOrEqual(0.5 + 1e-3)
    expect(result.blackLitterman?.views).toBe(3)
    expect(result.blackLitterman?.marketWeightsSource).toBe('capitalizacao')
    const a = result.blackLitterman!.assets.find(x => x.ticker === 'A')!
    expect(a.posteriorAnnual).toBeGreaterThan(a.equilibriumAnnual)
    const c = result.blackLitterman!.assets.find(x => x.ticker === 'C')!
    expect(c.posteriorAnnual).toBeLessThan(c.equilibriumAnnual)
  })

  test('sem capitalização usa pesos iguais e avisa a origem', () => {
    const r = constructPortfolio({ tickers: ['A', 'B', 'C', 'D'], returns: rows, method: 'bl', maxWeight: 0.5, maxSector: 1, marketWeights: null })!
    expect(r.blackLitterman?.marketWeightsSource).toBe('igual')
    expect(r.blackLitterman?.views).toBe(0)
    expect(portfolioVariance([0.25, 0.25, 0.25, 0.25], cov)).toBeGreaterThan(0)
  })
})

describe('IR: compensação entre ações e ETFs e IRRF de day trade (correções da revisão)', () => {
  const buy = (date: string, ticker: string, qty: number, price: number, extra: Partial<Trade> = {}): Trade => ({ date, ticker, side: 'buy', qty, price, ...extra })
  const sell = (date: string, ticker: string, qty: number, price: number, extra: Partial<Trade> = {}): Trade => ({ date, ticker, side: 'sell', qty, price, ...extra })

  const gainAcao = [buy('2024-01-02', 'A', 1000, 100), sell('2024-02-05', 'A', 1000, 120)] // vende R$ 120 mil, lucro 20 mil
  const lossEtf = [buy('2024-01-03', 'BOVA11', 1000, 100, { kind: 'etf' as const }), sell('2024-02-06', 'BOVA11', 1000, 90, { kind: 'etf' as const })] // -10 mil

  test('prejuízo de ETF abate lucro de ações no mesmo mês, em qualquer ordem das operações', () => {
    const a = computeTaxReport([...gainAcao, ...lossEtf]).months.find(m => m.month === '2024-02')!
    const b = computeTaxReport([...lossEtf, ...gainAcao]).months.find(m => m.month === '2024-02')!
    expect(a.totalTax).toBeCloseTo(1500, 6) // 15% de (20 mil − 10 mil)
    expect(b.totalTax).toBeCloseTo(a.totalTax, 8)
  })

  test('ganho de ações isento não é abatido por prejuízo de ETF; o prejuízo vai para o saldo', () => {
    const small = [buy('2024-01-02', 'A', 100, 100), sell('2024-02-05', 'A', 100, 150)] // vende R$ 15 mil: isento
    const r = computeTaxReport([...small, ...lossEtf])
    const feb = r.months.find(m => m.month === '2024-02')!
    expect(feb.swingAcoes.exemptGain).toBeCloseTo(5000, 6)
    expect(feb.totalTax).toBe(0)
    expect(feb.swingEtf.lossCarryAfter).toBeCloseTo(10_000, 6)
  })

  test('IRRF de day trade incide sobre o resultado líquido do dia', () => {
    const r = computeTaxReport([
      buy('2024-03-04', 'A', 100, 10), sell('2024-03-04', 'A', 100, 20), // +1000
      buy('2024-03-04', 'B', 100, 20), sell('2024-03-04', 'B', 100, 10), // -1000
    ])
    expect(r.months[0]!.irrfWithheld).toBe(0)
    expect(r.months[0]!.dayTrade.pnl).toBeCloseTo(0, 8)

    const gain = computeTaxReport([buy('2024-03-04', 'A', 100, 10), sell('2024-03-04', 'A', 100, 20), buy('2024-03-04', 'B', 100, 20), sell('2024-03-04', 'B', 100, 19)])
    expect(gain.months[0]!.irrfWithheld).toBeCloseTo(900 * 0.01, 8)
  })
})
