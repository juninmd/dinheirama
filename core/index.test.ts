import { beforeAll, describe, expect, mock, test } from 'bun:test'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

// Yahoo falso: conta chamadas para provar lote de cotações, barras únicas por ticker e cache.
const calls = { batchQuote: 0, singleQuote: 0, charts: [] as Array<{ symbol: string; period1: string }> }
const DAY = 864e5
const bars = Array.from({ length: 420 }, (_, i) => {
  const close = 20 + Math.sin(i / 9) * 3 + i * 0.01
  return { date: new Date(Date.now() - (419 - i) * DAY), close, adjclose: close, volume: 1_000_000 + i }
})
const fakeQuote = (symbol: string) => ({ symbol, regularMarketPrice: 25, regularMarketChangePercent: 1.2, regularMarketVolume: 2_000_000 })

class FakeYahoo {
  async quote(query: string | string[]) {
    if (Array.isArray(query)) {
      calls.batchQuote++
      return query.map(fakeQuote)
    }
    calls.singleQuote++
    return fakeQuote(query)
  }
  async chart(symbol: string, options: { period1: string }) {
    calls.charts.push({ symbol, period1: options.period1 })
    return { quotes: bars }
  }
  async quoteSummary() { throw new Error('sem fundamentos no teste') }
}
mock.module('yahoo-finance2', () => ({ default: FakeYahoo }))

let mod: typeof import('./index.ts')

beforeAll(async () => {
  process.env.QUANT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dinheirama-index-'))
  process.env.ALERTS_DIR = process.env.QUANT_DATA_DIR
  globalThis.fetch = (async () => new Response('[]', { status: 500 })) as unknown as typeof fetch
  mod = await import('./index.ts')
})

const barCharts = () => calls.charts.filter(c => Math.abs((Date.now() - Date.parse(c.period1)) / DAY - 365) < 2)

describe('index: caches e lote', () => {
  test('radar busca cotações em lote, 1 gráfico por ticker e serve o 2º pedido do cache', async () => {
    const first = await mod.buildPortfolio()
    expect(first.portfolio.length).toBeGreaterThan(20)
    expect(first.monteCarlo).not.toBeNull()
    expect(calls.batchQuote).toBe(1)
    expect(calls.singleQuote).toBe(0)
    expect(barCharts().length).toBe(first.portfolio.length)

    const before = { ...calls, charts: calls.charts.length }
    const second = await mod.buildPortfolio()
    expect(second).toBe(first)
    expect(calls.batchQuote).toBe(before.batchQuote)
    expect(calls.charts.length).toBe(before.charts)
  })

  test('snapshots simultâneos do mesmo ativo compartilham uma execução e respeitam o nome do chamador', async () => {
    const asset = { ticker: 'ZZZZ3.SA', name: 'Zeta', assetClass: 'stock' as const, thesis: 't' }
    const before = calls.singleQuote
    const [a, b] = await Promise.all([mod.buildAssetSnapshot(asset), mod.buildAssetSnapshot({ ...asset, name: 'Outro' })])
    expect(calls.singleQuote).toBe(before + 1)
    expect(a?.name).toBe('Zeta')
    expect(b?.name).toBe('Outro')
    expect(a?.rsi).not.toBeNull()
  })

  test('API: quote cacheado, validação de ticker e história sem espalhar array', async () => {
    const app = mod.default
    const bad = await app.fetch(new Request('http://x/api/quote/xx'))
    expect(bad.status).toBe(400)
    const q1 = await (await app.fetch(new Request('http://x/api/quote/PETR4.SA'))).json() as Record<string, unknown>
    const q2 = await (await app.fetch(new Request('http://x/api/quote/PETR4.SA'))).json() as Record<string, unknown>
    expect(q1.cached).toBeUndefined()
    expect(q2.cached).toBe(true)
    expect(q2.regularMarketPrice).toBe(25)
  })

  test('análise: corpo cacheado e 404 para ativo sem cotação', async () => {
    const app = mod.default
    const post = (ticker: string) => app.fetch(new Request('http://x/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker }),
    }))
    const r1 = await post('WEGE3.SA')
    expect(r1.status).toBe(200)
    const a1 = await r1.json() as { ticker: string; timestamp: string; analysis: string }
    const a2 = await (await post('WEGE3.SA')).json() as { timestamp: string }
    expect(a1.ticker).toBe('WEGE3.SA')
    expect(a2.timestamp).toBe(a1.timestamp)
    expect(a1.analysis.length).toBeGreaterThan(20)
  })
})

describe('index: compressão', () => {
  test('rotas quant e da API principal respondem comprimidas quando o JSON é grande', async () => {
    const app = mod.default
    const res = await app.fetch(new Request('http://x/api/portfolio/montecarlo?sims=200', { headers: { 'Accept-Encoding': 'gzip' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const factors = await app.fetch(new Request('http://x/api/factors', { headers: { 'Accept-Encoding': 'gzip' } }))
    expect(factors.status).toBe(200)
    expect(factors.headers.get('content-encoding')).toBe('gzip')
  })
})
