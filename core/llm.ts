export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** Teto de saída por chamada. Padrão: 2048 */
  maxTokens?: number
  /** Teto de espera; ao estourar, a requisição é cancelada (não só ignorada). Padrão: 60000 */
  timeoutMs?: number
}

export interface Llm {
  generate(prompt: string): Promise<string>
}

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Every app LLM call goes through LiteLLM; cloud/auto lets the proxy pick provider and fallbacks.
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  return {
    baseUrl: env.LITELLM_BASE_URL || 'http://litellm.ai.svc.cluster.local:4000/v1',
    apiKey: env.LITELLM_API_KEY || '',
    model: env.LLM_MODEL || 'cloud/auto',
    maxTokens: positive(env.LLM_MAX_TOKENS, 2048),
    timeoutMs: positive(env.LLM_TIMEOUT_MS, 60_000),
  }
}

export function createLlm(config: LlmConfig, fetchFn: typeof fetch = fetch): Llm {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async generate(prompt) {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          // Sem teto, um modelo que se repete cobra até o limite do contexto.
          max_tokens: config.maxTokens ?? 2048,
          // Explicar números já calculados não pede raciocínio longo; o LiteLLM
          // descarta o parâmetro nos modelos que não o aceitam (drop_params).
          reasoning_effort: 'low',
        }),
        // Promise.race no chamador só parava de esperar: o fetch seguia rodando e consumindo tokens.
        signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
      })
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('LLM returned an empty completion')
      return content
    },
  }
}

/**
 * Memoriza respostas por prompt. Os prompts são montados só de números já
 * calculados (fichas de fatos), então o mesmo ticker no mesmo dia gera o mesmo
 * prompt: sem isto cada abertura de página pagava uma nova chamada. Chamadas
 * simultâneas com o mesmo prompt compartilham a mesma requisição; falhas não
 * entram no cache.
 */
export function createCachedLlm(
  llm: Llm,
  { ttlMs = 6 * 3_600_000, maxEntries = 500, now = () => Date.now() }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
): Llm {
  const cache = new Map<string, { value: string; expires: number }>()
  const inFlight = new Map<string, Promise<string>>()
  return {
    async generate(prompt) {
      const hit = cache.get(prompt)
      if (hit && hit.expires > now()) return hit.value
      if (hit) cache.delete(prompt)
      const pending = inFlight.get(prompt)
      if (pending) return pending
      const job = llm.generate(prompt).then(value => {
        cache.set(prompt, { value, expires: now() + ttlMs })
        // Map preserva ordem de inserção: o mais antigo sai primeiro.
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string)
        return value
      })
      inFlight.set(prompt, job)
      try {
        return await job
      } finally {
        inFlight.delete(prompt)
      }
    },
  }
}
