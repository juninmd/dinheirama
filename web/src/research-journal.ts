// Sub-aba "Diário": registro de decisões com probabilidade e calibração (Brier, habilidade, confiabilidade).

import { apiJson, type FieldLabels } from './research-api'
import { reliabilityChart, type ReliabilityPoint } from './research-charts'
import {
  badge,
  button,
  errorNotice,
  field,
  fmtBrl,
  fmtDate,
  fmtNum,
  fmtPct,
  fmtSignedPoints,
  h,
  isNum,
  loadInto,
  notice,
  signClass,
  statCard,
  statGrid,
  tableWrap,
  td,
  th,
} from './research-dom'
import type { CalibrationReport, JournalEntry, JournalResponse, TabModule } from './research-types'

const FIELD_LABELS: FieldLabels = {
  ticker: 'Ativo',
  action: 'Decisão',
  probability: 'Probabilidade',
  horizonDays: 'Horizonte (dias)',
  entryPrice: 'Preço de entrada',
  thesis: 'Tese',
}

const ACTION_LABEL: Record<JournalEntry['action'], string> = { buy: 'Comprar', hold: 'Manter', sell: 'Vender' }

function calibrationView(c: CalibrationReport): HTMLElement {
  const box = h('div', { class: 'quant-calibration' })
  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Calibração das suas previsões'))

  const skillHint =
    c.brierSkill === null ? 'precisa de previsões resolvidas' : c.brierSkill > 0 ? 'melhor que sempre prever a taxa-base' : 'sem habilidade além da taxa-base'
  box.appendChild(
    statGrid(
      statCard('Resolvidas / abertas', `${c.resolved} / ${c.open}`),
      statCard('Brier score', fmtNum(c.brier, 3), '0 = perfeito; 0,25 = sempre prever 50%'),
      statCard('Brier da taxa-base', fmtNum(c.brierBaseline, 3), 'referência de quem prevê sempre a taxa observada'),
      statCard('Habilidade (Brier skill)', fmtNum(c.brierSkill, 2), skillHint, signClass(c.brierSkill)),
      statCard('Log loss', fmtNum(c.logLoss, 3), 'menor é melhor'),
      statCard('Taxa-base observada', fmtPct(c.baseRate, 0), 'frequência com que superou a referência'),
      statCard('Acerto direcional', fmtPct(c.directionalHitRate, 0), 'compra/venda vs. resultado'),
      statCard('Excesso médio (compras)', fmtSignedPoints(c.avgExcessReturnPctBuy, 1), 'retorno − referência', signClass(c.avgExcessReturnPctBuy)),
      statCard('Excesso médio (vendas)', fmtSignedPoints(c.avgExcessReturnPctSell, 1), 'retorno − referência', signClass(c.avgExcessReturnPctSell))
    )
  )

  const warnings = Array.isArray(c.warnings) ? c.warnings : []
  if (warnings.length > 0) box.appendChild(notice('warn', 'Avisos de calibração', warnings))

  const bins = Array.isArray(c.bins) ? c.bins : []
  const points: ReliabilityPoint[] = bins
    .filter(b => b.count > 0 && isNum(b.meanForecast) && isNum(b.observedFrequency))
    .map(b => ({ from: b.from, to: b.to, count: b.count, forecast: b.meanForecast as number, observed: b.observedFrequency as number }))

  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Curva de confiabilidade'))
  if (points.length === 0) {
    box.appendChild(notice('info', 'Sem previsões resolvidas ainda', 'A curva aparece quando houver previsões vencidas e resolvidas. Use "Resolver vencidas" após o vencimento.'))
    return box
  }
  box.appendChild(h('p', { class: 'quant-hint' }, 'Pontos sobre a diagonal = confiança igual à frequência de acerto. Acima = você foi pessimista demais; abaixo = otimista demais.'))
  box.appendChild(reliabilityChart(points))
  box.appendChild(
    h(
      'details',
      { class: 'quant-details' },
      h('summary', null, 'Ver tabela por faixa'),
      tableWrap(
        h(
          'table',
          { class: 'quant-table' },
          h('caption', { class: 'sr-only' }, 'Confiabilidade por faixa de probabilidade'),
          h('thead', null, h('tr', null, th('Faixa', { left: true }), th('Previsões'), th('Previsão média'), th('Frequência observada'))),
          h(
            'tbody',
            null,
            ...bins.map(b => h('tr', null, th(`${fmtPct(b.from, 0)} a ${fmtPct(b.to, 0)}`, { scope: 'row', left: true }), td(String(b.count)), td(fmtPct(b.meanForecast, 0)), td(fmtPct(b.observedFrequency, 0))))
          )
        )
      )
    )
  )
  return box
}

function entriesTable(entries: JournalEntry[]): HTMLElement {
  if (entries.length === 0) {
    return notice('info', 'Diário vazio', 'Registre sua primeira decisão acima, com a probabilidade antes de saber o resultado.')
  }
  return tableWrap(
    h(
      'table',
      { class: 'quant-table quant-journal' },
      h('caption', { class: 'sr-only' }, 'Decisões registradas'),
      h(
        'thead',
        null,
        h('tr', null, th('Registro', { left: true }), th('Ativo / tese', { left: true }), th('Decisão', { left: true }), th('Prob.', { title: 'Probabilidade informada de o ativo superar o benchmark (ou o CDI) no horizonte.' }), th('Vencimento'), th('Entrada'), th('Situação', { left: true }), th('Resultado', { left: true }))
      ),
      h(
        'tbody',
        null,
        ...entries.map(e => {
          const resolved = e.status === 'resolved'
          const result = resolved
            ? h(
                'td',
                { class: 't-left' },
                e.outcome === 1 ? badge('ok', '✓ Superou') : badge('bad', '✗ Não superou'),
                h('span', { class: 'quant-sub' }, `${fmtSignedPoints(e.returnPct, 1)} vs. ${fmtSignedPoints(e.referenceReturnPct, 1)} da referência`)
              )
            : td('—', 't-left')
          return h(
            'tr',
            null,
            td(fmtDate(e.createdAt), 't-left'),
            h('th', { scope: 'row', class: 't-left wrap' }, h('strong', null, e.ticker), e.thesis ? h('span', { class: 'quant-sub' }, e.thesis) : null),
            td(ACTION_LABEL[e.action] ?? e.action, 't-left'),
            td(fmtPct(e.probability, 0)),
            td(fmtDate(e.dueAt)),
            td(fmtBrl(e.entryPrice)),
            h('td', { class: 't-left' }, resolved ? badge('neutral', 'Resolvida') : badge('info', 'Aberta')),
            result
          )
        })
      )
    )
  )
}

export function createJournalTab(): TabModule {
  let loaded = false
  let busy = false
  let form!: HTMLFormElement
  let status!: HTMLElement
  let out!: HTMLElement
  let resolveBtn!: HTMLButtonElement
  let submitBtn!: HTMLButtonElement

  function render(data: JournalResponse, host: HTMLElement): void {
    host.appendChild(calibrationView(data.calibration))
    host.appendChild(h('h4', { class: 'quant-subtitle' }, `Decisões registradas (${data.entries?.length ?? 0})`))
    host.appendChild(entriesTable(Array.isArray(data.entries) ? data.entries : []))
  }

  function load(): Promise<void> {
    if (busy) return Promise.resolve()
    busy = true
    return loadInto(out, 'Carregando diário...', () => apiJson<JournalResponse>('/api/journal', {}, { timeoutMs: 30_000 }), render, [resolveBtn]).then(() => {
      busy = false
      loaded = out.querySelector('.quant-notice-bad') === null
    })
  }

  async function submit(): Promise<void> {
    if (!form.reportValidity()) return
    const value = (id: string): string => (form.querySelector(`#${id}`) as HTMLInputElement).value
    const payload: Record<string, unknown> = {
      ticker: value('q-j-ticker').trim().toUpperCase(),
      action: value('q-j-action'),
      probability: Number((Number(value('q-j-prob')) / 100).toFixed(4)),
      horizonDays: Math.round(Number(value('q-j-horizon'))),
      entryPrice: Number(value('q-j-price')),
    }
    const thesis = value('q-j-thesis').trim()
    if (thesis) payload.thesis = thesis

    status.replaceChildren()
    submitBtn.disabled = true
    try {
      const created = await apiJson<JournalEntry>('/api/journal', { method: 'POST', body: JSON.stringify(payload) }, { timeoutMs: 30_000, labels: FIELD_LABELS })
      status.replaceChildren(notice('ok', 'Decisão registrada', `${created.ticker}: ${ACTION_LABEL[created.action] ?? created.action} com ${fmtPct(created.probability, 0)} de probabilidade, vencimento em ${fmtDate(created.dueAt)}.`))
      form.reset()
      await load()
    } catch (error) {
      status.replaceChildren(errorNotice(error))
    } finally {
      submitBtn.disabled = false
    }
  }

  async function resolveDue(): Promise<void> {
    status.replaceChildren()
    resolveBtn.disabled = true
    try {
      const res = await apiJson<{ resolved: number }>('/api/journal/resolve', { method: 'POST' }, { timeoutMs: 180_000 })
      status.replaceChildren(
        res.resolved > 0
          ? notice('ok', `${res.resolved} previsão(ões) resolvida(s)`, 'O resultado foi comparado ao benchmark (ou ao CDI) no horizonte de cada decisão.')
          : notice('info', 'Nenhuma previsão resolvida', 'Ainda não há decisões vencidas ou faltam preços para resolvê-las.')
      )
      await load()
    } catch (error) {
      status.replaceChildren(errorNotice(error))
    } finally {
      resolveBtn.disabled = false
    }
  }

  return {
    mount(panel) {
      const thesis = h('textarea', { rows: 2, maxlength: 500 })
      form = h('form', { class: 'quant-form', 'aria-label': 'Registrar decisão' })
      form.append(
        h(
          'div',
          { class: 'quant-form-grid' },
          field('q-j-ticker', 'Ativo', h('input', { type: 'text', required: true, placeholder: 'PETR4.SA', pattern: '[A-Za-z0-9]{4,6}\\.[A-Za-z]{2}', title: 'Formato: PETR4.SA', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }), 'Formato PETR4.SA'),
          field('q-j-action', 'Decisão', h('select', { required: true }, ...(Object.keys(ACTION_LABEL) as Array<JournalEntry['action']>).map(k => h('option', { value: k }, ACTION_LABEL[k])))),
          field('q-j-prob', 'Probabilidade de superar o benchmark (%)', h('input', { type: 'number', min: 1, max: 99, step: 1, value: 55, required: true, inputmode: 'numeric' }), 'De 1 a 99. Registre ANTES de saber o resultado.'),
          field('q-j-horizon', 'Horizonte (dias)', h('input', { type: 'number', min: 5, max: 1500, step: 1, value: 90, required: true, inputmode: 'numeric' }), 'De 5 a 1500 dias.'),
          field('q-j-price', 'Preço de entrada (R$)', h('input', { type: 'number', min: 0.01, step: 0.01, required: true, inputmode: 'decimal' }), 'Maior que zero.')
        ),
        field('q-j-thesis', 'Tese (opcional, até 500 caracteres)', thesis, 'Por que você acredita nisso? Escrever ajuda a revisar vieses depois.'),
        h('div', { class: 'quant-actions' }, (submitBtn = h('button', { type: 'submit', class: 'primary-btn quant-btn' }, 'Registrar decisão')))
      )
      form.addEventListener('submit', event => {
        event.preventDefault()
        void submit()
      })

      resolveBtn = button('Resolver vencidas', () => void resolveDue(), 'secondary')
      status = h('div', { class: 'quant-status', role: 'status', 'aria-live': 'polite' })
      out = h('div', { class: 'quant-out', 'aria-live': 'polite' })
      panel.append(
        h('p', { class: 'quant-lead' }, 'Evento previsto: o ativo supera o benchmark (ou o CDI, se não houver benchmark) no horizonte escolhido. Com o tempo, o Brier score e a curva de confiabilidade mostram se sua confiança corresponde à frequência de acerto.'),
        form,
        h('div', { class: 'quant-actions' }, resolveBtn),
        status,
        out
      )
    },
    onShow() {
      if (!loaded) void load()
    },
  }
}
