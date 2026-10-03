// Sub-aba "Fatores": ranking multifator (valor, qualidade, momentum, baixa volatilidade).

import { apiJson } from './research-api'
import {
  NA,
  bar,
  button,
  field,
  fmtBrl,
  fmtDate,
  fmtDateTime,
  fmtMult,
  fmtPct,
  fmtSigned,
  fmtSignedPct,
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
import type { FactorRow, FactorTable, TabModule } from './research-types'
import { loadValuation } from './research-valuation'

interface SortOption {
  key: string
  label: string
  get: (row: FactorRow) => number | null
}

const SORTS: SortOption[] = [
  { key: 'score', label: 'Score (padrão)', get: r => r.score },
  { key: 'value', label: 'Valor', get: r => r.groups?.value ?? null },
  { key: 'quality', label: 'Qualidade', get: r => r.groups?.quality ?? null },
  { key: 'momentum', label: 'Momentum', get: r => r.groups?.momentum ?? null },
  { key: 'lowVol', label: 'Baixa volatilidade', get: r => r.groups?.lowVol ?? null },
  { key: 'graham', label: 'Margem de segurança (Graham)', get: r => r.grahamMarginOfSafety },
  { key: 'piotroski', label: 'Piotroski', get: r => r.metrics?.piotroski ?? null },
]

const COLUMNS: Array<{ label: string; title: string }> = [
  { label: '#', title: 'Posição no ranking atual' },
  { label: 'Ativo', title: 'Ticker, nome e setor' },
  { label: 'Score', title: 'Posto percentual (0–100) do composto de fatores dentro do universo. É ranking relativo, não previsão.' },
  { label: 'Valor', title: 'z-score do grupo valor (earnings yield, VPA/preço, FCF yield, dividend yield). + = mais barato que a média do universo.' },
  { label: 'Qualid.', title: 'z-score do grupo qualidade (ROE, ROIC, margem, alavancagem, Piotroski).' },
  { label: 'Moment.', title: 'z-score do grupo momentum (retorno 12-1 meses e proximidade da máxima de 52 semanas).' },
  { label: 'Baixa vol.', title: 'z-score do grupo baixa volatilidade (menor volatilidade = maior valor).' },
  { label: 'Tendência', title: 'Tendência absoluta: momentum 12-1 acima do retorno livre de risco (CDI) do período.' },
  { label: 'Margem Graham', title: 'Margem de segurança sobre o número de Graham: (valor − preço) ÷ valor. Negativa = preço acima do valor de Graham.' },
  { label: 'Piotroski', title: 'F-Score de Piotroski (0 a 9 sinais binários de saúde financeira).' },
  { label: 'Cobert.', title: 'Quantos dos 4 grupos de fatores tinham dado para este ativo.' },
  { label: 'Detalhes', title: 'Abrir métricas, critérios e valuation' },
]

const zCell = (v: number | null | undefined): HTMLTableCellElement => td(fmtSigned(v, 2), signClass(v))

function metricsList(row: FactorRow): HTMLElement {
  const m = row.metrics
  const items: Array<[string, string]> = [
    ['Momentum 12-1', fmtSignedPct(m?.momentum12_1)],
    ['Volatilidade anual', fmtPct(m?.vol)],
    ['Queda desde a máxima de 52 sem.', fmtSignedPct(m?.drawdown)],
    ['Earnings yield', fmtPct(m?.earningsYield)],
    ['VPA ÷ preço', fmtPct(m?.bookToPrice)],
    ['FCF yield', fmtPct(m?.fcfYield)],
    ['Dividend yield', fmtPct(m?.dividendYield)],
    ['ROE', fmtPct(m?.roe)],
    ['ROIC', fmtPct(m?.roic)],
    ['Dív. líquida ÷ EBITDA', fmtMult(m?.netDebtToEbitda)],
    ['Piotroski', isNum(m?.piotroski) ? `${m.piotroski}/9` : NA],
    ['Fórmula Mágica (posição)', isNum(row.magicFormulaRank) ? `${row.magicFormulaRank}º` : NA],
  ]
  return h('dl', { class: 'quant-dl' }, ...items.map(([label, value]) => h('div', { class: 'quant-dl-item' }, h('dt', null, label), h('dd', null, value))))
}

function checkItem(name: string, passed: boolean | null, detail?: string): HTMLElement {
  const mark = passed === null ? '— sem dado' : passed ? '✓ atende' : '✗ não atende'
  return h(
    'li',
    { class: passed === null ? 'check-na' : passed ? 'check-ok' : 'check-bad' },
    h('strong', null, mark),
    ' ',
    name,
    detail ? h('span', { class: 'quant-hint' }, ` (${detail})`) : null
  )
}

function buildDetails(row: FactorRow): HTMLElement {
  const box = h('div', { class: 'quant-factor-detail' })
  box.appendChild(
    h('p', { class: 'quant-hint' }, `${row.name} · ${row.sector} · preço ${fmtBrl(row.price)}${row.hasFundamentals ? '' : ' · sem fundamentos (score só com preço)'}`)
  )
  box.appendChild(metricsList(row))

  const columns = h('div', { class: 'quant-two-col' })
  if (row.graham) {
    const g = row.graham
    columns.appendChild(
      h(
        'div',
        null,
        h('h4', { class: 'quant-subtitle' }, `Graham (defensivo): ${g.passed} de ${g.evaluated} avaliados (${g.total} critérios)`),
        h('ul', { class: 'quant-checks' }, ...(g.criteria ?? []).map(c => checkItem(c.name, c.passed, c.detail)))
      )
    )
  }
  if (row.piotroskiDetail) {
    const p = row.piotroskiDetail
    columns.appendChild(
      h(
        'div',
        null,
        h('h4', { class: 'quant-subtitle' }, `Piotroski: ${p.score}/9 (${p.available} sinais avaliáveis)`),
        h('ul', { class: 'quant-checks' }, ...(p.details ?? []).map(d => checkItem(d.name, d.passed)))
      )
    )
  }
  if (columns.childElementCount > 0) box.appendChild(columns)
  else box.appendChild(h('p', { class: 'quant-hint' }, 'Sem fundamentos disponíveis para este ativo: critérios de Graham e Piotroski não puderam ser calculados.'))

  const valuationHost = h('div', { class: 'quant-valuation', 'aria-live': 'polite' })
  const valuationBtn = button(
    'Ver valuation (DCF/DDM)',
    () => {
      void loadValuation(valuationHost, row.ticker, [valuationBtn])
    },
    'secondary'
  )
  box.appendChild(h('div', { class: 'quant-actions' }, valuationBtn))
  box.appendChild(valuationHost)
  return box
}

export function createFactorsTab(): TabModule {
  let loaded = false
  let busy = false
  let data: FactorTable | null = null
  let sortKey = 'score'
  let filter = ''
  let out!: HTMLElement
  let tableHost!: HTMLElement
  let refreshBtn!: HTMLButtonElement

  function renderTable(): void {
    if (!data) return
    tableHost.replaceChildren()
    const sort = SORTS.find(s => s.key === sortKey) ?? (SORTS[0] as SortOption)
    const q = filter.trim().toLowerCase()
    const rows = (data.rows ?? [])
      .filter(r => !q || `${r.ticker} ${r.name} ${r.sector}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const va = sort.get(a)
        const vb = sort.get(b)
        if (!isNum(va) && !isNum(vb)) return 0
        if (!isNum(va)) return 1
        if (!isNum(vb)) return -1
        return vb - va
      })

    if (rows.length === 0) {
      tableHost.appendChild(notice('info', 'Nenhum ativo corresponde ao filtro.'))
      return
    }

    const body = h('tbody', null)
    rows.forEach((row, index) => {
      const detailId = `q-factor-detail-${row.ticker.replace(/[^A-Za-z0-9]/g, '')}`
      const detailRow = h('tr', { class: 'quant-detail-row', id: detailId })
      detailRow.hidden = true
      const detailCell = h('td', { colspan: COLUMNS.length, class: 't-left wrap' })
      detailRow.appendChild(detailCell)

      const toggle = h('button', { type: 'button', class: 'quant-btn-secondary quant-btn-small', 'aria-expanded': 'false', 'aria-controls': detailId, 'aria-label': `Detalhes de ${row.ticker}` }, 'Detalhes')
      toggle.addEventListener('click', () => {
        const open = detailRow.hidden
        if (open && detailCell.childElementCount === 0) detailCell.appendChild(buildDetails(row))
        detailRow.hidden = !open
        toggle.setAttribute('aria-expanded', String(open))
        toggle.textContent = open ? 'Fechar' : 'Detalhes'
      })

      const scoreCell = h(
        'td',
        { class: 'quant-score-cell' },
        isNum(row.score) ? h('span', { class: 'quant-score-num' }, String(row.score)) : h('span', { class: 'quant-score-num' }, NA),
        isNum(row.score) ? bar(row.score / 100) : null
      )

      const trend = row.trendOk === null ? NA : row.trendOk ? '✓ Positiva' : '✗ Negativa'
      body.append(
        h(
          'tr',
          null,
          td(String(index + 1)),
          h('th', { scope: 'row', class: 't-left' }, h('strong', null, row.ticker), h('span', { class: 'quant-sub' }, `${row.name} · ${row.sector}`)),
          scoreCell,
          zCell(row.groups?.value),
          zCell(row.groups?.quality),
          zCell(row.groups?.momentum),
          zCell(row.groups?.lowVol),
          td(trend, row.trendOk === true ? 'q-pos' : row.trendOk === false ? 'q-neg' : ''),
          td(fmtSignedPct(row.grahamMarginOfSafety, 0), signClass(row.grahamMarginOfSafety)),
          td(isNum(row.metrics?.piotroski) ? `${row.metrics.piotroski}/9` : NA),
          td(`${Math.round((row.coverage ?? 0) * 4)}/4`),
          td(toggle)
        ),
        detailRow
      )
    })

    const table = h(
      'table',
      { class: 'quant-table quant-factors' },
      h('caption', { class: 'sr-only' }, 'Ranking multifator dos ativos do universo'),
      h('thead', null, h('tr', null, ...COLUMNS.map((c, i) => th(c.label, { title: c.title, left: i === 1 })))),
      body
    )
    tableHost.appendChild(tableWrap(table))
    tableHost.appendChild(
      h('p', { class: 'quant-hint' }, 'Grupos mostram z-scores: desvios-padrão em relação à média do universo (+ = melhor que a média, − = pior). Passe o mouse (ou foque) nos títulos das colunas para ver o que cada uma mede.')
    )
  }

  function render(table: FactorTable, host: HTMLElement): void {
    data = table
    const w = table.weights
    host.appendChild(
      statGrid(
        statCard('Preços até', fmtDate(table.asOf)),
        statCard('Ativos pontuados', `${table.scored}/${table.universeSize}`, 'de todo o universo'),
        statCard('Com fundamentos', String(table.withFundamentals), 'Graham e Piotroski só para estes'),
        statCard('Pesos dos fatores', w ? `${fmtPct(w.value, 0)} · ${fmtPct(w.quality, 0)} · ${fmtPct(w.momentum, 0)} · ${fmtPct(w.lowVol, 0)}` : NA, 'valor · qualidade · momentum · baixa vol.'),
        statCard('Gerado em', fmtDateTime(table.generatedAt), 'cache de até 30 min')
      )
    )
    const notes = Array.isArray(table.notes) ? table.notes : []
    if (notes.length > 0) host.appendChild(notice('info', 'Como ler este ranking', notes))
    if (Array.isArray(table.missingPrices) && table.missingPrices.length > 0) {
      host.appendChild(notice('warn', 'Ativos sem preço (fora do ranking)', table.missingPrices.join(', ')))
    }
    tableHost = h('div', { class: 'quant-table-host' })
    host.appendChild(tableHost)
    renderTable()
  }

  function load(): void {
    if (busy) return
    busy = true
    void loadInto(
      out,
      'Calculando fatores do universo (pode levar alguns segundos)...',
      () => apiJson<FactorTable>('/api/factors', {}, { timeoutMs: 120_000 }),
      render,
      [refreshBtn]
    ).then(() => {
      busy = false
      loaded = out.querySelector('.quant-notice-bad') === null
    })
  }

  return {
    mount(panel) {
      const sortSelect = h('select', null, ...SORTS.map(s => h('option', { value: s.key }, s.label)))
      sortSelect.addEventListener('change', () => {
        sortKey = sortSelect.value
        renderTable()
      })
      const filterInput = h('input', { type: 'search', placeholder: 'Ticker, nome ou setor', autocomplete: 'off', spellcheck: 'false' })
      filterInput.addEventListener('input', () => {
        filter = filterInput.value
        renderTable()
      })
      refreshBtn = button('Atualizar ranking', () => load(), 'secondary')
      out = h('div', { class: 'quant-out', 'aria-live': 'polite' })

      panel.append(
        h('p', { class: 'quant-lead' }, 'Ranking relativo por quatro fatores (valor, qualidade, momentum e baixa volatilidade), com pesos iguais. Serve para estudar o universo, não para prever retornos.'),
        h('div', { class: 'quant-toolbar' }, field('q-f-sort', 'Ordenar por', sortSelect), field('q-f-filter', 'Filtrar', filterInput), h('div', { class: 'quant-toolbar-actions' }, refreshBtn)),
        out
      )
    },
    onShow() {
      if (!loaded) load()
    },
  }
}
