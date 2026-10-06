// Estado persistido no navegador (watchlist, buscas recentes, tema). Todo acesso ao storage é protegido:
// em janela privada ou com dados bloqueados o app continua funcionando, só sem persistência.

type Listener = () => void

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sem persistência: segue em memória */
  }
}

// ---- Watchlist (mesma chave e formato da versão anterior) ------------------

export interface WatchlistItem {
  ticker: string
  addedAt: number
}

const WATCHLIST_KEY = 'dinheirama_watchlist'
export const WATCHLIST_LIMIT = 12

const watchlistListeners = new Set<Listener>()
let watchlistCache: WatchlistItem[] | null = null

function loadWatchlist(): WatchlistItem[] {
  if (watchlistCache) return watchlistCache
  const raw = read<unknown>(WATCHLIST_KEY, [])
  watchlistCache = Array.isArray(raw)
    ? raw.filter((i): i is WatchlistItem => typeof i === 'object' && i !== null && typeof (i as WatchlistItem).ticker === 'string')
    : []
  return watchlistCache
}

function saveWatchlist(items: WatchlistItem[]): void {
  watchlistCache = items
  write(WATCHLIST_KEY, items)
  for (const fn of watchlistListeners) fn()
}

export const watchlist = {
  get: (): WatchlistItem[] => loadWatchlist(),
  has: (ticker: string): boolean => loadWatchlist().some(i => i.ticker === ticker),
  /** Adiciona no topo; passando do limite a mais antiga sai (devolvida em `dropped`). */
  add(ticker: string): { added: boolean; dropped: string | null } {
    const items = loadWatchlist()
    if (items.some(i => i.ticker === ticker)) return { added: false, dropped: null }
    const next = [{ ticker, addedAt: Date.now() }, ...items]
    const dropped = next.length > WATCHLIST_LIMIT ? (next.pop()?.ticker ?? null) : null
    saveWatchlist(next)
    return { added: true, dropped }
  },
  remove(ticker: string): void {
    saveWatchlist(loadWatchlist().filter(i => i.ticker !== ticker))
  },
  subscribe(fn: Listener): () => void {
    watchlistListeners.add(fn)
    return () => watchlistListeners.delete(fn)
  },
}

// ---- Buscas recentes -------------------------------------------------------

const RECENT_KEY = 'dinheirama_recent'
const RECENT_LIMIT = 8

export const recents = {
  get(): string[] {
    const raw = read<unknown>(RECENT_KEY, [])
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  },
  push(ticker: string): void {
    write(RECENT_KEY, [ticker, ...this.get().filter(t => t !== ticker)].slice(0, RECENT_LIMIT))
  },
}

// ---- Tema (chave "darkMode" compatível com a versão anterior) --------------

export type Theme = 'dark' | 'light'
const THEME_KEY = 'darkMode'
const themeListeners = new Set<(theme: Theme) => void>()

function savedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'true' ? 'dark' : raw === 'false' ? 'light' : null
  } catch {
    return null
  }
}

export const theme = {
  current: (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'),
  init(): void {
    const preferred = savedTheme() ?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    this.apply(preferred, false)
    // sem escolha explícita do usuário, acompanha o tema do sistema
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', event => {
      if (savedTheme() === null) this.apply(event.matches ? 'light' : 'dark', false)
    })
  },
  apply(next: Theme, persist = true): void {
    document.documentElement.setAttribute('data-theme', next)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#090b10' : '#f3f5f9')
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next === 'dark' ? 'true' : 'false')
      } catch {
        /* sem persistência */
      }
    }
    for (const fn of themeListeners) fn(next)
  },
  toggle(): Theme {
    const next: Theme = this.current() === 'dark' ? 'light' : 'dark'
    this.apply(next)
    return next
  },
  subscribe(fn: (theme: Theme) => void): void {
    themeListeners.add(fn)
  },
}
