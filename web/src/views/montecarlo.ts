import { h } from '../research-dom'
import { hrefAnalyze, type Route, type View } from '../router'
import type { McCandidate, MonteCarloResponse } from '../types'
import { api } from '../ui/api'
import { type FrontierMark, frontierChart, percentileBand } from '../ui/charts'
import { emptyState, errorState, loadingPanel, pill, sectionTitle, segmented, setBusy, skeleton, statTile, viewHeader } from '../ui/components'
import { ACTION_LABEL, actionTone, fmtBrl, fmtNum, fmtPct, fmtPrice, fmtSignedPoints, relTime, shortTicker, signTone } from '../ui/format'
import { icon } from '../ui/icons'
import { toast } from '../ui/toast'

type CandidateKey = keyof MonteCarloResponse['best']

const CANDIDATES: Array<{ key: CandidateKey; label: string; short: string; blurb: string; icon: 'zap' | 'target' | 'shield' }> = [
  { key: 'sharpe', label: 'Melhor Sharpe', short: 'Equilibrada', blurb: 'Maior retorno por unidade de risco entre as carteiras sorteadas.', icon: 'target' },
  { key: 'aggressive', label: 'Agressiva', short: 'Agressiva', blurb: 'Maior retorno médio simulado, aceitando oscilações maiores.', icon: 'zap' },
  { key: 'defensive', label: 'Defensiva', short: 'Defensiva', blurb: 'Menor perda nos piores cenários (menor CVaR).', icon: 'shield' },
]

const HORIZONS = [
  { value: '5', label: '1 semana (5 pregões)' },
  { value: '21', label: '1 mês (21 pregões)' },
  { value: '63', label: '3 meses (63 pregões)' },
  { value: '126', label: '6 meses (126 pregões)' },
  { value: '252', label: '1 ano (252 pregões)' },
]

const ENGINES = [
  { value: 'bootstrap', label: 'Bootstrap histórico', hint: 'Reamostra retornos reais; preserva caudas e assimetria.' },
  { value: 'gbm', label: 'Movimento browniano', hint: 'Assume retornos log-normais; mais suave e simétrico.' },
]

export function createMonteCarloView(): View {
  const el = h('div', { class: 'view-stack' })

  const horizon = h('select', { class: 'select', id: 'mc-days' }, ...HORIZONS.map(o => h('option', { value: o.value, selected: o.value === '21' }, o.label)))
  const engine = h('select', { class: 'select', id: 'mc-engine' }, ...ENGINES.map(o => h('option', { value: o.value }, o.label)))
  const sims = h('select', { class: 'select', id: 'mc-sims' }, ...['1000', '5000', '10000', '20000'].map(v => h('option', { value: v, selected: v === '5000' }, `${Number(v).toLocaleString('pt-BR')} simulações`)))
  const engineHint = h('small', { class: 'field-hint' }, ENGINES[0]?.hint)
  engine.addEventListener('change', () => {
    engineHint.textContent = ENGINES.find(e => e.value === engine.value)?.hint ?? ''
  })
  const runBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('dice', 18), 'Simular')
  const form = h(
    'form',
    { class: 'card param-form' },
    h('div', { class: 'param-grid' }, h('div', { class: 'field' }, h('label', { for: 'mc-days' }, 'Horizonte'), horizon), h('div', { class: 'field' }, h('label', { for: 'mc-engine' }, 'Motor'), engine, engineHint), h('div', { class: 'field' }, h('label', { for: 'mc-sims' }, 'Precisão'), sims)),
    h('div', { class: 'param-actions' }, runBtn)
  )
  const out = h('div', { class: 'mc-out' })

  el.append(
    viewHeader({ title: 'Simulação Monte Carlo', subtitle: 'Milhares de cenários para estimar a faixa de resultados de cada ação e de carteiras sorteadas. É um modelo — não uma previsão.' }),
    form,
    out
  )

  let data: MonteCarloResponse | null = null
  let busy = false
  let selected: CandidateKey = 'sharpe'
  let detailHost: HTMLElement | null = null

  function intro(): void {
    out.replaceChildren(emptyState({ icon: 'dice', title: 'Configure e rode a simulação', text: 'Escolha o horizonte e o motor acima. O resultado traz a faixa de retornos (P5–P95), a probabilidade de lucro, o risco de cauda (VaR/CVaR) e as carteiras sugeridas pelo sorteio.' }))
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    void run()
  })

  async function run(): Promise<void> {
    if (busy) return
    busy = true
    setBusy(runBtn, true, 'Simulando…')
    out.replaceChildren(loadingPanel('Simulando milhares de cenários…', h('div', { class: 'grid-tiles' }, skeleton(84), skeleton(84), skeleton(84), skeleton(84)), skeleton(260)))
    const query = new URLSearchParams({ days: horizon.value, sims: sims.value, engine: engine.value })
    try {
      data = await api<MonteCarloResponse>(`/api/portfolio/montecarlo?${query}`, {}, { timeoutMs: 180_000 })
      render()
      toast(`Monte Carlo pronto: ${data.sims.toLocaleString('pt-BR')} simulações, ${data.assets.length} ativos`, 'success')
    } catch (error) {
      out.replaceChildren(errorState(error, () => void run()))
    } finally {
      busy = false
      setBusy(runBtn, false)
    }
  }

  function renderCandidate(): void {
    if (!data || !detailHost) return
    const meta = CANDIDATES.find(c => c.key === selected) ?? (CANDIDATES[0] as (typeof CANDIDATES)[number])
    const c: McCandidate = data.best[selected]
    const d = c.distribution
    const weights = [...c.weights].sort((a, b) => b.weight - a.weight)
    const max = Math.max(...weights.map(w => w.weight), 0.0001)

    detailHost.replaceChildren(
      h('p', { class: 'card-note' }, meta.blurb),
      h(
        'div',
        { class: 'mc-detail' },
        h(
          'div',
          { class: 'mc-alloc' },
          h('h3', { class: 'card-label' }, 'Alocação sugerida pelo sorteio'),
          weights.length === 0
            ? h('p', { class: 'muted' }, 'Sem alocação.')
            : h('ul', { class: 'alloc-list' }, ...weights.map(w => h('li', null, h('a', { href: hrefAnalyze(w.ticker), class: 'alloc-ticker' }, shortTicker(w.ticker)), h('span', { class: 'alloc-bar', 'aria-hidden': 'true' }, (() => { const f = h('span'); f.style.width = `${(w.weight / max) * 100}%`; return f })()), h('span', { class: 'alloc-pct' }, fmtPct(w.weight, 1)))))
        ),
        h(
          'div',
          { class: 'mc-dist' },
          h('h3', { class: 'card-label' }, `Faixa de resultados em ${data.days} pregões`),
          percentileBand(d.percentiles, d.meanPct),
          h('p', { class: 'card-note' }, 'Barra escura: 50% dos cenários (P25–P75). Barra clara: 90% (P5–P95). Traço: mediana.')
        )
      ),
      h(
        'div',
        { class: 'grid-tiles grid-tiles-3' },
        statTile('Retorno médio', fmtSignedPoints(d.meanPct, 2), 'média dos cenários', { tone: signTone(d.meanPct) }),
        statTile('Prob. de lucro', fmtPct(d.probProfit, 0), `ganho >10%: ${fmtPct(d.probGain10, 0)} · perda >10%: ${fmtPct(d.probLoss10, 0)}`),
        statTile('CVaR 95%', fmtSignedPoints(d.cvar95Pct, 2), 'perda média nos 5% piores', { tone: 'neg', title: 'Valor condicional em risco: média das perdas nos 5% piores cenários.' }),
        statTile('VaR 95%', fmtSignedPoints(d.var95Pct, 2), 'limite dos 5% piores', { tone: 'neg' }),
        statTile('Drawdown mediano', fmtSignedPoints(c.maxDrawdownP50Pct, 2), 'maior queda no caminho'),
        statTile('Sharpe', fmtNum(d.sharpe, 2), 'retorno por risco')
      )
    )
  }

  function render(): void {
    if (!data) return
    const res = data
    const marks: FrontierMark[] = CANDIDATES.map(c => ({ key: c.key, label: c.short, riskPct: res.best[c.key].distribution.stdPct, returnPct: res.best[c.key].distribution.meanPct }))

    const picker = segmented<CandidateKey>({
      label: 'Carteira',
      value: selected,
      options: CANDIDATES.map(c => ({ value: c.key, label: c.label })),
      onChange: v => {
        selected = v
        renderCandidate()
      },
    })
    detailHost = h('div', { class: 'mc-candidate' })

    const portfolios = h('section', { class: 'card' }, sectionTitle('Carteiras candidatas', pill('neutral', `${res.candidates.toLocaleString('pt-BR')} sorteadas`)), picker.el, detailHost)

    const frontier = h('section', { class: 'card' }, sectionTitle('Risco × retorno'), frontierChart(res.frontier, marks), h('p', { class: 'card-note' }, 'Cada ponto cinza é uma carteira sorteada; as três destacadas são as candidatas acima. Quanto mais à esquerda e acima, melhor o equilíbrio.'))

    const rows = res.perAsset.map(a => {
      const d = a.distribution
      return h(
        'tr',
        null,
        h('th', { scope: 'row', class: 't-left' }, h('a', { href: hrefAnalyze(a.ticker) }, shortTicker(a.ticker))),
        h('td', null, fmtPrice(a.lastPrice)),
        h('td', { class: `tone-${signTone(d.meanPct)}` }, fmtSignedPoints(d.meanPct, 1)),
        h('td', null, fmtPrice(a.priceTargets.p5)),
        h('td', null, fmtPrice(a.priceTargets.p50)),
        h('td', null, fmtPrice(a.priceTargets.p95)),
        h('td', null, fmtPct(d.probProfit, 0)),
        h('td', null, fmtSignedPoints(d.cvar95Pct, 1)),
        h('td', null, fmtNum(a.volatility.annualized, 1) + '%'),
        h('td', null, fmtPct(a.kellyFraction, 0)),
        h('td', null, pill(actionTone(a.verdict), ACTION_LABEL[a.verdict]))
      )
    })
    const head = ['Ativo', 'Preço', 'Retorno médio', 'Preço P5', 'Preço P50', 'Preço P95', 'Prob. lucro', 'CVaR 95%', 'Vol. anual', 'Kelly', 'Veredito']
    const assets = h(
      'section',
      { class: 'card' },
      sectionTitle('Distribuição simulada por ativo'),
      h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Distribuição simulada por ativo' }, h('table', { class: 'table' }, h('caption', { class: 'sr-only' }, 'Distribuição simulada por ativo'), h('thead', null, h('tr', null, ...head.map((t, i) => h('th', { scope: 'col', class: i === 0 ? 't-left' : null }, t)))), h('tbody', null, ...rows))),
      h('p', { class: 'card-note' }, 'Kelly é a fração teórica de capital sugerida por um critério matemático agressivo; na prática, use bem menos. Veredito é a leitura do modelo, não recomendação.')
    )

    out.replaceChildren(
      h('p', { class: 'meta-line' }, icon('clock', 14), `${res.sims.toLocaleString('pt-BR')} simulações × ${res.candidates.toLocaleString('pt-BR')} carteiras · ${res.days} pregões · motor ${res.engine === 'gbm' ? 'browniano' : 'bootstrap'} · ${res.assets.length} ativos · gerado ${relTime(res.generatedAt)}`),
      portfolios,
      h('div', { class: 'grid-2' }, frontier, h('section', { class: 'card ai-card' }, sectionTitle('Como ler'), h('ul', { class: 'check-list' }, ...['P5/P95: em 90% dos cenários o resultado fica entre esses valores.', 'VaR/CVaR medem a perda nos 5% piores cenários — o risco de cauda.', 'Sharpe compara retorno e risco; maior costuma ser melhor, mas depende do período.', `Preço de referência: ${fmtBrl(res.perAsset[0]?.lastPrice)} (${shortTicker(res.perAsset[0]?.ticker ?? '')}) e demais últimos fechamentos.`].map(t => h('li', null, icon('info', 16), h('span', null, t)))), h('p', { class: 'disclaimer-inline' }, icon('alert', 14), 'Simulações dependem do histórico e de premissas; resultados passados não garantem o futuro.'))),
      assets
    )
    renderCandidate()
  }

  return {
    el,
    show(_route: Route) {
      if (!data && !busy) intro()
    },
  }
}
