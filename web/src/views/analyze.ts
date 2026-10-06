import { h } from '../research-dom'
import { hrefAlert, hrefAnalyze, hrefNews, navigate, type Route, type View } from '../router'
import { POPULAR, ACTION_LABEL, RISK_LABEL, SENTIMENT_LABEL, actionTone, companyName, fmtChange, fmtNum, fmtPrice, isNum, isValidTicker, relTime, riskTone, rsiLabel, rsiTone, sentimentTone, shortTicker, signTone, toTicker } from '../ui/format'
import { recents } from '../store'
import type { AnalyzeResponse, HistoryBar } from '../types'
import { api, post } from '../ui/api'
import { type PricePoint, priceChart } from '../ui/charts'
import { chipRow, emptyState, errorState, linkOut, loadingPanel, pill, richText, rsiMeter, scoreRing, sectionTitle, segmented, setBusy, skeleton, tickerInput, viewHeader } from '../ui/components'
import { icon } from '../ui/icons'
import { watchToggle } from '../ui/watch'

type RangeKey = '1M' | '3M' | '6M' | '1A' | 'MAX'
const RANGE_BARS: Record<RangeKey, number> = { '1M': 21, '3M': 63, '6M': 126, '1A': 252, MAX: Infinity }

export function createAnalyzeView(): View {
  const el = h('div', { class: 'view-stack' })
  const input = tickerInput({ id: 'analyze-ticker', label: 'Código da ação', placeholder: 'Digite o código, ex.: PETR4' })
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('search', 18), 'Analisar')
  const hint = h('p', { class: 'field-hint', role: 'status' })
  const form = h('form', { class: 'search-bar', novalidate: true }, input, submit)
  const shortcuts = h('div', { class: 'shortcuts' })
  const out = h('div', { class: 'analysis-out' })

  el.append(
    viewHeader({ title: 'Analisar ativo', subtitle: 'Score quantitativo, RSI, notícias e a leitura da IA para uma ação da B3.' }),
    h('div', { class: 'card search-card' }, form, hint, shortcuts),
    out
  )

  let current = ''
  let token = 0
  const cache = new Map<string, { data: AnalyzeResponse; at: number }>()

  function renderShortcuts(): void {
    const recent = recents.get()
    const rest = POPULAR.filter(t => !recent.includes(t))
    shortcuts.replaceChildren(...[chipRow('Recentes', recent, go), chipRow(recent.length ? 'Populares' : 'Populares na B3', rest, go)].filter((n): n is HTMLElement => n !== null))
  }

  function go(ticker: string): void {
    input.value = shortTicker(ticker)
    submitTicker()
  }

  function submitTicker(): void {
    const ticker = toTicker(input.value)
    hint.textContent = ''
    if (!ticker) {
      hint.textContent = 'Digite o código de uma ação, por exemplo PETR4 ou VALE3.'
      input.focus()
      return
    }
    if (!isValidTicker(ticker)) {
      hint.textContent = 'Código inválido. Use o formato da B3: 4 letras + número (PETR4) — o “.SA” é opcional.'
      input.focus()
      return
    }
    if (ticker === current) void load(ticker, true)
    else navigate(hrefAnalyze(ticker))
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    submitTicker()
  })

  function idle(): void {
    out.replaceChildren(
      emptyState({
        icon: 'search',
        title: 'Qual ação você quer entender?',
        text: 'Digite um código acima ou escolha um atalho. Você verá o sinal do modelo, o RSI, o impacto das notícias e o histórico de preço.',
      })
    )
  }

  async function load(ticker: string, force = false): Promise<void> {
    current = ticker
    input.value = shortTicker(ticker)
    const mine = ++token
    const hit = cache.get(ticker)
    if (hit && !force && Date.now() - hit.at < 5 * 60_000) {
      render(hit.data, mine)
      return
    }
    setBusy(submit, true, 'Analisando…')
    out.replaceChildren(
      loadingPanel(`Analisando ${shortTicker(ticker)} com IA…`, h('div', { class: 'grid-3' }, skeleton(170, '100%'), skeleton(170, '100%'), skeleton(170, '100%')), skeleton(260, '100%'))
    )
    try {
      const data = await post<AnalyzeResponse>('/api/analyze', { ticker }, { timeoutMs: 120_000 })
      if (mine !== token) return
      cache.set(ticker, { data, at: Date.now() })
      recents.push(ticker)
      render(data, mine)
    } catch (error) {
      if (mine !== token) return
      out.replaceChildren(errorState(error, () => void load(ticker, true)))
    } finally {
      if (mine === token) setBusy(submit, false)
      renderShortcuts()
    }
  }

  function render(data: AnalyzeResponse, mine: number): void {
    const ticker = data.ticker
    const actionT = actionTone(data.action)
    const change = data.quote.change
    const changeTone = signTone(change)

    const head = h(
      'section',
      { class: 'card asset-head', 'aria-label': `Resumo de ${ticker}` },
      h(
        'div',
        { class: 'asset-id' },
        h('h2', { class: 'asset-ticker' }, shortTicker(ticker), h('span', { class: 'asset-suffix' }, '.SA')),
        h('p', { class: 'asset-name' }, data.name && data.name !== ticker ? data.name : (companyName(ticker) ?? 'Ação listada na B3')),
        h('div', { class: 'asset-badges' }, pill('info', `IA: ${data.aiSource}`, { icon: 'sparkles' }), pill('neutral', relTime(data.timestamp), { icon: 'clock', title: 'Horário da análise' }))
      ),
      h(
        'div',
        { class: 'asset-price' },
        h('strong', { class: 'asset-price-value' }, fmtPrice(data.quote.price)),
        h('span', { class: `asset-change tone-${changeTone}` }, changeTone === 'pos' ? icon('up', 16) : changeTone === 'neg' ? icon('down', 16) : null, `${fmtChange(change)} hoje`)
      ),
      h(
        'div',
        { class: 'asset-actions' },
        watchToggle(ticker, { labelled: true }),
        h('a', { class: 'btn btn-secondary', href: hrefNews(ticker) }, icon('news', 18), 'Notícias'),
        h('a', { class: 'btn btn-secondary', href: hrefAlert(ticker) }, icon('bell', 18), 'Criar alerta'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Atualizar análise', 'aria-label': 'Atualizar análise', onClick: () => void load(ticker, true) }, icon('refresh', 18))
      )
    )

    const signalCard = h(
      'section',
      { class: 'card verdict-card' },
      h('h3', { class: 'card-label' }, 'Sinal do modelo'),
      h('div', { class: 'verdict-body' }, scoreRing(data.score, actionT), h('div', { class: 'verdict-pills' }, pill(actionT, ACTION_LABEL[data.action], { icon: data.action === 'buy' ? 'up' : data.action === 'sell' ? 'down' : 'activity' }), pill(riskTone(data.risk), `Risco ${RISK_LABEL[data.risk]}`, { icon: 'shield' }))),
      h('p', { class: 'card-note' }, 'Score de 0 a 100 que combina tendência, RSI, variação e notícias. É um ranking do modelo, não uma previsão.')
    )

    const rsi = isNum(data.rsi) ? data.rsi : null
    const rsiCard = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'card-label' }, 'RSI (14)'),
      h('div', { class: 'big-metric' }, h('strong', { class: `tone-${rsiTone(rsi)}` }, rsi === null ? '—' : fmtNum(rsi, 1)), h('span', { class: 'muted' }, rsiLabel(rsi))),
      rsiMeter(rsi),
      h('p', { class: 'card-note' }, 'Abaixo de 30 costuma indicar sobrevenda; acima de 70, sobrecompra. Sozinho, não é gatilho de decisão.')
    )

    const impact = data.newsImpact
    const newsCard = h(
      'section',
      { class: 'card' },
      h('h3', { class: 'card-label' }, 'Notícias e papers'),
      h('div', { class: 'big-metric' }, pill(sentimentTone(impact.label), SENTIMENT_LABEL[impact.label]), h('span', { class: 'muted' }, `intensidade ${fmtNum(impact.score, 0)}`)),
      h('p', { class: 'card-body-sm' }, impact.summary || 'Sem resumo de impacto disponível.'),
      h('a', { class: 'link-arrow', href: hrefNews(ticker) }, 'Ver todas as fontes', icon('arrow', 16))
    )

    const chartHost = h('div', { class: 'chart-host' }, skeleton(240, '100%'))
    const chartCard = h('section', { class: 'card chart-card' }, h('div', { class: 'chart-title-row' }, h('h3', { class: 'card-label' }, 'Histórico de preço'), h('span', { class: 'chart-period', id: 'chart-period' })), chartHost)
    void loadHistory(ticker, chartCard, chartHost, mine)

    const analysis = h(
      'section',
      { class: 'card ai-card' },
      sectionTitle('Leitura da IA', pill('info', data.aiSource, { icon: 'sparkles' })),
      h('div', { class: 'prose' }, richText(data.analysis || 'Sem texto de análise disponível.')),
      data.rationale.length > 0
        ? h('div', { class: 'rationale' }, h('h3', { class: 'card-label' }, 'Por que esse sinal'), h('ul', { class: 'check-list' }, ...data.rationale.map(r => h('li', null, icon('check', 16), h('span', null, r)))))
        : null,
      h('p', { class: 'disclaimer-inline' }, icon('alert', 14), 'Material educacional gerado por IA a partir de dados públicos. Não é recomendação de investimento.')
    )

    const signals = data.signals.slice(0, 6)
    const signalsCard = h(
      'section',
      { class: 'card' },
      sectionTitle('Sinais externos'),
      signals.length === 0
        ? h('p', { class: 'muted' }, 'Nenhum sinal externo configurado ou encontrado para este ativo.')
        : h('ul', { class: 'signal-list' }, ...signals.map(sig => h('li', null, h('span', { class: 'signal-source' }, sig.source), sig.url ? linkOut(sig.url, sig.title, 'signal-title') : h('span', { class: 'signal-title' }, sig.title))))
    )

    out.replaceChildren(head, h('div', { class: 'grid-3' }, signalCard, rsiCard, newsCard), chartCard, h('div', { class: 'grid-main-side' }, analysis, signalsCard))
  }

  async function loadHistory(ticker: string, card: HTMLElement, host: HTMLElement, mine: number): Promise<void> {
    try {
      const bars = await api<HistoryBar[]>(`/api/history/${encodeURIComponent(ticker)}`, {}, { timeoutMs: 30_000, retries: 1 })
      if (mine !== token) return
      const points: PricePoint[] = (Array.isArray(bars) ? bars : [])
        .map(b => ({ date: b.date, close: b.close ?? b.adjClose ?? NaN }))
        .filter((p): p is PricePoint => typeof p.date === 'string' && Number.isFinite(p.close) && p.close > 0)
      if (points.length < 2) throw new Error('sem histórico')

      const period = card.querySelector<HTMLElement>('#chart-period')
      const draw = (range: RangeKey): void => {
        const slice = Number.isFinite(RANGE_BARS[range]) ? points.slice(-RANGE_BARS[range]) : points
        const first = slice[0] as PricePoint
        const last = slice[slice.length - 1] as PricePoint
        const delta = ((last.close - first.close) / first.close) * 100
        if (period) {
          period.textContent = `${fmtChange(delta)} em ${range === 'MAX' ? 'todo o período' : range}`
          period.className = `chart-period tone-${signTone(delta)}`
        }
        chart.replaceChildren(priceChart(slice))
      }
      const chart = h('div')
      const ranges = segmented<RangeKey>({
        label: 'Período do gráfico',
        compact: true,
        value: '6M',
        options: [{ value: '1M', label: '1M' }, { value: '3M', label: '3M' }, { value: '6M', label: '6M' }, { value: '1A', label: '1A' }, { value: 'MAX', label: 'Tudo' }],
        onChange: draw,
      })
      host.replaceChildren(h('div', { class: 'chart-controls' }, ranges.el), chart)
      draw('6M')
    } catch {
      if (mine === token) host.replaceChildren(h('p', { class: 'muted' }, 'O histórico de preços não está disponível agora. A análise acima continua válida.'))
    }
  }

  return {
    el,
    show(route: Route) {
      renderShortcuts()
      const ticker = route.segments[0] ? toTicker(route.segments[0]) : ''
      if (!ticker) {
        current = ''
        token++
        input.value = ''
        idle()
        queueMicrotask(() => input.focus())
        return
      }
      if (ticker !== current) void load(ticker)
    },
  }
}
