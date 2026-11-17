import { describe, expect, test } from 'bun:test'
import { createCachedLlm, createLlm, llmConfigFromEnv } from './llm'

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('llm', () => {
  test('defaults route through LiteLLM with cloud/auto', () => {
    const cfg = llmConfigFromEnv({})
    expect(cfg.baseUrl).toBe('http://litellm.ai.svc.cluster.local:4000/v1')
    expect(cfg.model).toBe('cloud/auto')
  })

  test('posts an OpenAI-compatible chat completion with the app key', async () => {
    const { fn, calls } = fakeFetch(200, { choices: [{ message: { content: 'ok' } }] })
    const llm = createLlm({ baseUrl: 'http://proxy/v1/', apiKey: 'sk-app', model: 'cloud/auto' }, fn)

    expect(await llm.generate('prompt')).toBe('ok')
    const call = calls[0]!
    expect(call.url).toBe('http://proxy/v1/chat/completions')
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-app')
    const sent = JSON.parse(call.init.body as string)
    expect(sent.model).toBe('cloud/auto')
    expect(sent.messages).toEqual([{ role: 'user', content: 'prompt' }])
  })

  test('rejects on upstream error so callers fall back', async () => {
    const { fn } = fakeFetch(429, { error: { message: 'limit' } })
    const llm = createLlm({ baseUrl: 'http://proxy/v1', apiKey: 'k', model: 'cloud/auto' }, fn)
    await expect(llm.generate('p')).rejects.toThrow('LLM HTTP 429')
  })

  test('rejects an empty completion instead of returning blank analysis', async () => {
    const { fn } = fakeFetch(200, { choices: [{ message: { content: '  ' } }] })
    const llm = createLlm({ baseUrl: 'http://proxy/v1', apiKey: 'k', model: 'cloud/auto' }, fn)
    await expect(llm.generate('p')).rejects.toThrow('empty completion')
  })
})

describe('llm limits and cache', () => {
  test('sends max_tokens, low reasoning effort and an abort signal', async () => {
    const { fn, calls } = fakeFetch(200, { choices: [{ message: { content: 'ok' } }] })
    await createLlm(llmConfigFromEnv({ LLM_MAX_TOKENS: '900' }), fn).generate('p')
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent.max_tokens).toBe(900)
    expect(sent.reasoning_effort).toBe('low')
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  test('cached llm calls upstream once per prompt until the ttl expires', async () => {
    let calls = 0
    let clock = 0
    const inner = { generate: async (p: string) => `r${++calls}:${p}` }
    const llm = createCachedLlm(inner, { ttlMs: 100, now: () => clock })
    const [a, b] = await Promise.all([llm.generate('x'), llm.generate('x')])
    expect([a, b, calls]).toEqual(['r1:x', 'r1:x', 1])
    expect(await llm.generate('x')).toBe('r1:x')
    clock = 101
    expect(await llm.generate('x')).toBe('r2:x')
  })

  test('failures are not cached', async () => {
    let fail = true
    const llm = createCachedLlm({ generate: async () => { if (fail) throw new Error('down'); return 'ok' } })
    await expect(llm.generate('x')).rejects.toThrow('down')
    fail = false
    expect(await llm.generate('x')).toBe('ok')
  })
})
