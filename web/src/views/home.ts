import { h } from '../research-dom'
import { NAV } from '../nav'
import { hrefAnalyze, navigate, pathFor, type Route, type View } from '../router'
import { recents, watchlist } from '../store'
import type { IntegrationStatus, QuoteResponse } from '../types'
import { api } from '../ui/api'
import { chipRow, emptyState, pill, sectionTitle, skeleton, tickerInput } from '../ui/components'
import { POPULAR, companyName, fmtChange, fmtPrice, isNum, isValidTicker, shortTicker, signTone, toTicker } from '../ui/format'
import { icon } from '../ui/icons'

interface QuoteState {
  price: number | null
  change: number | null
  name: string | null
  failed: boolean
  at: number
}

const QUOTE_TTL = 5 * 60_000
const quotes = new Map<string, QuoteState>()

async function loadQuote(ticker: string, force = false): Promise<QuoteState> {
  const hit = quotes.get(ticker)
  if (hit && !force && !hit.failed && Date.now() - hit.at < QUOTE_TTL) return hit
  try {
    const q = await api<QuoteResponse>(`/api/quote/${encodeURIComponent(ticker)}`, {}, { timeoutMs: 20_000, retries: 1 })
    const state: QuoteState = {
      price: isNum(q.regularMarketPrice) ? q.regularMarketPrice : null,
      change: isNum(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null,
      name: q.shortName ?? q.longName ?? null,
      failed: false,
      at: Date.now(),
    }
    quotes.set(ticker, state)
    return state
  } catch {
    const state: QuoteState = { price: null, change: null, name: null, failed: true, at: Date.now() }
    quotes.set(ticker, state)
    return state
  }
}

const EXPLORE_IDS = ['radar', 'simulacao', 'quant', 'noticias', 'treino', 'alertas']

export function createHomeView(): View {
  const el = h('div', { class: 'view-stack' })

  // ---- Hero com busca ------------------------------------------------------
  const input = tickerInput({ id: 'home-ticker', label: 'Código da ação', placeholder: 'Código da ação, ex.: PETR4' })
  const hint = h('p', { class: 'field-hint', role: 'status' })
  const form = h('form', { class: 'search-bar search-bar-lg', novalidate: true }, input, h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, icon('search', 20), 'Analisar'))
  const shortcuts = h('div', { class: 'shortcuts' })
  form.addEventListener('submit', event => {
    event.preventDefault()
    const ticker = toTicker(input.value)
    hint.textContent = ''
    if (!ticker || !isValidTicker(ticker)) {
      hint.textContent = ticker ? 'Código inválido. Use o formato da B3, como PETR4 ou VALE3.' : 'Digite o código de uma ação para começar.'
      input.focus()
      return
    }
    input.value = ''
    navigate(hrefAnalyze(ticker))
  })

  const hero = h(
    'section',
    { class: 'hero card', 'aria-labelledby': 'hero-title' },
    h('p', { class: 'eyebrow' }, 'Radar 24h da B3'),
    h('h1', { class: 'hero-title view-title', id: 'hero-title', tabindex: -1 }, 'Entenda uma ação em segundos'),
    h('p', { class: 'hero-text' }, 'Score quantitativo, RSI, notícias e papers num só lugar — com as limitações sempre à vista. Projeto pessoal e educacional.'),
    form,
    hint,
    shortcuts
  )

  // ---- Watchlist -----------------------------------------------------------
  const watchHost = h('div', { class: 'watch-list' })
  const refreshBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Atualizar cotações', 'aria-label': 'Atualizar cotações', onClick: () => renderWatchlist(true) }, icon('refresh', 18))
  const watchCard = h('section', { class: 'card', 'aria-labelledby': 'watch-title' }, h('div', { class: 'section-title' }, h('h2', { id: 'watch-title' }, 'Minha watchlist'), refreshBtn), watchHost)

  function row(ticker: string): HTMLElement {
    const price = h('span', { class: 'wl-price' }, skeleton(14, 64))
    const change = h('span', { class: 'wl-change' }, skeleton(14, 48))
    const name = h('span', { class: 'wl-name' }, companyName(ticker) ?? 'Ação da B3')
    const remove = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', title: `Remover ${ticker}`, 'aria-label': `Remover ${ticker} da watchlist`, onClick: () => watchlist.remove(ticker) }, icon('x', 16))
    const link = h('a', { class: 'wl-main', href: hrefAnalyze(ticker) }, h('span', { class: 'wl-id' }, h('strong', null, shortTicker(ticker)), name), price, change, h('span', { class: 'wl-go', 'aria-hidden': 'true' }, icon('chevron', 18)))

    void loadQuote(ticker).then(q => {
      if (q.failed || q.price === null) {
        price.replaceChildren('—')
        change.replaceChildren(h('span', { class: 'muted', title: 'Cotação indisponível' }, 'indisp.'))
        return
      }
      if (q.name && !companyName(ticker)) name.textContent = q.name
      price.replaceChildren(fmtPrice(q.price))
      const tone = signTone(q.change)
      change.replaceChildren(pill(tone, fmtChange(q.change), { icon: tone === 'pos' ? 'up' : tone === 'neg' ? 'down' : undefined }))
    })
    return h('div', { class: 'wl-row' }, link, remove)
  }

  function renderWatchlist(force = false): void {
    const items = watchlist.get()
    if (force) for (const i of items) quotes.delete(i.ticker)
    refreshBtn.hidden = items.length === 0
    if (items.length === 0) {
      watchHost.replaceChildren(
        emptyState({
          icon: 'star',
          title: 'Sua watchlist está vazia',
          text: 'Toque na estrela ao analisar uma ação para acompanhá-la aqui, com cotação ao vivo.',
          action: h('div', { class: 'shortcuts' }, chipRow('Comece por', POPULAR.slice(0, 4), t => navigate(hrefAnalyze(t)))),
        })
      )
      return
    }
    watchHost.replaceChildren(...items.map(i => row(i.ticker)))
  }
  watchlist.subscribe(() => renderWatchlist())

  // ---- Fontes de dados -----------------------------------------------------
  const sourcesHost = h('div', { class: 'sources' }, skeleton(18, '80%'), skeleton(18, '65%'), skeleton(18, '72%'))
  const sourcesCard = h('section', { class: 'card', 'aria-labelledby': 'sources-title' }, h('div', { class: 'section-title' }, h('h2', { id: 'sources-title' }, 'Fontes e integrações')), sourcesHost)
  let sourcesAt = 0

  function sourceRow(ok: boolean, label: string, detail: string): HTMLElement {
    return h('li', { class: 'source-row' }, h('span', { class: `source-dot ${ok ? 'source-ok' : 'source-off'}`, 'aria-hidden': 'true' }), h('span', { class: 'source-label' }, label), h('span', { class: 'source-detail' }, ok ? detail : 'não configurado'), h('span', { class: 'sr-only' }, ok ? 'ativo' : 'inativo'))
  }

  async function loadSources(): Promise<void> {
    if (Date.now() - sourcesAt < 60_000) return
    try {
      const status = await api<IntegrationStatus>('/api/integrations/status', {}, { timeoutMs: 10_000, retries: 0 })
      sourcesAt = Date.now()
      const i = status.integrations
      const list = h(
        'ul',
        { class: 'source-list' },
        sourceRow(i.llm.configured, 'IA (LLM)', i.llm.model),
        sourceRow(i.fastNews.configured, 'Fast news', 'RAG de notícias'),
        sourceRow(i.marketNewsFeeds.configured, 'Feeds de notícias', `${i.marketNewsFeeds.count} feed${i.marketNewsFeeds.count === 1 ? '' : 's'}`),
        sourceRow(i.paperFeeds.configured || Boolean(i.paperFeeds.fallback), 'Papers', i.paperFeeds.configured ? `${i.paperFeeds.count} feed${i.paperFeeds.count === 1 ? '' : 's'}` : 'arXiv (padrão)'),
        sourceRow(i.telegram.configured, 'Telegram', `resumo diário ${String(i.telegram.notifyUtcHour).padStart(2, '0')}h UTC`)
      )
      sourcesHost.replaceChildren(
        list,
        status.missingForFull24h.length > 0
          ? h('p', { class: 'card-note' }, 'Para o modo 24h completo, defina no .env: ', ...status.missingForFull24h.flatMap((name, idx) => [idx > 0 ? ', ' : '', h('code', null, name)]))
          : h('p', { class: 'card-note' }, 'Tudo configurado para o modo 24h.')
      )
    } catch {
      sourcesHost.replaceChildren(h('p', { class: 'muted' }, 'Não foi possível consultar o status das integrações agora.'))
    }
  }

  // ---- Explorar ------------------------------------------------------------
  const explore = h(
    'section',
    { 'aria-labelledby': 'explore-title' },
    sectionTitle('Ferramentas'),
    h(
      'div',
      { class: 'explore-grid' },
      ...EXPLORE_IDS.map(id => {
        const item = NAV.find(n => n.id === id)
        if (!item) return null
        return h('a', { class: 'explore-card', href: pathFor(item.id) }, h('span', { class: 'explore-icon' }, icon(item.icon, 22)), h('span', { class: 'explore-text' }, h('strong', null, item.label), h('span', null, item.description)), h('span', { class: 'explore-arrow', 'aria-hidden': 'true' }, icon('arrow', 18)))
      })
    )
  )
  explore.querySelector('.section-title h2')?.setAttribute('id', 'explore-title')

  el.append(hero, h('div', { class: 'grid-main-side' }, watchCard, sourcesCard), explore)

  return {
    el,
    show(_route: Route) {
      const recent = recents.get()
      shortcuts.replaceChildren(...[chipRow('Recentes', recent, t => navigate(hrefAnalyze(t))), chipRow('Populares', POPULAR.filter(t => !recent.includes(t)), t => navigate(hrefAnalyze(t)))].filter((n): n is HTMLElement => n !== null))
      renderWatchlist()
      void loadSources()
    },
  }
}
