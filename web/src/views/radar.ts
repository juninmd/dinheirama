import { h } from '../research-dom'
import { hrefAnalyze, type Route, type View } from '../router'
import type { Action, PortfolioResponse, RadarStock } from '../types'
import { api } from '../ui/api'
import { emptyState, errorState, loadingPanel, pill, richText, sectionTitle, segmented, setBusy, skeleton, statTile, viewHeader } from '../ui/components'
import { ACTION_LABEL, RISK_LABEL, actionTone, fmtChange, fmtNum, fmtPrice, isNum, relTime, riskTone, rsiTone, shortTicker, signTone } from '../ui/format'
import { icon } from '../ui/icons'
import { toast } from '../ui/toast'
import { watchToggle } from '../ui/watch'

type Filter = 'all' | Action
type SortKey = 'score' | 'change' | 'history' | 'rsi'

const SORTS: Array<{ key: SortKey; label: string; get: (s: RadarStock) => number | null }> = [
  { key: 'score', label: 'Score (maior primeiro)', get: s => s.score },
  { key: 'change', label: 'Variação hoje', get: s => s.change },
  { key: 'history', label: 'Variação 30 dias', get: s => s.historyChange },
  { key: 'rsi', label: 'RSI (menor primeiro)', get: s => (isNum(s.rsi) ? -s.rsi : null) },
]

export function createRadarView(): View {
  const el = h('div', { class: 'view-stack' })
  const runBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('radar', 18), 'Gerar radar')
  const out = h('div', { class: 'radar-out' })
  el.append(
    viewHeader({ title: 'Radar B3', subtitle: 'Ranking das ações monitoradas por score, com sinal do modelo, risco e impacto das notícias.', actions: [runBtn] }),
    out
  )

  let data: PortfolioResponse | null = null
  let fetchedAt = 0
  let filter: Filter = 'all'
  let sortKey: SortKey = 'score'
  let busy = false
  let listHost: HTMLElement | null = null
  let filterControl: ReturnType<typeof segmented<Filter>> | null = null

  function intro(): void {
    out.replaceChildren(
      emptyState({
        icon: 'radar',
        title: 'Pronto para varrer o mercado?',
        text: 'O radar analisa todas as ações do universo monitorado — preço, RSI, tendência de 30 dias e notícias — e ordena por score. Leva alguns segundos.',
        action: h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => void run() }, icon('radar', 20), 'Gerar radar'),
      })
    )
  }

  async function run(): Promise<void> {
    if (busy) return
    busy = true
    setBusy(runBtn, true, 'Analisando…')
    out.replaceChildren(
      loadingPanel('Analisando as ações da B3…', h('div', { class: 'grid-tiles' }, skeleton(84), skeleton(84), skeleton(84), skeleton(84)), h('div', { class: 'radar-grid' }, ...Array.from({ length: 6 }, () => skeleton(190))))
    )
    try {
      data = await api<PortfolioResponse>('/api/portfolio', {}, { timeoutMs: 150_000 })
      fetchedAt = Date.now()
      render()
      toast(`Radar gerado: ${data.tickersAnalyzed} ações analisadas`, 'success')
    } catch (error) {
      out.replaceChildren(errorState(error, () => void run()))
    } finally {
      busy = false
      setBusy(runBtn, false)
      runBtn.replaceChildren(icon('refresh', 18), data ? 'Atualizar' : 'Gerar radar')
    }
  }

  function card(stock: RadarStock, rank: number): HTMLElement {
    const aT = actionTone(stock.action)
    const tone = signTone(stock.change)
    const bar = h('span', { class: `score-bar-fill tone-bg-${aT}` })
    bar.style.width = `${Math.max(0, Math.min(100, stock.score))}%`
    return h(
      'article',
      { class: 'radar-card' },
      h(
        'div',
        { class: 'radar-card-top' },
        h('span', { class: 'rank', 'aria-label': `Posição ${rank}` }, String(rank)),
        h('a', { class: 'radar-id', href: hrefAnalyze(stock.ticker) }, h('strong', null, shortTicker(stock.ticker)), h('span', null, stock.name && stock.name !== stock.ticker ? stock.name : 'Ação da B3')),
        pill(aT, ACTION_LABEL[stock.action]),
        watchToggle(stock.ticker)
      ),
      h('div', { class: 'radar-price' }, h('strong', null, fmtPrice(stock.price)), h('span', { class: `tone-${tone}` }, tone === 'pos' ? icon('up', 14) : tone === 'neg' ? icon('down', 14) : null, `${fmtChange(stock.change)} hoje`)),
      h('div', { class: 'score-row' }, h('span', { class: 'score-num' }, `${Math.round(stock.score)}`, h('small', null, '/100')), h('span', { class: 'score-bar', 'aria-hidden': 'true' }, bar)),
      h(
        'dl',
        { class: 'radar-metrics' },
        h('div', null, h('dt', null, '30 dias'), h('dd', { class: `tone-${signTone(stock.historyChange)}` }, fmtChange(stock.historyChange))),
        h('div', null, h('dt', null, 'RSI'), h('dd', { class: `tone-${rsiTone(stock.rsi)}` }, isNum(stock.rsi) ? fmtNum(stock.rsi, 0) : '—')),
        h('div', null, h('dt', null, 'Risco'), h('dd', { class: `tone-${riskTone(stock.risk)}` }, RISK_LABEL[stock.risk]))
      )
    )
  }

  function renderList(): void {
    if (!data || !listHost) return
    const sort = SORTS.find(s => s.key === sortKey) ?? (SORTS[0] as (typeof SORTS)[number])
    const rows = data.portfolio
      .filter(s => filter === 'all' || s.action === filter)
      .sort((a, b) => {
        const va = sort.get(a)
        const vb = sort.get(b)
        if (!isNum(va) && !isNum(vb)) return 0
        if (!isNum(va)) return 1
        if (!isNum(vb)) return -1
        return vb - va
      })
    listHost.replaceChildren(...(rows.length > 0 ? rows.map((s, i) => card(s, i + 1)) : [h('p', { class: 'muted' }, 'Nenhuma ação neste filtro.')]))
  }

  function render(): void {
    if (!data) return
    const list = data.portfolio
    const count = (a: Action): number => list.filter(s => s.action === a).length
    const best = [...list].sort((a, b) => b.score - a.score)[0]

    const tiles = h(
      'div',
      { class: 'grid-tiles' },
      statTile('Ações analisadas', String(data.tickersAnalyzed), `atualizado ${relTime(fetchedAt)}`),
      statTile('Sinal “comprar”', String(count('buy')), 'score alto', { tone: 'pos' }),
      statTile('Sinal “manter”', String(count('hold')), 'score intermediário', { tone: 'warn' }),
      statTile('Sinal “vender”', String(count('sell')), 'score baixo', { tone: 'neg' }),
      best ? statTile('Maior score', shortTicker(best.ticker), `${Math.round(best.score)}/100`) : null
    )

    filterControl = segmented<Filter>({
      label: 'Filtrar por sinal',
      value: filter,
      onChange: v => {
        filter = v
        renderList()
      },
      options: [
        { value: 'all', label: 'Todas', count: list.length },
        { value: 'buy', label: 'Comprar', count: count('buy') },
        { value: 'hold', label: 'Manter', count: count('hold') },
        { value: 'sell', label: 'Vender', count: count('sell') },
      ],
    })
    const sortSelect = h('select', { class: 'select', 'aria-label': 'Ordenar por' }, ...SORTS.map(s => h('option', { value: s.key, selected: s.key === sortKey }, s.label)))
    sortSelect.addEventListener('change', () => {
      sortKey = sortSelect.value as SortKey
      renderList()
    })
    listHost = h('div', { class: 'radar-grid' })

    const strategy = h(
      'section',
      { class: 'card ai-card' },
      sectionTitle('Estratégia do assistente', pill('info', data.aiSource, { icon: 'sparkles' })),
      h('div', { class: 'prose' }, richText(data.recommendation || 'Sem texto de estratégia disponível.')),
      h('p', { class: 'disclaimer-inline' }, icon('alert', 14), 'Leitura automática para estudo. Não é recomendação de investimento.')
    )

    out.replaceChildren(tiles, h('div', { class: 'toolbar' }, filterControl.el, h('label', { class: 'toolbar-field' }, h('span', null, 'Ordenar'), sortSelect)), listHost, strategy)
    renderList()
  }

  runBtn.addEventListener('click', () => void run())

  return {
    el,
    show(_route: Route) {
      if (!data && !busy) intro()
    },
  }
}
