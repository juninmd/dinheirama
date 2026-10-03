import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FACTOR_WEIGHTS,
  classifyRiskByVol,
  magicFormulaRanks,
  priceFactors,
  rsi,
  scoreUniverse,
  signalFromScore,
} from './factors.ts'
import {
  FundamentalsHistory,
  deriveMetrics,
  grahamDefensive,
  grahamMarginOfSafety,
  grahamNumber,
  num,
  parseFundamentalsCsv,
  parseYahooFundamentals,
  piotroskiFScore,
} from './fundamentals.ts'
import { syntheticFundamentals } from './test-helpers.ts'

describe('parse Yahoo', () => {
  const summary = {
    financialData: { currentPrice: 40, returnOnEquity: 0.2, totalDebt: 5e9, totalCash: 2e9, ebitda: 3e9, freeCashflow: 1e9, debtToEquity: 85, currentRatio: 1.5, operatingMargins: 0.25, revenueGrowth: 0.1 },
    defaultKeyStatistics: { trailingEps: 4, bookValue: 20, priceToBook: 2, enterpriseValue: { raw: 30e9 }, beta: 1.1 },
    summaryDetail: { marketCap: 20e9, trailingPE: 10, dividendYield: 0.05 },
  }
  const series = [
    { date: new Date('2024-12-31'), annualTotalRevenue: 10e9, annualNetIncome: 2e9, annualEBIT: 3e9, annualTotalAssets: 20e9, annualOperatingCashFlow: 2.5e9, annualCapitalExpenditure: -1e9 },
    { date: new Date('2023-12-31'), annualTotalRevenue: 9e9, annualNetIncome: 1.5e9 },
  ]

  test('extrai campos, aceita {raw} e prefixos annual*', () => {
    const f = parseYahooFundamentals('XXXX3.SA', summary, series, { asOf: '2025-01-10' })
    expect(f.price).toBe(40)
    expect(f.enterpriseValue).toBe(30e9)
    expect(f.netDebt).toBe(3e9)
    expect(f.debtToEquity).toBeCloseTo(0.85, 8)
    expect(f.statements[0]?.endDate).toBe('2024-12-31')
    expect(f.statements[0]?.ebit).toBe(3e9)
    expect(f.statements[0]?.capex).toBe(1e9) // capex vem negativo no Yahoo
    expect(f.ebit).toBe(3e9)
  })

  test('é defensivo com respostas vazias ou malformadas', () => {
    const f = parseYahooFundamentals('YYYY3.SA', null, undefined)
    expect(f.price).toBeNull()
    expect(f.statements).toEqual([])
    expect(num('abc')).toBeNull()
    expect(num(NaN)).toBeNull()
    expect(num({ raw: 3 })).toBe(3)
  })
})

describe('Graham, Piotroski e métricas', () => {
  test('número de Graham e margem de segurança', () => {
    expect(grahamNumber(4, 25)).toBeCloseTo(Math.sqrt(22.5 * 4 * 25), 8)
    expect(grahamNumber(-1, 25)).toBeNull()
    const f = syntheticFundamentals('A', 0)
    const gn = grahamNumber(f.eps, f.bookValuePerShare) as number
    expect(grahamMarginOfSafety(f)).toBeCloseTo((gn - (f.price as number)) / gn, 8)
  })

  test('Graham defensivo conta só critérios com dado', () => {
    const f = { ...syntheticFundamentals('A', 0), currentRatio: null }
    const result = grahamDefensive(f)
    expect(result.evaluated).toBeLessThan(result.total)
    expect(result.criteria.find(c => c.name.startsWith('Liquidez'))?.passed).toBeNull()
    expect(result.passed).toBeLessThanOrEqual(result.evaluated)
  })

  test('Piotroski: empresa em melhora pontua alto e piora derruba', () => {
    const good = syntheticFundamentals('A', 0)
    const score = piotroskiFScore(good)!
    expect(score.score).toBeGreaterThanOrEqual(7)

    const worse = {
      ...good,
      statements: [
        { ...good.statements[0]!, netIncome: -1e9, operatingCashFlow: -0.5e9, longTermDebt: 8e9, currentAssets: 3e9, sharesOutstanding: 600e6, grossProfit: 2e9 },
        good.statements[1]!,
      ],
    }
    expect(piotroskiFScore(worse)!.score).toBeLessThan(score.score)
  })

  test('Piotroski retorna null com dados insuficientes', () => {
    expect(piotroskiFScore({ ...syntheticFundamentals('A', 0), statements: [] })).toBeNull()
  })

  test('bancos não usam EV/EBIT nem FCF', () => {
    const bank = { ...syntheticFundamentals('B', 1), isFinancial: true }
    const d = deriveMetrics(bank)
    expect(d.fcfYield).toBeNull()
    expect(d.roic).toBeNull()
    expect(d.netDebtToEbitda).toBeNull()
    expect(d.earningsYield).toBeCloseTo(1 / (bank.trailingPE as number), 8)
  })
})

describe('fundamentos ponto-no-tempo', () => {
  const csv = [
    'ticker;asOf;availableAt;trailingPE;roe',
    'AAAA3.SA;2023-12-31;2024-03-15;8,5;0,2',
    'AAAA3.SA;2024-03-31;2024-05-14;7,0;0,25',
    'AAAA3.SA;2024-06-30;;6,0;0,3',
  ].join('\n')

  test('rejeita linha sem availableAt e lê números com vírgula', () => {
    const { rows, rejected } = parseFundamentalsCsv(csv)
    expect(rows.length).toBe(2)
    expect(rejected).toBe(1)
    expect(rows[0]?.trailingPE).toBe(8.5)
  })

  test('só devolve o que já era público na data (sem look-ahead)', () => {
    const history = new FundamentalsHistory(parseFundamentalsCsv(csv).rows)
    expect(history.asOf('AAAA3.SA', '2024-03-01')).toBeNull()
    expect(history.asOf('AAAA3.SA', '2024-04-01')?.trailingPE).toBe(8.5)
    expect(history.asOf('AAAA3.SA', '2024-05-14')?.trailingPE).toBe(7)
  })

  test('exige cabeçalho com availableAt', () => {
    expect(() => parseFundamentalsCsv('ticker,asOf\nA,2024-01-01')).toThrow()
  })
})

describe('fatores de preço', () => {
  const series = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.001 * i + 0.01 * Math.sin(i / 3)))

  test('não usa dados futuros: alterar preços após t não muda o fator em t', () => {
    const t = 300
    const before = priceFactors(series, t)
    const mutated = series.map((v, i) => (i > t ? v * 5 : v))
    expect(priceFactors(mutated, t)).toEqual(before)
  })

  test('momentum 12-1 pula o último mês', () => {
    const t = 300
    const f = priceFactors(series, t)
    expect(f.momentum12_1).toBeCloseTo((series[t - 21] as number) / (series[t - 252] as number) - 1, 10)
    expect(f.return1m).toBeCloseTo((series[t] as number) / (series[t - 21] as number) - 1, 10)
  })

  test('histórico curto resulta em fatores nulos', () => {
    const f = priceFactors(series.slice(0, 100), 99)
    expect(f.momentum12_1).toBeNull()
  })

  test('RSI de Wilder: série só de altas = 100', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1))).toBe(100)
  })
})

describe('score multifator', () => {
  const mk = (ticker: string, momentum: number, vol: number, i: number) => ({
    ticker,
    price: { momentum12_1: momentum, momentum6_1: momentum / 2, return1m: 0, vol, proximity52w: 0.8 + momentum / 10, drawdown: -0.1, rsi14: 50 },
    fundamentals: syntheticFundamentals(ticker, i),
  })
  const inputs = Array.from({ length: 10 }, (_, i) => mk(`T${i}`, 0.5 - i * 0.07, 0.2 + i * 0.03, i))

  test('o melhor em todos os fatores fica no topo e o pior no fundo', () => {
    const scores = scoreUniverse(inputs, { riskFree12m: 0.1 })
    expect(scores[0]?.score).toBe(100)
    expect(scores[9]?.score).toBe(0)
    expect(scores[0]?.coverage).toBe(1)
    expect(scores[0]?.trendOk).toBe(true)
    expect(scores[9]?.trendOk).toBe(false) // momentum 12-1 negativo < CDI
  })

  test('sem fundamentos usa só momentum e baixa vol (pesos renormalizados)', () => {
    const noFund = inputs.map(i => ({ ...i, fundamentals: null }))
    const scores = scoreUniverse(noFund)
    expect(scores[0]?.coverage).toBe(0.5)
    expect(scores[0]?.groups.value).toBeNull()
    expect(scores[0]?.score).toBe(100)
  })

  test('exige ao menos dois grupos com dado', () => {
    const onlyVol = inputs.map(i => ({ ticker: i.ticker, price: { ...i.price, momentum12_1: null, proximity52w: null }, fundamentals: null }))
    expect(scoreUniverse(onlyVol).every(s => s.score === null)).toBe(true)
  })

  test('pesos padrão são 1/N e somam 1', () => {
    const w = DEFAULT_FACTOR_WEIGHTS
    expect(w.value + w.quality + w.momentum + w.lowVol).toBeCloseTo(1, 10)
  })

  test('Magic Formula: menor soma de postos = posição 1', () => {
    const ranks = magicFormulaRanks([
      { ey: 0.2, roic: 0.3 },
      { ey: 0.1, roic: 0.1 },
      { ey: 0.15, roic: 0.2 },
      { ey: null, roic: 0.5 },
    ])
    expect(ranks[0]).toBe(1)
    expect(ranks[1]).toBe(3)
    expect(ranks[3]).toBeNull()
  })

  test('sinal: quintil superior só vira buy com tendência absoluta positiva', () => {
    expect(signalFromScore(90, true)).toBe('buy')
    expect(signalFromScore(90, false)).toBe('hold')
    expect(signalFromScore(10, true)).toBe('sell')
    expect(signalFromScore(50, true)).toBe('hold')
    expect(signalFromScore(null, null)).toBe('hold')
  })

  test('risco por volatilidade', () => {
    expect(classifyRiskByVol(0.2, -0.05)).toBe('low')
    expect(classifyRiskByVol(0.35, -0.05)).toBe('medium')
    expect(classifyRiskByVol(0.5, -0.05)).toBe('high')
    expect(classifyRiskByVol(0.2, -0.45)).toBe('high')
    expect(classifyRiskByVol(null, null)).toBe('medium')
  })
})

describe('datas do Yahoo sem validação', () => {
  test('aceita Date, segundos Unix e {raw}', () => {
    const rows = [
      { date: new Date('2024-12-31T00:00:00Z'), annualTotalRevenue: 1 },
      { date: 1703980800, annualTotalRevenue: 2 }, // 2023-12-31
      { date: { raw: 1672444800 }, annualTotalRevenue: 3 }, // 2022-12-31
    ]
    const f = parseYahooFundamentals('A', null, rows)
    expect(f.statements.map(s => s.endDate)).toEqual(['2024-12-31', '2023-12-31', '2022-12-31'])
  })
})
