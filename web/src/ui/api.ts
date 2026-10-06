// Chamadas à API com repetição para falhas de rede (mantém o comportamento da versão anterior: 2 novas tentativas).

import { ApiError, apiJson } from '../research-api'

export { ApiError, apiJson }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function api<T>(path: string, init: RequestInit = {}, options: { timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const retries = options.retries ?? 2
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiJson<T>(path, init, { timeoutMs: options.timeoutMs })
    } catch (error) {
      lastError = error
      // só repete quando o servidor nem respondeu; erros de negócio (4xx/5xx) voltam direto para a tela
      const transient = error instanceof ApiError && error.code === 'NETWORK_ERROR'
      if (!transient || attempt === retries) break
      await sleep(800 * 2 ** attempt)
    }
  }
  throw lastError
}

export const post = <T>(path: string, body?: unknown, options?: { timeoutMs?: number; retries?: number }): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, options)
