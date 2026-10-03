import { describe, expect, test } from 'bun:test'
import { createRandom } from '../monte-carlo.ts'
import { alignPanel } from './panel.ts'
import { HISTORICAL_SCENARIOS, betaShock, buildStressReport, estimateBetas, replayScenario, tailDiagnostics } from './stress.ts'
import { purgedKFold, walkForwardSelect, walkForwardSplits } from './validation.ts'
import { DEFAULT_RISK_FREE, ddmValue, dcfEquityValue, normalizedFcf, valueAsset } from './valuation.ts'
import { businessDates, syntheticFundamentals } from './test-helpers.ts'

function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

describe('validação sem vazamento', () => {
  test('purgedKFold: treino e teste não se sobrepõem; purga e embargo removem vizinhos', () => {
    const horizon = 5
    const embargo = 3
    const splits = purgedKFold(100, 5, horizon, embargo)
    expect(splits.length).toBe(5)
    for (const { train, test: testIdx } of splits) {
      const testSet = new Set(testIdx)
      expect(train.some(i => testSet.has(i))).toBe(false)
      const start = Math.min(...testIdx)
      const end = Math.max(...testIdx)
      // nenhum rótulo de treino (i..i+horizon) alcança o teste
      expect(train.some(i => i < start && i + horizon >= start)).toBe(false)
      // embargo depois do teste
      expect(train.some(i => i > end && i <= end + embargo)).toBe(false)
    }
    // o último fold não tem embargo à frente e usa todo o resto
    expect(splits[4]?.test.length).toBe(20)
  })

  test('purgedKFold valida parâmetros', () => {
    expect(() => purgedKFold(10, 1, 1, 0)).toThrow()
  })

  test('walkForwardSplits: teste sempre depois do treino, com embargo', () => {
    const splits = walkForwardSplits(1000, 400, 100, 10)
    expect(splits.length).toBeGreaterThan(3)
    for (const s of splits) {
      expect(Math.max(...s.train)).toBeLessThan(Math.min(...s.test) - 9)
    }
  })

  test('seleção entre variantes de puro ruído: ~metade dos folds fica abaixo da mediana', () => {
    const rand = createRandom(99)
    const variants: Record<string, number[]> = {}
    for (let v = 0; v < 12; v++) variants[`v${v}`] = Array.from({ length: 1800 }, () => 0.01 * gaussian(rand))
    const wf = walkForwardSelect(variants, 504, 126, 21)!
    expect(wf.folds).toBeGreaterThan(5)
    // sem edge real, o "melhor do treino" não generaliza: Sharpe OOS fica perto da média das variantes
    expect(Math.abs(wf.oosSharpe - wf.meanTrialOosSharpe)).toBeLessThan(1.2)
    expect(wf.probabilityOfOverfit).toBeGreaterThan(0.2)
  })

  test('com variante de edge real a seleção persiste e generaliza', () => {
    const rand = createRandom(5)
    const variants: Record<string, number[]> = {}
    for (let v = 0; v < 6; v++) variants[`noise${v}`] = Array.from({ length: 1800 }, () => 0.01 * gaussian(rand))
    variants.edge = Array.from({ length: 1800 }, () => 0.002 + 0.01 * gaussian(rand))
    const wf = walkForwardSelect(variants, 504, 126, 21)!
    const share = wf.chosen.filter(c => c === 'edge').length / wf.chosen.length
    expect(share).toBeGreaterThan(0.5)
    expect(wf.oosSharpe).toBeGreaterThan(wf.meanTrialOosSharpe)
  })

  test('walkForwardSelect precisa de >= 2 variantes', () => {
    expect(walkForwardSelect({ only: [0.1, 0.2] }, 1, 1)).toBeNull()
  })
})

describe('estresse e cauda', () => {
  test('caudas gordas: o VaR 99% normal subestima o histórico', () => {
    const rand = createRandom(3)
    // 98,5% dos dias calmos (vol 1%) + 1,5% de dias de crash (~ -4%): cauda esquerda pesada e assimétrica
    const returns = Array.from({ length: 6000 }, () => (rand() < 0.015 ? -0.04 + 0.005 * gaussian(rand) : 0.01 * gaussian(rand)))
    const t = tailDiagnostics(returns)
    expect(t.excessKurtosis).toBeGreaterThan(1)
    expect(t.historicalVar99).toBeLessThan(t.normalVar99)
    expect(t.normalUnderestimation99).toBeGreaterThan(1)
    expect(t.historicalCvar99).toBeLessThanOrEqual(t.historicalVar99)
    expect(t.worstWeek).toBeLessThan(0)
  })

  test('amostra pequena devolve diagnóstico neutro', () => {
    expect(tailDiagnostics([0.01, -0.01]).observations).toBe(2)
  })

  // painel diário 2008 → 2021 com queda de 40% em A e 20% em B durante a janela de 2008
  const dates = businessDates('2007-06-01', 3600)
  const f = (drop: number) => (i: number) => {
    const d = dates[i] as string
    if (d < '2008-05-20') return 100
    if (d <= '2008-10-27') return 100 * (1 - drop * (new Date(d).getTime() - new Date('2008-05-20').getTime()) / (new Date('2008-10-27').getTime() - new Date('2008-05-20').getTime()))
    return 100 * (1 - drop)
  }
  const panel = alignPanel([
    { ticker: 'A', dates, closes: dates.map((_, i) => f(0.4)(i)) },
    { ticker: 'B', dates, closes: dates.map((_, i) => f(0.2)(i)) },
    { ticker: 'NEW', dates: dates.slice(3000), closes: dates.slice(3000).map(() => 10) },
  ])
  const scenario = HISTORICAL_SCENARIOS.find(s => s.id === 'gfc-2008')!

  test('replay histórico: retorno da carteira e cobertura', () => {
    const r = replayScenario(panel, { A: 0.5, B: 0.3, NEW: 0.2 }, scenario)
    expect(r.coverage).toBeCloseTo(0.8, 8)
    expect(r.missing).toEqual(['NEW'])
    // re-normaliza entre A e B: (0.5*-0.4 + 0.3*-0.2)/0.8
    expect(r.portfolioReturn).toBeCloseTo((0.5 * -0.4 + 0.3 * -0.2) / 0.8, 2)
    expect(r.worstAsset?.ticker).toBe('A')
    expect(r.maxDrawdown).toBeLessThan(-0.2)
  })

  test('cenário fora da janela do painel retorna sem dados (sem inventar)', () => {
    const covid = HISTORICAL_SCENARIOS.find(s => s.id === 'covid-2020')!
    const short = alignPanel([{ ticker: 'A', dates: businessDates('2022-01-03', 300), closes: Array.from({ length: 300 }, () => 10) }])
    const r = replayScenario(short, { A: 1 }, covid)
    expect(r.portfolioReturn).toBeNull()
    expect(r.coverage).toBe(0)
  })

  test('choque por beta e betas estimados', () => {
    const rand = createRandom(8)
    const ds = businessDates('2020-01-01', 700)
    const bench: number[] = []
    const stock: number[] = []
    let b = 100
    let s = 50
    for (let i = 0; i < ds.length; i++) {
      const m = 0.01 * gaussian(rand)
      b *= 1 + m
      s *= 1 + 1.5 * m + 0.002 * gaussian(rand)
      bench.push(b)
      stock.push(s)
    }
    const p = alignPanel([{ ticker: 'S', dates: ds, closes: stock }])
    const betas = estimateBetas(p, bench, 600)
    expect(betas.S).toBeGreaterThan(1.3)
    expect(betas.S).toBeLessThan(1.7)
    const shock = betaShock({ S: 0.5, Z: 0.3 }, betas, -0.2)
    expect(shock.assumedBeta1).toEqual(['Z'])
    expect(shock.portfolioReturn).toBeCloseTo(0.5 * (betas.S as number) * -0.2 + 0.3 * -0.2, 8)
  })

  test('relatório completo agrega cenários, choques e cauda', () => {
    const report = buildStressReport(panel, { A: 0.5, B: 0.5 })
    expect(report.scenarios.length).toBe(HISTORICAL_SCENARIOS.length)
    expect(report.worstScenarioLoss).toBeLessThan(-0.2)
    expect(report.shocks.length).toBe(3)
  })
})

describe('valuation', () => {
  const base = { riskFree: 0.115, equityRiskPremium: 0.055, beta: 1, initialGrowth: 0.08, terminalGrowth: 0.04, years: 10 }

  test('mais crescimento => mais valor; mais custo de capital => menos valor', () => {
    const v = dcfEquityValue(100, base) as number
    expect(dcfEquityValue(100, { ...base, initialGrowth: 0.12 }) as number).toBeGreaterThan(v)
    expect(dcfEquityValue(100, { ...base, riskFree: 0.14 }) as number).toBeLessThan(v)
    expect(dcfEquityValue(200, base) as number).toBeCloseTo(2 * v, 6)
  })

  test('recusa FCF não positivo e taxa de desconto colada no crescimento terminal', () => {
    expect(dcfEquityValue(-5, base)).toBeNull()
    expect(dcfEquityValue(100, { ...base, riskFree: 0.02, equityRiskPremium: 0.01 })).toBeNull()
  })

  test('limita crescimento terminal a 4,5% (nunca cresce acima da economia para sempre)', () => {
    const a = dcfEquityValue(100, { ...base, terminalGrowth: 0.045 }) as number
    const b = dcfEquityValue(100, { ...base, terminalGrowth: 0.09 }) as number
    expect(b).toBeCloseTo(a, 8)
  })

  test('Gordon para dividendos', () => {
    expect(ddmValue(2, 0.14, 0.04)).toBeCloseTo((2 * 1.04) / 0.1, 8)
    expect(ddmValue(0, 0.14, 0.04)).toBeNull()
  })

  test('valueAsset: cenários ordenados e margem de segurança coerente com o preço', () => {
    const f = syntheticFundamentals('A', 0)
    const r = valueAsset(f)
    expect(r.method).toBe('dcf-fcfe')
    const [bear, mid, bull] = r.scenarios.map(s => s.valuePerShare as number)
    expect(bear).toBeLessThan(mid as number)
    expect(mid).toBeLessThan(bull as number)
    expect(r.marginOfSafety).toBeCloseTo(((mid as number) - (f.price as number)) / (mid as number), 8)
    expect(r.sensitivity.values.length).toBe(r.sensitivity.growths.length)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.assumptions.riskFree).toBe(DEFAULT_RISK_FREE)
  })

  test('financeiras usam desconto de dividendos; FCF negativo marca indisponível', () => {
    const bank = valueAsset({ ...syntheticFundamentals('B', 1), isFinancial: true })
    expect(bank.method).toBe('ddm')
    expect(bank.warnings.some(w => w.includes('Instituição financeira'))).toBe(true)

    const burning = valueAsset({ ...syntheticFundamentals('C', 2), freeCashFlow: -1e9, statements: [] })
    expect(burning.method).toBe('indisponivel')
    expect(burning.valuePerShare).toBeNull()
  })

  test('FCF normalizado usa média do histórico quando disponível', () => {
    const f = syntheticFundamentals('A', 0)
    const { fcf, note } = normalizedFcf(f)
    expect(fcf).not.toBeNull()
    expect(note).toBeDefined()
  })
})
