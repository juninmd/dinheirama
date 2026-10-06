import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Hono } from 'hono'
import { BENCHMARK_TICKER, createYahooMarketData, loadPanel, parseBcbDaily, parseChartQuotes } from './data.ts'
import type { FundamentalsHistory } from './fundamentals.ts'
import { Journal } from './journal.ts'
import { IpsStore, createJournalLookup, registerQuantRoutes } from './routes.ts'
import { createQuantService } from './service.ts'
import { DEFAULT_SYNTH_ASSETS, syntheticMarketData } from './test-helpers.ts'
import type { UniverseAsset } from './universe.ts'

const universe: UniverseAsset[] = DEFAULT_SYNTH_ASSETS.map((a, i) => ({
  ticker: a.ticker, name: a.ticker, assetClass: 'stock', thesis: 't', sector: `S${i % 3}`, isFinancial: false,
}))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup(opts: Parameters<typeof syntheticMarketData>[0] = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-'))
  dirs.push(dir)
  const data = syntheticMarketData(opts)
  let pit: FundamentalsHistory | null = null
  const service = createQuantService({ data, universe, riskFreeAnnual: 0.1, getPit: () => pit })
  const app = new Hono()
  registerQuantRoutes(app, {
    service, data, journal: new Journal(path.join(dir, 'journal.json')), ipsStore: new IpsStore(path.join(dir, 'ips.json')),
    riskFreeAnnual: 0.1, dataDir: dir, onPitChange: h => { pit = h }, log: () => undefined,
  })
  const get = async (url: string) => {
    const res = await app.request(url)
    return { status: res.status, body: (await res.json()) as any }
  }
  const send = async (method: string, url: string, body?: unknown, raw = false) => {
    const res = await app.request(url, { method, headers: raw ? {} : { 'Content-Type': 'application/json' }, body: raw ? (body as string) : body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { app, get, send, data, dir }
}

describe('parsers de dados', () => {
  test('parseChartQuotes prefere o fechamento ajustado e ignora linhas sem data', () => {
    const s = parseChartQuotes('A', [
      { date: new Date('2024-01-02T13:00:00Z'), close: 10, adjclose: 9.5, volume: 100 },
      { date: null, close: 1 },
      { date: new Date('2024-01-03T13:00:00Z'), close: 11 },
    ])!
    expect(s.dates).toEqual(['2024-01-02', '2024-01-03'])
    // com fechamento ajustado na série, linha sem ajuste vira lacuna (misturar criaria um salto falso)
    expect(s.closes).toEqual([9.5, null])
    // sem nenhum ajustado, usa o fechamento comum
    expect(parseChartQuotes('A', [{ date: new Date('2024-01-02T13:00:00Z'), close: 10 }, { date: new Date('2024-01-03T13:00:00Z'), close: 11 }])!.closes).toEqual([10, 11])
    // linha com data inválida é descartada sem derrubar o ticker
    expect(parseChartQuotes('A', [{ date: 'xx', close: 1 }, { date: new Date('2024-01-02T13:00:00Z'), close: 2 }])!.dates).toEqual(['2024-01-02'])
    expect(parseChartQuotes('A', [])).toBeNull()
  })

  test('parseBcbDaily converte % ao dia em fração e ignora lixo', () => {
    const m = parseBcbDaily([{ data: '02/01/2024', valor: '0.043739' }, { data: 'x', valor: '1' }, { data: '03/01/2024', valor: 'abc' }, { data: '04/01/2024', valor: '' }, { data: '05/01/2024', valor: null }])
    expect(m.size).toBe(1) // vazio/nulo não vira CDI de 0%
    expect(m.get('2024-01-02')).toBeCloseTo(0.00043739, 10)
    expect(parseBcbDaily('nope').size).toBe(0)
  })

  test('createYahooMarketData: cache, falha silenciosa e CDI via fetch injetado', async () => {
    let calls = 0
    const yahoo = {
      chart: async (symbol: string) => {
        calls++
        if (symbol === 'BAD.SA') throw new Error('x')
        return { quotes: [{ date: new Date('2024-01-02T13:00:00Z'), close: 10, adjclose: 10, volume: 1 }] }
      },
      quoteSummary: async () => ({ financialData: { currentPrice: 10 }, summaryDetail: { marketCap: 1e9 } }),
    }
    const fetchFn = (async () => new Response(JSON.stringify([{ data: '02/01/2024', valor: '0.04' }]))) as unknown as typeof fetch
    const md = createYahooMarketData(yahoo, { fetchFn })
    expect((await md.priceSeries('A.SA', 1))?.closes).toEqual([10])
    await md.priceSeries('A.SA', 1)
    expect(calls).toBe(1)
    expect(await md.priceSeries('BAD.SA', 1)).toBeNull()
    expect((await md.cdiDaily(2))?.get('2024-01-02')).toBeCloseTo(0.0004, 10)
    expect((await md.fundamentals('A.SA'))?.price).toBe(10)
    expect(BENCHMARK_TICKER).toBe('^BVSP')
  })

  test('loadPanel alinha universo, benchmark e CDI; usa fallback constante sem BCB', async () => {
    const data = syntheticMarketData({ days: 600 })
    const loaded = (await loadPanel(data, DEFAULT_SYNTH_ASSETS.map(a => a.ticker).concat('SEM.DADO'), 2, 0.1))!
    expect(loaded.missing).toEqual(['SEM.DADO'])
    expect(loaded.benchmark?.length).toBe(loaded.panel.dates.length)
    expect(loaded.cdiSource).toBe('bcb')

    const noCdi = (await loadPanel(syntheticMarketData({ days: 600, withCdi: false }), ['AAAA3.SA', 'BBBB3.SA'], 2, 0.1))!
    expect(noCdi.cdiSource).toBe('constant')
    expect(noCdi.cdiDaily).toBeUndefined()
    expect(await loadPanel(data, ['AAAA3.SA'], 2, 0.1)).toBeNull()
  })
})

describe('cache de fatores', () => {
  test('falta de dados de mercado não dispara uma rajada de requisições a cada chamada', async () => {
    const base = syntheticMarketData({ assets: [] })
    let calls = 0
    const data = { ...base, priceSeries: async () => { calls++; return null } }
    const service = createQuantService({ data, universe, riskFreeAnnual: 0.1 })
    expect(await service.getFactorTable()).toBeNull()
    const afterFirst = calls
    expect(afterFirst).toBe(universe.length)
    await Promise.all([service.getFactorTable(), service.getFactorTable()])
    expect(calls).toBe(afterFirst)
  })

  test('chamadas simultâneas compartilham a mesma construção', async () => {
    const base = syntheticMarketData()
    let calls = 0
    const data = { ...base, priceSeries: async (t: string, y: number) => { calls++; return base.priceSeries(t, y) } }
    const service = createQuantService({ data, universe, riskFreeAnnual: 0.1 })
    const [a, b] = await Promise.all([service.getFactorTable(), service.getFactorTable()])
    expect(a).toBe(b)
    expect(calls).toBe(universe.length)
  })
})

describe('rotas quantitativas', () => {
  test('GET /api/factors devolve ranking completo com fundamentos', async () => {
    const { get } = setup()
    const { status, body } = await get('/api/factors')
    expect(status).toBe(200)
    expect(body.rows.length).toBe(DEFAULT_SYNTH_ASSETS.length)
    expect(body.withFundamentals).toBe(DEFAULT_SYNTH_ASSETS.length)
    const scores = body.rows.map((r: any) => r.score)
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a))
    expect(body.rows[0].groups.value).not.toBeNull()
    expect(body.notes.length).toBeGreaterThan(0)
  })

  test('GET /api/factors sem dados responde 503 em vez de inventar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-'))
    dirs.push(dir)
    const empty = syntheticMarketData({ assets: [] })
    const service = createQuantService({ data: empty, universe, riskFreeAnnual: 0.1 })
    const app = new Hono()
    registerQuantRoutes(app, { service, data: empty, journal: new Journal(null), ipsStore: new IpsStore(null), riskFreeAnnual: 0.1, dataDir: dir, log: () => undefined })
    expect((await app.request('/api/factors')).status).toBe(503)
    expect((await app.request('/api/backtest')).status).toBe(503)
    expect((await app.request('/api/portfolio/construct')).status).toBe(503)
  })

  test('GET /api/backtest compara estratégias, mostra bruto vs líquido, ressalvas e robustez', async () => {
    const { get } = setup()
    const { status, body } = await get('/api/backtest?years=4&topN=3')
    expect(status).toBe(200)
    expect(body.results.length).toBeGreaterThanOrEqual(5)
    const names = body.results.map((r: any) => r.strategy)
    expect(names).toContain('equal-weight')
    expect(names).toContain('multifactor-3')
    expect(names.some((n: string) => n.startsWith('legacy-rsi'))).toBe(true)
    const r = body.results[0]
    expect(r.series).toBeUndefined()
    expect(r.net.cagr).toBeDefined()
    expect(r.gross.cagr).toBeDefined()
    expect(r.benchmark.name).toContain('Ibovespa')
    expect(body.caveats.join(' ')).toContain('sobrevivência')
    expect(body.caveats.join(' ')).toContain('NÃO entram')
    expect(body.trialsCounted).toBeGreaterThan(body.results.length)
    expect(body.cdiSource).toBe('bcb')
    for (const res of body.results) expect(res.deflatedSharpe).toBeGreaterThanOrEqual(0)
  })

  test('backtest sem benchmark avisa e omite a comparação relativa', async () => {
    const { get } = setup({ withBenchmark: false, withCdi: false })
    const { body } = await get('/api/backtest?years=4&topN=3&costs=0&tax=0')
    expect(body.benchmark).toBeNull()
    expect(body.cdiSource).toBe('constant')
    expect(body.caveats.join(' ')).toContain('Benchmark')
    expect(body.results[0].relative).toBeUndefined()
    expect(body.results[0].totalCosts).toBe(0)
    expect(body.results[0].totalTax).toBe(0)
  })

  test('GET /api/portfolio/construct: HRP com diagnósticos e setores', async () => {
    const { get } = setup()
    const { status, body } = await get('/api/portfolio/construct?method=hrp&maxWeight=0.3&maxSector=0.6')
    expect(status).toBe(200)
    const total = body.construction.weights.reduce((a: number, w: any) => a + w.weight, 0)
    expect(total).toBeGreaterThan(0.98)
    expect(total).toBeLessThan(1.02)
    expect(Math.max(...body.construction.weights.map((w: any) => w.weight))).toBeLessThanOrEqual(0.3 + 1e-3)
    expect(body.construction.diagnostics.covarianceShrinkage).toBeGreaterThanOrEqual(0)
    expect(body.sectors.length).toBeGreaterThan(0)
    expect(body.stress).toBeNull()
  })

  test('construct com stress=1 inclui cauda e cenários (sem cobertura histórica => sem dado)', async () => {
    const { get } = setup()
    const { body } = await get('/api/portfolio/construct?method=erc&stress=1')
    expect(body.stress.tail.observations).toBeGreaterThan(100)
    expect(body.stress.shocks.length).toBe(3)
    expect(body.stress.scenarios.length).toBeGreaterThan(0)
  })

  test('IPS: PUT valida, persiste e passa a guiar a construção e a checagem de aderência', async () => {
    const { get, send } = setup()
    const bad = await send('PUT', '/api/ips', { objective: 'moon' })
    expect(bad.status).toBe(400)

    const ok = await send('PUT', '/api/ips', {
      objective: 'preservation', horizonYears: 8, maxDrawdownTolerance: 0.2, capital: 50_000, emergencyFundMonths: 6, maxPositionWeight: 0.25, maxSectorWeight: 0.5,
    })
    expect(ok.status).toBe(200)
    expect(ok.body.constraints.method).toBe('minvar')

    const got = await get('/api/ips')
    expect(got.body.ips.objective).toBe('preservation')

    const built = await get('/api/portfolio/construct?stress=1')
    expect(built.body.construction.method).toBe('minvar') // método vem do IPS
    expect(built.body.ips.constraints.maxEquityShare).toBeLessThanOrEqual(0.3)
    expect(built.body.ips.checks.length).toBe(4)

    await send('DELETE', '/api/ips')
    expect((await get('/api/ips')).body.ips).toBeNull()
  })

  test('valuation: DCF por ticker e validação de formato', async () => {
    const { get } = setup()
    const ok = await get('/api/valuation/AAAA3.SA')
    expect(ok.status).toBe(200)
    expect(ok.body.method).toBe('dcf-fcfe')
    expect(ok.body.scenarios.length).toBe(3)
    expect((await get('/api/valuation/xx')).status).toBe(400)
    expect((await get('/api/valuation/ZZZZ3.SA')).status).toBe(404)
  })

  test('diário: cria, valida, resolve com preços e calibra', async () => {
    const { get, send, data } = setup()
    const last = data.dates[data.dates.length - 1] as string
    // cria uma previsão no passado (entrada 300 dias úteis antes do fim), horizonte 30 dias
    const px = (await data.priceSeries('AAAA3.SA', 10))!
    const idx = px.dates.length - 300
    const entryPrice = px.closes[idx] as number

    const invalid = await send('POST', '/api/journal', { ticker: 'AAAA3.SA', action: 'buy', probability: 1, horizonDays: 30, entryPrice })
    expect(invalid.status).toBe(400)

    const created = await send('POST', '/api/journal', { ticker: 'AAAA3.SA', action: 'buy', probability: 0.7, horizonDays: 30, entryPrice })
    expect(created.status).toBe(201)
    expect(created.body.status).toBe('open')

    // a previsão acima nasce "agora"; para exercitar a resolução com preços usamos o lookup com datas passadas
    const lookup = createJournalLookup(data, 0.1)
    const entry = { ...created.body, createdAt: `${px.dates[idx]}T12:00:00.000Z`, dueAt: `${px.dates[idx + 30]}T12:00:00.000Z` }
    const resolution = await lookup(entry, new Date(`${last}T12:00:00Z`))
    expect(resolution).not.toBeNull()
    expect(resolution!.exitPrice).toBeCloseTo(px.closes[idx + 30] as number, 8)
    expect(resolution!.referenceReturn).not.toBeNaN()

    const cal = await get('/api/journal/calibration')
    expect(cal.body.open).toBe(1)
    expect(cal.body.warnings.length).toBeGreaterThan(0)

    const resolved = await send('POST', '/api/journal/resolve')
    expect(resolved.body.resolved).toBe(0) // ainda não venceu no relógio real

    expect((await send('DELETE', `/api/journal/${created.body.id}`)).status).toBe(200)
    expect((await send('DELETE', '/api/journal/xxx')).status).toBe(404)
  })

  test('CSV ponto-no-tempo: rejeita sem availableAt e passa a alimentar o backtest', async () => {
    const { get, send } = setup()
    const bad = await send('PUT', '/api/fundamentals/pit', 'ticker,asOf\nA,2024-01-01', true)
    expect(bad.status).toBe(400)

    const rows = ['ticker,asOf,availableAt,trailingPE,priceToBook,roe,dividendYield,freeCashFlow,marketCap']
    for (const [i, a] of DEFAULT_SYNTH_ASSETS.entries()) {
      for (const year of [2017, 2018, 2019, 2020, 2021, 2022]) {
        rows.push(`${a.ticker},${year - 1}-12-31,${year}-03-31,${6 + i * 2},${0.8 + i * 0.3},${0.22 - i * 0.02},${0.07 - i * 0.008},1000000000,10000000000`)
      }
    }
    const ok = await send('PUT', '/api/fundamentals/pit', rows.join('\n'), true)
    expect(ok.status).toBe(200)
    expect(ok.body.tickers).toBe(DEFAULT_SYNTH_ASSETS.length)
    expect((await get('/api/fundamentals/pit')).body.loaded).toBe(true)

    const { body } = await get('/api/backtest?years=4&topN=3')
    expect(body.caveats.join(' ')).not.toContain('NÃO entram')
  })
})

describe('createYahooMarketData: downloads compartilhados', () => {
  const day = (offsetDays: number) => new Date(Date.now() - offsetDays * 864e5)
  const bars = Array.from({ length: 400 }, (_, i) => ({ date: day(399 - i), close: 10 + i, adjclose: 10 + i, volume: 1 }))

  test('pedidos simultâneos e períodos menores reaproveitam o mesmo download', async () => {
    let calls = 0
    const yahoo = {
      chart: async () => {
        calls++
        await Bun.sleep(5)
        return { quotes: bars }
      },
      quoteSummary: async () => ({}),
    }
    const md = createYahooMarketData(yahoo)
    const [a, b] = await Promise.all([md.priceSeries('A.SA', 2), md.priceSeries('A.SA', 2)])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    const short = await md.priceSeries('A.SA', 1)
    expect(calls).toBe(1)
    expect(short!.dates.length).toBeLessThan(a!.dates.length)
    expect(short!.dates.length).toBeGreaterThan(300)
    expect(short!.dates[0]! >= new Date(Date.now() - 366 * 864e5).toISOString().slice(0, 10)).toBe(true)
    await md.priceSeries('A.SA', 5) // período maior que o em cache exige novo download
    expect(calls).toBe(2)
  })

  test('falha é lembrada por pouco tempo e depois tenta de novo', async () => {
    let calls = 0
    const yahoo = {
      chart: async () => { calls++; throw new Error('429') },
      quoteSummary: async () => { calls++; throw new Error('429') },
    }
    const md = createYahooMarketData(yahoo, { failureTtlMs: 30 })
    expect(await md.priceSeries('X.SA', 1)).toBeNull()
    expect(await md.priceSeries('X.SA', 1)).toBeNull()
    expect(await md.fundamentals('X.SA')).toBeNull()
    expect(await md.fundamentals('X.SA')).toBeNull()
    expect(calls).toBe(2)
    await Bun.sleep(40)
    expect(await md.priceSeries('X.SA', 1)).toBeNull()
    expect(calls).toBe(3)
  })
})
