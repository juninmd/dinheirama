// Roteador por hash (#/analisar/PETR4.SA?x=1): funciona em qualquer servidor estático e respeita voltar/avançar.

export interface Route {
  id: string
  segments: string[]
  query: URLSearchParams
}

export function parseRoute(hash: string = location.hash): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path = '', queryString = ''] = raw.split('?')
  const parts = path.split('/').filter(Boolean).map(part => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  return { id: parts[0] ?? 'inicio', segments: parts.slice(1), query: new URLSearchParams(queryString) }
}

export function pathFor(id: string, segments: string[] = [], query?: Record<string, string>): string {
  const base = `#/${[id, ...segments.map(encodeURIComponent)].join('/')}`
  const qs = query ? new URLSearchParams(query).toString() : ''
  return qs ? `${base}?${qs}` : base
}

export const hrefAnalyze = (ticker: string): string => pathFor('analisar', [ticker])
export const hrefNews = (ticker: string): string => pathFor('noticias', [ticker])
export const hrefAlert = (ticker: string): string => pathFor('alertas', [], { ticker })

export function navigate(path: string): void {
  if (location.hash === path) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else location.hash = path
}

export interface View {
  el: HTMLElement
  /** Chamado a cada visita (a view é montada uma vez e reaproveitada: o estado sobrevive à navegação). */
  show(route: Route): void
  hide?(): void
}
