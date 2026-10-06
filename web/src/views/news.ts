import { h } from '../research-dom'
import { hrefAlert, hrefAnalyze, navigate, pathFor, type Route, type View } from '../router'
import { recents } from '../store'
import type { ResearchItem, ResearchResponse, Sentiment } from '../types'
import { api } from '../ui/api'
import { CHIPS, OUT, SEARCH_BAR, STACK, TOOLBAR, chipRow, emptyState, errorState, linkOut, loadingPanel, pill, sectionTitle, segmented, setBusy, skeleton, tickerInput, viewHeader } from '../ui/components'
import { POPULAR, SENTIMENT_LABEL, type Tone, fmtDate, isValidTicker, relTime, sentimentTone, shortTicker, toTicker } from '../ui/format'
import { icon } from '../ui/icons'

type KindFilter = 'all' | ResearchItem['kind']
type SentimentFilter = 'all' | Sentiment

// bordas por sentimento (classes completas para o Tailwind)
const NEWS_EDGE: Record<Sentiment, string> = { bullish: 'border-l-pos-solid', bearish: 'border-l-neg-solid', neutral: 'border-l-line-strong' }
const IMPACT_EDGE: Record<Tone, string> = { pos: 'border-l-pos-solid', neg: 'border-l-neg-solid', warn: 'border-l-warn-solid', info: 'border-l-info', neutral: 'border-l-line-strong' }

const KIND_LABEL: Record<ResearchItem['kind'], string> = { 'fast-news': 'Fast news', news: 'Notícia', paper: 'Paper' }

export function createNewsView(): View {
  const el = h('div', { class: STACK })
  const input = tickerInput({ id: 'news-ticker', label: 'Código da ação', placeholder: 'Ex.: PETR4', grow: true })
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('search', 18), 'Pesquisar')
  const hint = h('p', { class: 'field-hint', role: 'status' })
  const form = h('form', { class: SEARCH_BAR, novalidate: true }, input, submit)
  const shortcuts = h('div', { class: CHIPS })
  const out = h('div', { class: OUT })

  el.append(
    viewHeader({ title: 'Notícias & papers', subtitle: 'O que está saindo sobre o ativo — notícias de mercado, fast news e artigos científicos — com o impacto estimado de cada item.' }),
    h('div', { class: 'card p-4' }, form, hint, shortcuts),
    out
  )

  let current = ''
  let token = 0
  let data: ResearchResponse | null = null
  let kind: KindFilter = 'all'
  let sentiment: SentimentFilter = 'all'
  let listHost: HTMLElement | null = null

  function submitTicker(): void {
    const ticker = toTicker(input.value)
    hint.textContent = ''
    if (!ticker || !isValidTicker(ticker)) {
      hint.textContent = ticker ? 'Código inválido. Use o formato da B3, como PETR4.' : 'Digite o código de uma ação para pesquisar.'
      input.focus()
      return
    }
    if (ticker === current) void load(ticker, true)
    else navigate(pathFor('noticias', [ticker]))
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    submitTicker()
  })

  function renderShortcuts(): void {
    const go = (t: string): void => {
      input.value = shortTicker(t)
      submitTicker()
    }
    const recent = recents.get()
    shortcuts.replaceChildren(...[chipRow('Recentes', recent, go), chipRow('Populares', POPULAR.filter(t => !recent.includes(t)), go)].filter((n): n is HTMLElement => n !== null))
  }

  async function load(ticker: string, force = false): Promise<void> {
    current = ticker
    input.value = shortTicker(ticker)
    const mine = ++token
    if (!force && data?.asset === ticker) {
      render()
      return
    }
    setBusy(submit, true, 'Pesquisando…')
    out.replaceChildren(loadingPanel(`Lendo notícias e papers sobre ${shortTicker(ticker)}…`, skeleton(90), skeleton(120), skeleton(120)))
    try {
      const res = await api<ResearchResponse>(`/api/research/${encodeURIComponent(ticker)}`, {}, { timeoutMs: 90_000 })
      if (mine !== token) return
      data = { ...res, asset: ticker }
      kind = 'all'
      sentiment = 'all'
      render()
    } catch (error) {
      if (mine === token) out.replaceChildren(errorState(error, () => void load(ticker, true)))
    } finally {
      if (mine === token) setBusy(submit, false)
    }
  }

  function itemCard(item: ResearchItem): HTMLElement {
    const date = item.publishedAt ? fmtDate(item.publishedAt) : null
    return h(
      'article',
      { class: `grid gap-2 rounded-lg border border-l-4 border-line bg-surface px-[18px] py-4 ${NEWS_EDGE[item.impact]}` },
      h('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.8125rem]' }, pill('neutral', KIND_LABEL[item.kind] ?? item.kind), h('span', { class: 'font-semibold text-fg-2' }, item.source), date && date !== '—' ? h('span', { class: 'text-fg-2' }, date) : null, h('span', { class: 'ml-auto' }, pill(sentimentTone(item.impact), SENTIMENT_LABEL[item.impact] ?? item.impact, { icon: item.impact === 'bullish' ? 'up' : item.impact === 'bearish' ? 'down' : undefined }))),
      h('h3', { class: 'text-[1.0625rem] leading-[1.35] font-bold' }, item.url ? linkOut(item.url, item.title, 'text-fg no-underline hover:text-brand hover:underline') : item.title),
      item.summary ? h('p', { class: 'line-clamp-3 text-[0.9rem] leading-[1.55] text-fg-2' }, item.summary) : null
    )
  }

  function renderList(): void {
    if (!data || !listHost) return
    const rows = data.items.filter(i => (kind === 'all' || i.kind === kind) && (sentiment === 'all' || i.impact === sentiment))
    listHost.replaceChildren(...(rows.length > 0 ? rows.map(itemCard) : [h('p', { class: 'text-fg-2' }, 'Nenhum item neste filtro.')]))
  }

  function render(): void {
    if (!data) return
    const res = data
    const count = (k: ResearchItem['kind']): number => res.items.filter(i => i.kind === k).length
    const impactTone = sentimentTone(res.impact.label)

    const summary = h(
      'section',
      { class: `card grid gap-3.5 border-l-4 ${IMPACT_EDGE[impactTone]}` },
      h('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, h('div', null, h('h2', { class: 'flex items-baseline gap-0.5 text-[clamp(1.75rem,1.3rem+2vw,2.5rem)] font-extrabold tracking-[-0.035em]' }, shortTicker(current), h('span', { class: 'text-[0.45em] font-semibold text-fg-3' }, '.SA')), h('p', { class: 'text-fg-2' }, `Atualizado ${relTime(res.generatedAt)}`)), pill(impactTone, `Impacto ${SENTIMENT_LABEL[res.impact.label].toLowerCase()}`, { icon: res.impact.label === 'bullish' ? 'up' : res.impact.label === 'bearish' ? 'down' : 'activity' })),
      h('p', { class: 'max-w-[78ch] text-base leading-[1.6]' }, res.impact.summary || 'Sem resumo disponível.'),
      h('div', { class: 'flex flex-wrap gap-2.5' }, h('a', { class: 'btn btn-secondary', href: hrefAnalyze(current) }, icon('search', 18), 'Analisar ativo'), h('a', { class: 'btn btn-secondary', href: hrefAlert(current) }, icon('bell', 18), 'Criar alerta'))
    )

    if (res.items.length === 0) {
      out.replaceChildren(summary, emptyState({ icon: 'news', title: 'Nada encontrado para este ativo', text: 'Não há notícias ou papers nas fontes configuradas. Revise FAST_NEWS_URL, MARKET_NEWS_FEEDS e PAPER_FEEDS no .env.' }))
      return
    }

    const kinds = segmented<KindFilter>({
      label: 'Tipo de fonte',
      value: kind,
      onChange: v => {
        kind = v
        renderList()
      },
      options: [{ value: 'all', label: 'Tudo', count: res.items.length }, { value: 'news', label: 'Notícias', count: count('news') }, { value: 'fast-news', label: 'Fast news', count: count('fast-news') }, { value: 'paper', label: 'Papers', count: count('paper') }],
    })
    const sentiments = segmented<SentimentFilter>({
      label: 'Impacto',
      compact: true,
      value: sentiment,
      onChange: v => {
        sentiment = v
        renderList()
      },
      options: [{ value: 'all', label: 'Todos' }, { value: 'bullish', label: 'Positivo' }, { value: 'neutral', label: 'Neutro' }, { value: 'bearish', label: 'Negativo' }],
    })
    listHost = h('div', { class: 'grid gap-3' })

    const questions = res.nextQuestions?.length
      ? h('section', { class: 'card' }, sectionTitle('Perguntas para aprofundar'), h('ul', { class: 'check-list' }, ...res.nextQuestions.map(q => h('li', null, icon('sparkles', 16), h('span', null, q)))))
      : null

    out.replaceChildren(summary, h('div', { class: TOOLBAR }, kinds.el, sentiments.el), listHost, ...(questions ? [questions] : []))
    renderList()
  }

  return {
    el,
    show(route: Route) {
      renderShortcuts()
      const fromRoute = route.segments[0] ? toTicker(route.segments[0]) : ''
      const ticker = fromRoute || current || recents.get()[0] || 'PETR4.SA'
      if (!fromRoute && !current) {
        // primeira visita sem ticker: sugere o último analisado, mas só pesquisa quando o usuário pedir
        input.value = shortTicker(ticker)
        out.replaceChildren(emptyState({ icon: 'news', title: 'Pesquise um ativo', text: 'Escolha um código acima. Vamos buscar notícias de mercado, fast news e papers e estimar o impacto de cada item.', action: h('button', { type: 'button', class: 'btn btn-primary', onClick: submitTicker }, icon('search', 18), `Pesquisar ${shortTicker(ticker)}`) }))
        return
      }
      if (fromRoute && fromRoute !== current) void load(fromRoute)
      else if (!fromRoute && current && !data) void load(current)
    },
  }
}
