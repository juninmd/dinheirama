import { describe, expect, test } from 'bun:test'
import { createBrapiQuoteSource, isBrapiTicker, parseBrapiQuote, toBrapiTicker } from './brapi.ts'

const payload = {
  results: [
    {
      symbol: 'PETR4',
      shortName: 'PETR4',
      longName: 'Petroleo Brasileiro SA Pfd',
      currency: 'BRL',
      regularMarketPrice: 50.54,
      regularMarketChange: -2.17,
      regularMarketChangePercent: -4.12,
      regularMarketPreviousClose: 52.71,
      regularMarketTime: '2026-11-03T18:59:30Z',
    },
  ],
}

describe('ticker do brapi', () => {
  test('remove o sufixo .SA e normaliza a caixa', () => {
    expect(toBrapiTicker('petr4.sa')).toBe('PETR4')
    expect(toBrapiTicker(' HGLG11.SA ')).toBe('HGLG11')
    expect(toBrapiTicker('VALE3')).toBe('VALE3')
  })

  test('aceita ação e FII e recusa cripto, índice e lixo', () => {
    expect(isBrapiTicker('PETR4.SA')).toBe(true)
    expect(isBrapiTicker('BPAC11')).toBe(true)
    expect(isBrapiTicker('HGLG11.SA')).toBe(true)
    expect(isBrapiTicker('BTC-USD')).toBe(false)
    expect(isBrapiTicker('^BVSP')).toBe(false)
    expect(isBrapiTicker('PETR4.US')).toBe(false)
  })
})

describe('parseBrapiQuote', () => {
  test('mapeia a resposta para o formato do Yahoo mantendo o ticker original', () => {
    const quote = parseBrapiQuote('PETR4.SA', payload)
    expect(quote).toEqual({
      symbol: 'PETR4.SA',
      shortName: 'PETR4',
      longName: 'Petroleo Brasileiro SA Pfd',
      currency: 'BRL',
      regularMarketPrice: 50.54,
      regularMarketChange: -2.17,
      regularMarketChangePercent: -4.12,
      regularMarketPreviousClose: 52.71,
      regularMarketTime: '2026-11-03T18:59:30Z',
      source: 'brapi',
    })
  })

  test('preenche moeda e nome quando a API não manda', () => {
    const quote = parseBrapiQuote('vale3.sa', { results: [{ regularMarketPrice: 60.59 }] })
    expect(quote?.currency).toBe('BRL')
    expect(quote?.shortName).toBe('VALE3')
    expect(quote?.symbol).toBe('VALE3.SA')
    expect(quote?.regularMarketChange).toBeNull()
    expect(quote?.longName).toBeUndefined()
  })

  test('sem resultado ou sem preço válido não vira zero', () => {
    expect(parseBrapiQuote('PETR4.SA', { results: [] })).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', {})).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', null)).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', { results: [{ regularMarketPrice: 0 }] })).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', { results: [{ regularMarketPrice: -1 }] })).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', { results: [{ regularMarketPrice: '50' }] })).toBeNull()
    expect(parseBrapiQuote('PETR4.SA', { results: [{ regularMarketPrice: Number.NaN }] })).toBeNull()
  })
})

describe('createBrapiQuoteSource', () => {
  test('chama a API com token quando configurado', async () => {
    let requested = ''
    const source = createBrapiQuoteSource({
      token: 'abc123',
      fetchFn: (async (input: any) => {
        requested = String(input)
        return new Response(JSON.stringify(payload), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const quote = await source('PETR4.SA')
    expect(quote?.regularMarketPrice).toBe(50.54)
    expect(requested).toContain('/api/quote/PETR4')
    expect(requested).toContain('token=abc123')
    expect(requested).not.toContain('.SA')
  })

  test('não tenta o provedor para tickers que ele não cobre', async () => {
    let calls = 0
    const source = createBrapiQuoteSource({
      fetchFn: (async () => {
        calls++
        return new Response('{}', { status: 200 })
      }) as typeof fetch,
    })
    expect(await source('BTC-USD')).toBeNull()
    expect(await source('^BVSP')).toBeNull()
    expect(calls).toBe(0)
  })

  test('resposta de erro devolve null e reporta, sem lançar', async () => {
    const errors: string[] = []
    const source = createBrapiQuoteSource({
      fetchFn: (async () => new Response('{"error":true,"message":"token required"}', { status: 401 })) as typeof fetch,
      onError: message => errors.push(message),
    })
    expect(await source('HGLG11.SA')).toBeNull()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('401')
  })

  test('falha de rede ou JSON inválido devolve null', async () => {
    const errors: string[] = []
    const offline = createBrapiQuoteSource({
      fetchFn: (async () => {
        throw new Error('ECONNRESET')
      }) as typeof fetch,
      onError: message => errors.push(message),
    })
    expect(await offline('PETR4.SA')).toBeNull()
    expect(errors[0]).toContain('ECONNRESET')

    const broken = createBrapiQuoteSource({
      fetchFn: (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    })
    expect(await broken('PETR4.SA')).toBeNull()
  })
})
