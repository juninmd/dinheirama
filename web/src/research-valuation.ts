// Valuation (DCF de FCFE / DDM) com cenários e sensibilidade — aberto a partir da linha do ranking.

import { apiJson } from './research-api'
import { bulletList, fmtBrl, fmtBrlCompact, fmtNum, fmtPct, fmtSignedPct, h, isNum, loadInto, notice, signClass, statCard, statGrid, tableWrap, td, th } from './research-dom'
import type { ValuationResult } from './research-types'

const METHOD_LABEL: Record<ValuationResult['method'], string> = {
  'dcf-fcfe': 'DCF do fluxo de caixa livre ao acionista (FCFE)',
  ddm: 'Desconto de dividendos (modelo de Gordon)',
  indisponivel: 'Indisponível para este ativo',
}

const SCENARIO_LABEL: Record<string, string> = { pessimista: 'Pessimista', base: 'Base', otimista: 'Otimista' }

export function loadValuation(host: HTMLElement, ticker: string, controls: HTMLButtonElement[] = []): Promise<void> {
  return loadInto(
    host,
    `Calculando valuation de ${ticker}...`,
    () => apiJson<ValuationResult>(`/api/valuation/${encodeURIComponent(ticker)}`, {}, { timeoutMs: 60_000 }),
    renderValuation,
    controls
  )
}

function renderValuation(data: ValuationResult, host: HTMLElement): void {
  const warnings = Array.isArray(data.warnings) ? data.warnings : []
  host.appendChild(h('h4', { class: 'quant-subtitle' }, `Valuation — ${data.ticker}`))
  host.appendChild(h('p', { class: 'quant-hint' }, `Método: ${METHOD_LABEL[data.method] ?? data.method}`))

  if (data.method === 'indisponivel') {
    host.appendChild(notice('warn', 'Valuation indisponível', warnings.length ? warnings : ['Sem dados suficientes para este ativo.']))
    return
  }

  const price = data.price
  host.appendChild(
    statGrid(
      statCard('Preço atual', fmtBrl(price)),
      statCard('Valor por ação (base)', fmtBrl(data.valuePerShare)),
      statCard('Margem de segurança (base)', fmtSignedPct(data.marginOfSafety, 0), '(valor − preço) ÷ valor', signClass(data.marginOfSafety)),
      isNum(data.baseFcf) ? statCard('FCF normalizado', fmtBrlCompact(data.baseFcf), 'base do DCF') : null
    )
  )

  const a = data.assumptions
  host.appendChild(
    h(
      'dl',
      { class: 'quant-dl' },
      ...[
        ['Taxa livre de risco', fmtPct(a.riskFree)],
        ['Prêmio de risco (ERP)', fmtPct(a.equityRiskPremium)],
        ['Beta', fmtNum(a.beta)],
        ['Custo do capital', fmtPct(a.costOfEquity)],
        ['Crescimento inicial', fmtPct(a.initialGrowth)],
        ['Crescimento terminal', fmtPct(a.terminalGrowth)],
        ['Horizonte explícito', `${fmtNum(a.years, 0)} anos`],
      ].map(([label, value]) => h('div', { class: 'quant-dl-item' }, h('dt', null, label), h('dd', null, value)))
    )
  )

  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : []
  if (scenarios.length > 0) {
    host.appendChild(
      tableWrap(
        h(
          'table',
          { class: 'quant-table' },
          h('caption', { class: 'sr-only' }, 'Cenários de valuation'),
          h('thead', null, h('tr', null, th('Cenário', { left: true }), th('Crescimento inicial'), th('Custo do capital'), th('Valor por ação'), th('Margem de segurança'))),
          h(
            'tbody',
            null,
            ...scenarios.map(sc =>
              h(
                'tr',
                null,
                th(SCENARIO_LABEL[sc.label] ?? sc.label, { scope: 'row', left: true }),
                td(fmtPct(sc.initialGrowth)),
                td(fmtPct(sc.costOfEquity)),
                td(fmtBrl(sc.valuePerShare)),
                td(fmtSignedPct(sc.marginOfSafety, 0), signClass(sc.marginOfSafety))
              )
            )
          )
        )
      )
    )
  }

  const sens = data.sensitivity
  if (sens && sens.growths?.length && sens.costsOfEquity?.length) {
    host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Sensibilidade do valor por ação'))
    host.appendChild(
      h('p', { class: 'quant-hint' }, 'Linhas: crescimento inicial do fluxo. Colunas: custo do capital. Células em verde estão acima do preço atual; em vermelho, abaixo; "—" = modelo não se aplica.')
    )
    host.appendChild(
      tableWrap(
        h(
          'table',
          { class: 'quant-table quant-sens' },
          h('caption', { class: 'sr-only' }, 'Valor por ação por crescimento inicial e custo do capital'),
          h('thead', null, h('tr', null, th('Crescimento \\ Custo', { left: true }), ...sens.costsOfEquity.map(c => th(fmtPct(c))))),
          h(
            'tbody',
            null,
            ...sens.growths.map((g, i) =>
              h(
                'tr',
                null,
                th(fmtPct(g), { scope: 'row', left: true }),
                ...sens.costsOfEquity.map((_, j) => {
                  const v = sens.values?.[i]?.[j]
                  if (!isNum(v)) return td('—', 'sens-na')
                  if (!isNum(price)) return td(fmtNum(v))
                  const above = v >= price
                  return h('td', { class: above ? 'sens-above' : 'sens-below' }, fmtNum(v), h('span', { class: 'sr-only' }, above ? ' (acima do preço)' : ' (abaixo do preço)'))
                })
              )
            )
          )
        )
      )
    )
  }

  if (warnings.length > 0) host.appendChild(notice('warn', 'Leia antes de usar', warnings))
  else host.appendChild(bulletList(['Valuation é muito sensível às premissas.']))
}
