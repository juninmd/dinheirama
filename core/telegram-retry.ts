// Telegram responde 429 com `parameters.retry_after` (segundos) quando o bot
// envia rápido demais. Sem esperar e reenviar, a mensagem simplesmente se perde.

export interface TelegramRetryOptions {
  maxRetries?: number
  /** Esperas maiores que isso não valem segurar o processo: desiste e mostra o 429. */
  maxWaitSeconds?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function postTelegram(url: string, body: unknown, opts: TelegramRetryOptions = {}): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3
  const maxWait = opts.maxWaitSeconds ?? 60
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status !== 429 || attempt >= maxRetries) return res
    const data = (await res.clone().json().catch(() => null)) as { parameters?: { retry_after?: number } } | null
    const wait = data?.parameters?.retry_after ?? 1
    if (wait > maxWait) return res
    console.warn(`[telegram] 429, nova tentativa em ${wait}s (${attempt + 1}/${maxRetries})`)
    await sleep(wait * 1000 + 250)
  }
}
