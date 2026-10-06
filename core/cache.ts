interface CacheEntry<T> {
  data: T
  timestamp: number
}

/**
 * Cache em memória com TTL, limite de entradas e deduplicação de cargas em andamento
 * (várias requisições simultâneas pela mesma chave compartilham uma só chamada ao provedor).
 */
export class CacheManager {
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly ttl: number

  constructor(ttlMinutes = 5, private readonly maxEntries = 500) {
    this.ttl = ttlMinutes * 60 * 1000
  }

  get size(): number {
    return this.cache.size
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }
    return entry.data as T
  }

  set<T>(key: string, data: T): void {
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) this.evict()
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  has(key: string): boolean {
    return this.get<unknown>(key) !== null
  }

  invalidate(key: string): void {
    this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Devolve o valor em cache ou executa `loader` uma única vez por chave.
   * Valores `null`/`undefined` e erros não são guardados (a próxima chamada tenta de novo).
   */
  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
    const hit = this.get<T>(key)
    if (hit !== null) return { value: hit, cached: true }

    let pending = this.inflight.get(key) as Promise<T> | undefined
    if (!pending) {
      pending = loader().then(
        value => {
          if (value !== null && value !== undefined) this.set(key, value)
          this.inflight.delete(key)
          return value
        },
        error => {
          this.inflight.delete(key)
          throw error
        }
      )
      this.inflight.set(key, pending)
    }
    return { value: await pending, cached: false }
  }

  /** Remove expirados; se ainda estiver cheio, descarta o mais antigo (ordem de inserção). */
  private evict(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) if (now - entry.timestamp > this.ttl) this.cache.delete(key)
    while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value as string)
  }
}

/** Executa `fn` sobre os itens com no máximo `limit` chamadas simultâneas (janela deslizante, preserva a ordem). */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}
