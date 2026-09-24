export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface Llm {
  generate(prompt: string): Promise<string>
}

// Every app LLM call goes through LiteLLM; cloud/auto lets the proxy pick provider and fallbacks.
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  return {
    baseUrl: env.LITELLM_BASE_URL || 'http://litellm.ai.svc.cluster.local:4000/v1',
    apiKey: env.LITELLM_API_KEY || '',
    model: env.LLM_MODEL || 'cloud/auto',
  }
}

export function createLlm(config: LlmConfig, fetchFn: typeof fetch = fetch): Llm {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async generate(prompt) {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }] }),
      })
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const content = data.choices?.[0]?.message?.content?.trim()
      if (!content) throw new Error('LLM returned an empty completion')
      return content
    },
  }
}
