// Cliente HTTP da camada quantitativa: devolve JSON ou lança ApiError com mensagem clara em português.

export class ApiError extends Error {
  status: number
  code: string | null
  details: string[]

  constructor(message: string, status: number, code: string | null = null, details: string[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ErrorView {
  title: string
  message: string
  hint: string | null
  details: string[]
  code: string | null
}

/** Rótulos amigáveis por campo para erros de validação (zod) devolvidos pelo backend. */
export type FieldLabels = Record<string, string>

function issueLines(issues: unknown, labels: FieldLabels): string[] {
  if (!Array.isArray(issues)) return []
  return issues.slice(0, 10).map(raw => {
    const issue = (raw ?? {}) as { path?: unknown; message?: unknown }
    const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
    const label = labels[path] ?? (path || 'Dados')
    return `${label}: ${typeof issue.message === 'string' ? issue.message : 'valor inválido'}`
  })
}

function fromResponse(status: number, body: unknown, labels: FieldLabels): ApiError {
  const data = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown; issues?: unknown }
  const serverMessage = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : null
  const code = typeof data.code === 'string' ? data.code : null
  let message = serverMessage
  if (!message) {
    if (status === 404) message = 'Recurso não encontrado. O backend pode estar desatualizado ou fora do ar.'
    else if (status === 503) message = 'Serviço temporariamente indisponível.'
    else if (status >= 500) message = 'O servidor encontrou um erro ou está fora do ar.'
    else message = `Falha na requisição (HTTP ${status}).`
  }
  return new ApiError(message, status, code, issueLines(data.issues, labels))
}

export async function apiJson<T>(path: string, init: RequestInit = {}, options: { timeoutMs?: number; labels?: FieldLabels } = {}): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('Você está offline. Reconecte-se e tente novamente.', 0, 'OFFLINE')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined && init.body !== null) headers['Content-Type'] = 'application/json'

  let status = 0
  let ok = false
  let text = ''
  try {
    const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: controller.signal })
    status = res.status
    ok = res.ok
    text = await res.text()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('A requisição demorou demais e foi cancelada. Tente novamente.', 0, 'TIMEOUT')
    }
    throw new ApiError('Não foi possível conectar ao servidor. Verifique se o backend está em execução.', 0, 'NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }

  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!ok) throw fromResponse(status, body, options.labels ?? {})
  if (body === null || typeof body !== 'object') {
    throw new ApiError('Resposta inválida do servidor (era esperado JSON).', status, 'BAD_RESPONSE')
  }
  return body as T
}

/** Converte qualquer erro em texto de tela (sempre via textContent no chamador). */
export function describeError(error: unknown): ErrorView {
  if (error instanceof ApiError) {
    let title = 'Não foi possível concluir a operação'
    let hint: string | null = null
    if (error.status === 503) {
      title = 'Dados indisponíveis no momento'
      hint = 'Os dados de mercado podem estar fora do ar ou ainda carregando. Tente novamente em instantes.'
    } else if (error.status === 404) {
      title = 'Não encontrado'
    } else if (error.status === 400) {
      title = 'Dados inválidos'
    } else if (error.code === 'NETWORK_ERROR' || error.code === 'OFFLINE') {
      title = 'Sem conexão com o servidor'
    } else if (error.code === 'TIMEOUT') {
      title = 'Tempo esgotado'
    } else if (error.status >= 500) {
      title = 'Erro no servidor'
      hint = 'Tente novamente. Se persistir, consulte os logs do backend.'
    }
    return { title, message: error.message, hint, details: error.details, code: error.code }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    title: 'Não foi possível exibir os dados',
    message: `Resposta em formato inesperado (${message}).`,
    hint: 'O backend pode estar em outra versão. Atualize a página e tente novamente.',
    details: [],
    code: null,
  }
}
