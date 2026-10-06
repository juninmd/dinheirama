import { h } from '../research-dom'
import { NAV } from '../nav'
import { hrefAnalyze, navigate, pathFor, type Route, type View } from '../router'
import { recents, watchlist } from '../store'
import type { IntegrationStatus, QuoteResponse } from '../types'
import { api } from '../ui/api'
import { CHIPS, EYEBROW, GRID_MAIN_SIDE, SEARCH_BAR, STACK, chipRow, emptyState, pill, sectionTitle, skeleton, tickerInput } from '../ui/components'
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
  const el = h('div', { class: STACK })

  // ---- Hero com busca ------------------------------------------------------
  const input = tickerInput({ id: 'home-ticker', label: 'Código da ação', placeholder: 'Código da ação, ex.: PETR4', grow: true })
  const hint = h('p', { class: 'field-hint', role: 'status' })
  input.className += ' min-h-14 rounded-lg px-[18px] text-[1.0625rem]'
  const form = h('form', { class: `${SEARCH_BAR} max-w-[680px]`, novalidate: true }, input, h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, icon('search', 20), 'Analisar'))
  const shortcuts = h('div', { class: CHIPS })
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
    { class: 'hero card relative overflow-hidden rounded-xl p-[clamp(24px,4vw,44px)]', 'aria-labelledby': 'hero-title' },
    h('p', { class: EYEBROW }, 'Radar 24h da B3'),
    h('h1', { class: 'view-title max-w-[18ch] text-[clamp(1.9rem,1.2rem+3vw,3.1rem)] leading-[1.05] font-extrabold tracking-[-0.03em] outline-none', id: 'hero-title', tabindex: -1 }, 'Entenda uma ação em segundos'),
    h('p', { class: 'mt-3.5 mb-6 max-w-[58ch] text-[1.0625rem] text-fg-2' }, 'Score quantitativo, RSI, notícias e papers num só lugar — com as limitações sempre à vista. Projeto pessoal e educacional.'),
    form,
    hint,
    shortcuts
  )

  // ---- Watchlist -----------------------------------------------------------
  const watchHost = h('div', { class: 'grid gap-1' })
  const refreshBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Atualizar cotações', 'aria-label': 'Atualizar cotações', onClick: () => renderWatchlist(true) }, icon('refresh', 18))
  const watchCard = h('section', { class: 'card', 'aria-labelledby': 'watch-title' }, h('div', { class: 'mb-3.5 flex items-center justify-between gap-3' }, h('h2', { class: 'text-[1.0625rem] font-bold', id: 'watch-title' }, 'Minha watchlist'), refreshBtn), watchHost)

  function row(ticker: string): HTMLElement {
    const price = h('span', { class: 'text-right font-semibold tabular-nums' }, skeleton(14, 64))
    const change = h('span', { class: 'flex justify-end' }, skeleton(14, 48))
    const name = h('span', { class: 'truncate text-[0.8125rem] text-fg-3' }, companyName(ticker) ?? 'Ação da B3')
    const remove = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', title: `Remover ${ticker}`, 'aria-label': `Remover ${ticker} da watchlist`, onClick: () => watchlist.remove(ticker) }, icon('x', 16))
    const link = h('a', { class: 'grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_92px_20px] items-center gap-3.5 rounded-md py-2.5 pr-1.5 pl-3 text-fg no-underline max-xs:grid-cols-[minmax(0,1fr)_auto_84px]', href: hrefAnalyze(ticker) }, h('span', { class: 'grid min-w-0' }, h('strong', { class: 'text-base tracking-[-0.01em]' }, shortTicker(ticker)), name), price, change, h('span', { class: 'inline-flex text-fg-3 transition group-hover:translate-x-0.5 group-hover:text-brand max-xs:hidden', 'aria-hidden': 'true' }, icon('chevron', 18)))

    void loadQuote(ticker).then(q => {
      if (q.failed || q.price === null) {
        price.replaceChildren('—')
        change.replaceChildren(h('span', { class: 'text-fg-2', title: 'Cotação indisponível' }, 'indisp.'))
        return
      }
      if (q.name && !companyName(ticker)) name.textContent = q.name
      price.replaceChildren(fmtPrice(q.price))
      const tone = signTone(q.change)
      change.replaceChildren(pill(tone, fmtChange(q.change), { icon: tone === 'pos' ? 'up' : tone === 'neg' ? 'down' : undefined }))
    })
    return h('div', { class: 'group flex items-center gap-1 rounded-md transition-colors hover:bg-surface-2' }, link, remove)
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
          action: h('div', { class: CHIPS }, chipRow('Comece por', POPULAR.slice(0, 4), t => navigate(hrefAnalyze(t)))),
        })
      )
      return
    }
    watchHost.replaceChildren(...items.map(i => row(i.ticker)))
  }
  watchlist.subscribe(() => renderWatchlist())

  // ---- Fontes de dados -----------------------------------------------------
  const sourcesHost = h('div', { class: 'grid gap-2' }, skeleton(18, '80%'), skeleton(18, '65%'), skeleton(18, '72%'))
  const sourcesCard = h('section', { class: 'card', 'aria-labelledby': 'sources-title' }, h('div', { class: 'mb-3.5 flex items-center justify-between gap-3' }, h('h2', { class: 'text-[1.0625rem] font-bold', id: 'sources-title' }, 'Fontes e integrações')), sourcesHost)
  let sourcesAt = 0

  function sourceRow(ok: boolean, label: string, detail: string): HTMLElement {
    return h('li', { class: 'grid grid-cols-[10px_1fr_auto] items-center gap-3 border-b border-line px-1 py-[9px] text-[0.9rem] last:border-b-0' }, h('span', { class: `size-[9px] rounded-full ${ok ? 'bg-pos-solid shadow-[0_0_0_4px_var(--pos-soft)]' : 'bg-fg-3 opacity-60'}`, 'aria-hidden': 'true' }), h('span', { class: 'font-semibold' }, label), h('span', { class: 'text-right text-[0.8125rem] text-fg-3' }, ok ? detail : 'não configurado'), h('span', { class: 'sr-only' }, ok ? 'ativo' : 'inativo'))
  }

  async function loadSources(): Promise<void> {
    if (Date.now() - sourcesAt < 60_000) return
    try {
      const status = await api<IntegrationStatus>('/api/integrations/status', {}, { timeoutMs: 10_000, retries: 0 })
      sourcesAt = Date.now()
      const i = status.integrations
      const list = h(
        'ul',
        { class: 'grid gap-0.5' },
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
      sourcesHost.replaceChildren(h('p', { class: 'text-fg-2' }, 'Não foi possível consultar o status das integrações agora.'))
    }
  }

  // ---- Explorar ------------------------------------------------------------
  const explore = h(
    'section',
    { 'aria-labelledby': 'explore-title' },
    sectionTitle('Ferramentas'),
    h(
      'div',
      { class: 'grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3.5' },
      ...EXPLORE_IDS.map(id => {
        const item = NAV.find(n => n.id === id)
        if (!item) return null
        return h('a', { class: 'group flex items-center gap-3.5 rounded-lg border border-line bg-surface p-4 text-fg no-underline transition duration-200 hover:-translate-y-0.5 hover:border-brand-line hover:shadow-md', href: pathFor(item.id) }, h('span', { class: 'explore-icon' }, icon(item.icon, 22)), h('span', { class: 'explore-text' }, h('strong', null, item.label), h('span', null, item.description)), h('span', { class: 'inline-flex text-fg-3 transition group-hover:translate-x-[3px] group-hover:text-brand', 'aria-hidden': 'true' }, icon('arrow', 18)))
      })
    )
  )
  explore.querySelector('h2')?.setAttribute('id', 'explore-title')

  el.append(hero, h('div', { class: GRID_MAIN_SIDE }, watchCard, sourcesCard), explore)

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
