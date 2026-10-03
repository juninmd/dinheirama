// Sub-aba "Backtest": comparação BRUTO x LÍQUIDO, Sharpe deflacionado, curva de patrimônio e ressalvas (sempre visíveis).

import { apiJson } from './research-api'
import { lineChart } from './research-charts'
import {
  badge,
  bulletList,
  field,
  fmtBrl,
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
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
import type { BacktestReport, BacktestResult, PerformanceMetrics, TabModule } from './research-types'

/** Ressalvas gerais mostradas antes de qualquer execução (o backend envia a lista completa junto com o resultado). */
const STATIC_CAVEATS = [
  'Backtest não é previsão: desempenho passado não garante desempenho futuro.',
  'O universo é a lista atual de ações líquidas (viés de sobrevivência) e custos/IR são modelos simplificados.',
  'Muitas variantes testadas inflam o Sharpe: olhe o Sharpe deflacionado e o diagnóstico de robustez.',
]

function metricCells(m: PerformanceMetrics | undefined, withPsr: boolean): HTMLTableCellElement[] {
  const cells = [td(fmtPct(m?.cagr), signClass(m?.cagr)), td(fmtPct(m?.annVol)), td(fmtNum(m?.sharpe)), td(fmtPct(m?.maxDrawdown))]
  if (withPsr) cells.push(td(fmtPct(m?.psr, 0)))
  return cells
}

function dsrCell(value: number | undefined): HTMLTableCellElement {
  if (!isNum(value)) return td('—')
  const significant = value >= 0.95
  return h(
    'td',
    null,
    fmtPct(value, 0),
    ' ',
    badge(significant ? 'ok' : 'warn', significant ? 'significativo' : 'não significativo', 'Convenção: ≥ 95% indica Sharpe improvável de ser fruto do acaso entre as variantes testadas.')
  )
}

function comparisonTable(results: BacktestResult[]): HTMLElement {
  const head = h(
    'thead',
    null,
    h(
      'tr',
      null,
      th('Estratégia', { left: true, rowspan: 2, className: 'sticky-col' }),
      th('BRUTO — antes de custos e IR', { colspan: 4, className: 'group-gross' }),
      th('LÍQUIDO — após custos e IR', { colspan: 5, className: 'group-net' }),
      th('Atrito (CAGR)', { rowspan: 2, title: 'CAGR bruto − CAGR líquido, em pontos percentuais: quanto custos e IR consomem por ano.' }),
      th('Sharpe deflacionado', { rowspan: 2, title: 'DSR: probabilidade de o Sharpe verdadeiro superar o máximo que o acaso renderia entre todas as variantes testadas.' }),
      th('Giro a.a.', { rowspan: 2, title: 'Volume negociado anual ÷ patrimônio médio.' }),
      th('Custos', { rowspan: 2, title: 'Corretagem e impacto de mercado acumulados no período.' }),
      th('IR', { rowspan: 2, title: 'Imposto de renda de swing trade acumulado no período.' }),
      th('CAGR vs. bench.', { rowspan: 2, title: 'CAGR líquido da estratégia − CAGR do benchmark.' })
    ),
    h(
      'tr',
      null,
      th('CAGR', { className: 'group-gross' }),
      th('Vol.', { className: 'group-gross' }),
      th('Sharpe', { className: 'group-gross' }),
      th('Máx. DD', { className: 'group-gross', title: 'Maior queda do pico ao vale.' }),
      th('CAGR', { className: 'group-net' }),
      th('Vol.', { className: 'group-net' }),
      th('Sharpe', { className: 'group-net' }),
      th('Máx. DD', { className: 'group-net', title: 'Maior queda do pico ao vale.' }),
      th('PSR', { className: 'group-net', title: 'Probabilidade de o Sharpe verdadeiro ser maior que zero, dada a amostra.' })
    )
  )

  const body = h(
    'tbody',
    null,
    ...results.map(r => {
      const friction = isNum(r.gross?.cagr) && isNum(r.net?.cagr) ? (r.gross.cagr - r.net.cagr) * 100 : null
      return h(
        'tr',
        null,
        h(
          'th',
          { scope: 'row', class: 't-left sticky-col' },
          h('strong', null, r.label),
          h('span', { class: 'quant-sub' }, `${fmtDate(r.startDate)} a ${fmtDate(r.endDate)} · ${fmtNum(r.years, 1)} anos · ~${fmtNum(r.avgPositions, 1)} posições`)
        ),
        ...metricCells(r.gross, false),
        ...metricCells(r.net, true),
        td(isNum(friction) ? `${fmtNum(friction, 2)} p.p.` : '—'),
        dsrCell(r.deflatedSharpe),
        td(fmtNum(r.turnoverAnnual, 2) + '×'),
        td(fmtBrl(r.totalCosts, 0)),
        td(fmtBrl(r.totalTax, 0)),
        td(isNum(r.relative?.excessCagr) ? `${fmtSigned((r.relative?.excessCagr ?? 0) * 100, 2)} p.p.` : '—', signClass(r.relative?.excessCagr))
      )
    })
  )

  return tableWrap(h('table', { class: 'quant-table quant-compare' }, h('caption', { class: 'sr-only' }, 'Comparação bruto e líquido das estratégias'), head, body))
}

function referenceTable(results: BacktestResult[]): HTMLElement | null {
  const first = results[0]
  if (!first) return null
  const bench = results.find(r => r.benchmark)?.benchmark
  const rows: Array<[string, PerformanceMetrics | undefined]> = []
  if (bench) rows.push([bench.name, bench])
  rows.push(['CDI (caixa)', first.cash])
  return tableWrap(
    h(
      'table',
      { class: 'quant-table' },
      h('caption', { class: 'sr-only' }, 'Referências: benchmark e CDI'),
      h('thead', null, h('tr', null, th('Referência (sem custos)', { left: true }), th('CAGR'), th('Vol.'), th('Sharpe'), th('Máx. DD'))),
      h('tbody', null, ...rows.map(([name, m]) => h('tr', null, th(name, { scope: 'row', left: true }), ...metricCells(m, false))))
    )
  )
}

function equitySection(results: BacktestResult[]): HTMLElement {
  const withCurve = results.filter(r => Array.isArray(r.equityCurve) && r.equityCurve.length > 1)
  const box = h('div', { class: 'quant-equity' })
  if (withCurve.length === 0) {
    box.appendChild(notice('info', 'Curva de patrimônio indisponível para este resultado.'))
    return box
  }
  const preferred = withCurve.find(r => /multi/i.test(r.strategy)) ?? withCurve[0]
  const select = h('select', null, ...withCurve.map(r => h('option', { value: r.strategy, selected: r === preferred }, r.label)))
  const chartHost = h('div', null)

  const drawChart = (): void => {
    const r = withCurve.find(x => x.strategy === select.value) ?? (withCurve[0] as BacktestResult)
    const curve = r.equityCurve
    const hasBench = curve.some(p => isNum(p.benchmark))
    chartHost.replaceChildren(
      lineChart({
        dates: curve.map(p => p.date),
        yTitle: 'Patrimônio líquido, base 1,00 no início',
        ariaLabel: `Curva de patrimônio de ${r.label} contra o CDI${hasBench ? ' e o benchmark' : ''}`,
        format: v => `${fmtNum(v, 2)}×`,
        series: [
          { label: `${r.label} (líquido)`, kind: 'strategy', values: curve.map(p => p.strategy) },
          ...(hasBench ? [{ label: results.find(x => x.benchmark)?.benchmark?.name ?? 'Benchmark', kind: 'benchmark' as const, values: curve.map(p => p.benchmark ?? null) }] : []),
          { label: 'CDI', kind: 'cdi', values: curve.map(p => p.cdi) },
        ],
      })
    )
  }
  select.addEventListener('change', drawChart)
  box.append(h('div', { class: 'quant-toolbar' }, field('q-b-curve', 'Estratégia no gráfico', select)), chartHost)
  drawChart()
  return box
}

function robustnessSection(report: BacktestReport): HTMLElement {
  const box = h('div', { class: 'quant-robust' })
  const rob = report.robustness
  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Robustez da seleção de parâmetros (walk-forward)'))
  if (!rob) {
    box.appendChild(notice('info', 'Robustez indisponível', 'Histórico insuficiente para o teste walk-forward.'))
    return box
  }
  const pbo = rob.probabilityOfOverfit
  const counts = new Map<string, number>()
  for (const name of rob.chosen ?? []) counts.set(name, (counts.get(name) ?? 0) + 1)
  box.appendChild(
    statGrid(
      statCard('Prob. de overfitting', fmtPct(pbo, 0), 'fração de folds em que o melhor do treino ficou na metade inferior no teste', pbo > 0.5 ? 'q-neg' : ''),
      statCard('Sharpe fora da amostra', fmtNum(rob.oosSharpe), 'ao escolher a melhor variante a cada fold'),
      statCard('Sharpe médio das variantes', fmtNum(rob.meanTrialOosSharpe), 'quanto "o acaso" rende fora da amostra'),
      statCard('Folds', String(rob.folds), `treino ${rob.trainDays}d · teste ${rob.testDays}d`),
      statCard('Variantes testadas', String(rob.variants?.length ?? 0), `${report.trialsCounted} tentativas contadas no DSR`)
    )
  )
  box.appendChild(
    pbo > 0.5
      ? notice('warn', 'Sinal de overfitting', 'Em mais da metade dos folds, a melhor variante do treino foi pior que a mediana no teste: escolher parâmetros pelo passado não está ajudando.')
      : notice('info', 'Leitura', 'Prob. de overfitting abaixo de 50% é necessária, mas não suficiente: com poucos folds a estimativa é ruidosa.')
  )
  if (counts.size > 0) {
    box.appendChild(h('p', { class: 'quant-hint' }, 'Variante escolhida por fold: ' + [...counts].map(([k, v]) => `${k} (${v}×)`).join(', ')))
  }
  const cscv = report.pbo
  if (cscv) {
    box.appendChild(h('h4', { class: 'quant-subtitle' }, 'PBO por CSCV (todas as variantes tentadas)'))
    box.appendChild(
      statGrid(
        statCard('PBO (CSCV)', fmtPct(cscv.pbo, 0), `${cscv.combinations} combinações · ${cscv.partitions} blocos · ${cscv.variants} variantes`, cscv.pbo > 0.5 ? 'q-neg' : ''),
        statCard('Sharpe do melhor: dentro → fora', `${fmtNum(cscv.meanIsSharpe * Math.sqrt(252))} → ${fmtNum(cscv.meanOosSharpe * Math.sqrt(252))}`, 'anualizado; a queda mede a degradação'),
        statCard('Prob. de perda fora da amostra', fmtPct(cscv.probOosLoss, 0), 'o melhor da amostra teve Sharpe fora negativo')
      )
    )
    box.appendChild(notice('info', 'Leitura', 'O PBO é estimado numa única amostra e oscila muito (mesmo com ruído puro pode ir de ~25% a ~90%). Confie mais em "degradação pequena + perda fora da amostra rara" do que no número isolado.'))
  }
  return box
}

function renderReport(report: BacktestReport, host: HTMLElement): void {
  const results = Array.isArray(report.results) ? report.results : []
  const caveats = Array.isArray(report.caveats) && report.caveats.length > 0 ? report.caveats : STATIC_CAVEATS

  // Ressalvas primeiro e sempre visíveis (nunca dentro de <details>).
  host.appendChild(notice('warn', 'Ressalvas — leia antes de interpretar os números', caveats))

  const first = results[0]
  host.appendChild(
    statGrid(
      statCard('Período', first ? `${fmtDate(first.startDate)} a ${fmtDate(first.endDate)}` : '—', first ? `${fmtNum(first.years, 1)} anos` : null),
      statCard('Ativos no painel', String(report.assets), report.missing?.length ? `${report.missing.length} sem dados` : 'todos com dados'),
      statCard('Benchmark', report.benchmark ?? 'indisponível'),
      statCard('CDI', report.cdiSource === 'bcb' ? 'Série do BCB' : 'Taxa constante (aproximação)'),
      statCard('Parâmetros', `topN ${report.params?.topN} · ${report.params?.years} anos`, `custos ${report.params?.costs ? 'sim' : 'não'} · IR ${report.params?.tax ? 'sim' : 'não'} · capital ${fmtBrl(report.params?.initialCapital, 0)}`),
      statCard('Gerado em', fmtDateTime(report.generatedAt))
    )
  )

  if (results.length === 0) {
    host.appendChild(notice('warn', 'Nenhuma estratégia produziu resultado', 'Amostra curta demais ou dados insuficientes para simular.'))
    return
  }

  host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Comparação: bruto x líquido'))
  host.appendChild(comparisonTable(results))
  const refs = referenceTable(results)
  if (refs) host.appendChild(refs)
  host.appendChild(
    bulletList(
      [
        'Bruto = sem corretagem, impacto de mercado e IR. Líquido = com tudo isso. O atrito mostra quanto do CAGR vira custo.',
        `Sharpe deflacionado (DSR) desconta o fato de que ${report.trialsCounted} variantes foram tentadas: sem isso, o melhor resultado é em parte sorte.`,
        report.missing?.length ? `Sem dados: ${report.missing.join(', ')}.` : '',
      ].filter(Boolean),
      'quant-list quant-hint-list'
    )
  )

  host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Curva de patrimônio'))
  host.appendChild(equitySection(results))
  host.appendChild(robustnessSection(report))
}

export function createBacktestTab(): TabModule {
  return {
    mount(panel) {
      const years = h('input', { type: 'number', min: 3, max: 15, step: 1, value: 8, required: true, inputmode: 'numeric' })
      const topN = h('input', { type: 'number', min: 3, max: 20, step: 1, value: 8, required: true, inputmode: 'numeric' })
      const out = h(
        'div',
        { class: 'quant-out', 'aria-live': 'polite' },
        notice('warn', 'Ressalvas gerais', STATIC_CAVEATS),
        h('p', { class: 'quant-hint' }, 'Escolha os parâmetros e execute. O backtest baixa vários anos de preços e pode levar de dezenas de segundos a alguns minutos.')
      )
      const form = h('form', { class: 'quant-form' })
      const run = h('button', { type: 'submit', class: 'primary-btn quant-btn' }, 'Executar backtest')
      form.append(
        h('div', { class: 'quant-form-grid' }, field('q-b-years', 'Anos de histórico (3 a 15)', years), field('q-b-topn', 'Ativos na carteira — topN (3 a 20)', topN, 'Quantos ativos as estratégias de ranking mantêm.')),
        h('div', { class: 'quant-actions' }, run)
      )
      form.addEventListener('submit', event => {
        event.preventDefault()
        if (!form.reportValidity()) return
        const y = Math.round(Number(years.value))
        const n = Math.round(Number(topN.value))
        void loadInto(
          out,
          'Rodando backtests (pode demorar)...',
          () => apiJson<BacktestReport>(`/api/backtest?years=${y}&topN=${n}`, {}, { timeoutMs: 600_000 }),
          renderReport,
          [run]
        )
      })
      panel.append(
        h('p', { class: 'quant-lead' }, 'Compara estratégias de referência com custos, impostos e CDI no caixa, sempre mostrando o resultado bruto ao lado do líquido.'),
        form,
        out
      )
    },
  }
}
