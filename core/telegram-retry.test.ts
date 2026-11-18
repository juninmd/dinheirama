import { describe, expect, it, mock } from 'bun:test'
import { postTelegram } from './telegram-retry.ts'

const flood = (after: number) =>
  new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: after } }), { status: 429 })
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

describe('postTelegram', () => {
  it('espera retry_after e reenvia no 429', async () => {
    const fetchImpl = mock().mockResolvedValueOnce(flood(2)).mockResolvedValueOnce(ok())
    const sleep = mock(async () => {})
    const res = await postTelegram('u', { text: 'x' }, { fetchImpl: fetchImpl as never, sleep })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2250)
  })

  it('não reenvia outros erros', async () => {
    const fetchImpl = mock().mockResolvedValue(new Response('bad', { status: 400 }))
    const res = await postTelegram('u', {}, { fetchImpl: fetchImpl as never, sleep: mock(async () => {}) })
    expect(res.status).toBe(400)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('desiste após maxRetries ou espera longa demais', async () => {
    const sleep = mock(async () => {})
    const always = mock().mockImplementation(async () => flood(1))
    const res = await postTelegram('u', {}, { fetchImpl: always as never, sleep, maxRetries: 2 })
    expect(res.status).toBe(429)
    expect(always).toHaveBeenCalledTimes(3)

    const slow = mock().mockImplementation(async () => flood(600))
    await postTelegram('u', {}, { fetchImpl: slow as never, sleep })
    expect(slow).toHaveBeenCalledTimes(1)
  })
})
