// Sub-aba "Carteira robusta": pesos x contribuição ao risco, diagnósticos, estresse e aderência ao IPS.

import { apiJson } from './research-api'
import {
  badge,
  bar,
  bulletList,
  button,
  field,
  fmtDate,
  fmtDateTime,
  fmtMult,
  fmtNum,
  fmtPct,
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
import { METHOD_LABEL, renderConstraints } from './research-ips'
import type { ConstructionReport, IpsCompliance, StressReport, TabContext, TabModule } from './research-types'

const METHOD_OPTIONS: Array<[string, string]> = [
  ['', 'Automático (conforme o IPS; sem IPS, HRP)'],
  ['hrp', METHOD_LABEL.hrp as string],
  ['erc', METHOD_LABEL.erc as string],
  ['ivol', METHOD_LABEL.ivol as string],
  ['minvar', METHOD_LABEL.minvar as string],
  ['meanvar', METHOD_LABEL.meanvar as string],
  ['bl', METHOD_LABEL.bl as string],
]

function weightsTable(report: ConstructionReport): HTMLElement {
  const weights = report.construction.weights ?? []
  const scale = Math.max(0.0001, ...weights.flatMap(w => [w.weight, w.riskContribution]).filter(isNum))
  const legend = h(
    'ul',
    { class: 'quant-legend' },
    h('li', null, h('span', { class: 'quant-key quant-key-strategy', 'aria-hidden': 'true' }), h('span', null, 'Peso na carteira')),
    h('li', null, h('span', { class: 'quant-key quant-key-benchmark', 'aria-hidden': 'true' }), h('span', null, 'Contribuição ao risco'))
  )
  const table = h(
    'table',
    { class: 'quant-table quant-weights' },
    h('caption', { class: 'sr-only' }, 'Peso e contribuição ao risco por ativo'),
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        th('Ativo', { left: true }),
        th('Peso', { left: true }),
        th('Contribuição ao risco', { left: true, title: 'Fatia da variância da carteira atribuída ao ativo. Se for maior que o peso, o ativo pesa mais no risco do que no capital.' }),
        th('Risco ÷ peso', { title: '> 1× = o ativo contribui ao risco mais do que seu peso.' })
      )
    ),
    h(
      'tbody',
      null,
      ...weights.map(w =>
        h(
          'tr',
          null,
          th(w.ticker, { scope: 'row', left: true }),
          h('td', { class: 't-left' }, h('div', { class: 'quant-bar-row' }, bar(w.weight / scale), h('span', { class: 'quant-bar-value' }, fmtPct(w.weight, 1)))),
          h('td', { class: 't-left' }, h('div', { class: 'quant-bar-row' }, bar(w.riskContribution / scale, true), h('span', { class: 'quant-bar-value' }, fmtPct(w.riskContribution, 1)))),
          td(w.weight > 0 ? fmtMult(w.riskContribution / w.weight, 2) : '—')
        )
      )
    )
  )
  return h('div', null, legend, tableWrap(table))
}

function diagnosticsGrid(report: ConstructionReport): HTMLElement {
  const d = report.construction.diagnostics
  return statGrid(
    statCard('Volatilidade anual', fmtPct(d.annualVol), 'estimada com covariância encolhida'),
    statCard('N efetivo', fmtNum(d.effectiveN, 1), `de ${d.assets} ativos no universo da janela`),
    statCard('Concentração (HHI)', fmtNum(d.herfindahl, 3), 'menor = mais diversificada'),
    statCard('Maior peso', fmtPct(d.maxWeight, 1)),
    statCard('Razão de diversificação', fmtNum(d.diversificationRatio, 2), '> 1 indica ganho de diversificação'),
    statCard('Encolhimento da covariância', fmtPct(d.covarianceShrinkage, 0), 'Ledoit-Wolf'),
    statCard('Encolhimento dos retornos', fmtPct(d.expectedReturnShrinkage, 0), 'retornos esperados puxados à média global'),
    statCard('Observações', String(d.observations), 'retornos diários na janela')
  )
}

function blSection(report: ConstructionReport): HTMLElement | null {
  const bl = report.construction.blackLitterman
  if (!bl) return null
  const box = h('div', { class: 'quant-bl' })
  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Black-Litterman: equilíbrio x visões de fator'))
  box.appendChild(
    statGrid(
      statCard('Visões de fator', String(bl.views), `IC ${fmtNum(bl.ic, 2)} · confiança ${fmtPct(bl.confidence, 0)}`),
      statCard('Equilíbrio', bl.marketWeightsSource === 'capitalizacao' ? 'Capitalização de mercado' : 'Pesos iguais (sem capitalização)', `τ ${fmtNum(bl.tau, 2)} · aversão ao risco ${fmtNum(bl.riskAversion, 1)}`)
    )
  )
  if (bl.marketWeightsSource !== 'capitalizacao') {
    box.appendChild(notice('warn', 'Equilíbrio aproximado', 'Sem valor de mercado para todos os ativos, o equilíbrio usa pesos iguais: o resultado é só ilustrativo.'))
  }
  const rows = [...bl.assets].sort((a, b) => b.posteriorAnnual - b.equilibriumAnnual - (a.posteriorAnnual - a.equilibriumAnnual))
  const table = h('table', { class: 'quant-table' })
  table.appendChild(h('caption', { class: 'quant-sr' }, 'Retorno anualizado de equilíbrio e posterior por ativo'))
  table.appendChild(h('thead', null, h('tr', null, th('Ativo'), th('Equilíbrio a.a.'), th('Posterior a.a.'), th('Ajuste'))))
  const body = h('tbody')
  for (const r of rows) {
    const delta = r.posteriorAnnual - r.equilibriumAnnual
    body.appendChild(h('tr', null, h('th', { scope: 'row' }, r.ticker), td(fmtPct(r.equilibriumAnnual, 1)), td(fmtPct(r.posteriorAnnual, 1)), td(`${delta >= 0 ? '+' : '−'}${fmtPct(Math.abs(delta), 1)}`)))
  }
  table.appendChild(body)
  box.appendChild(table)
  return box
}

function sectorsTable(report: ConstructionReport): HTMLElement | null {
  const sectors = report.sectors ?? []
  if (sectors.length === 0) return null
  const limit = report.params?.maxSector
  const scale = Math.max(0.0001, ...sectors.map(x => x.weight))
  return tableWrap(
    h(
      'table',
      { class: 'quant-table' },
      h('caption', { class: 'sr-only' }, 'Peso por setor'),
      h('thead', null, h('tr', null, th('Setor', { left: true }), th('Peso', { left: true }), th('Limite'))),
      h(
        'tbody',
        null,
        ...sectors.map(sec => {
          const over = isNum(limit) && sec.weight > limit + 1e-6
          return h(
            'tr',
            null,
            th(sec.sector, { scope: 'row', left: true }),
            h('td', { class: 't-left' }, h('div', { class: 'quant-bar-row' }, bar(sec.weight / scale), h('span', { class: 'quant-bar-value' }, fmtPct(sec.weight, 1)))),
            h('td', { class: over ? 'q-neg' : '' }, isNum(limit) ? `${fmtPct(limit, 0)}${over ? ' — excedido' : ''}` : '—')
          )
        })
      )
    )
  )
}

function stressSection(stress: StressReport): HTMLElement {
  const box = h('div', { class: 'quant-stress' })
  const t = stress.tail
  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Cenários históricos de crise (carteira atual reaplicada ao passado)'))
  box.appendChild(
    statGrid(
      statCard('Pior perda em cenário', fmtSignedPct(stress.worstScenarioLoss, 1), 'carteira 100% em ações', signClass(stress.worstScenarioLoss)),
      stress.correlationInCrisis
        ? statCard('Correlação média com o mercado', `${fmtNum(stress.correlationInCrisis.normal, 2)} → ${fmtNum(stress.correlationInCrisis.stressed, 2)}`, 'dias normais → 10% piores dias')
        : null
    )
  )
  const cc = stress.correlationInCrisis
  if (cc && isNum(cc.normal) && isNum(cc.stressed) && cc.stressed > cc.normal) {
    box.appendChild(notice('warn', 'A correlação sobe na crise', 'Nos piores dias do mercado os ativos andam mais juntos: a diversificação protege menos justamente quando mais se precisa.'))
  }

  const scenarios = stress.scenarios ?? []
  if (scenarios.length > 0) {
    box.appendChild(
      tableWrap(
        h(
          'table',
          { class: 'quant-table' },
          h('caption', { class: 'sr-only' }, 'Replays de crises históricas'),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              th('Cenário', { left: true }),
              th('Cobertura', { title: 'Parcela da carteira com preço na época (ativos mais novos ficam de fora).' }),
              th('Carteira'),
              th('Máx. DD'),
              th('Ibovespa'),
              th('Pior ativo', { left: true })
            )
          ),
          h(
            'tbody',
            null,
            ...scenarios.map(sc =>
              h(
                'tr',
                null,
                h(
                  'th',
                  { scope: 'row', class: 't-left' },
                  h('strong', null, sc.name),
                  h('span', { class: 'quant-sub' }, `${fmtDate(sc.from)} a ${fmtDate(sc.to)}${sc.missing?.length ? ` · sem preço: ${sc.missing.join(', ')}` : ''}`)
                ),
                td(fmtPct(sc.coverage, 0), isNum(sc.coverage) && sc.coverage < 0.8 ? 'q-warn' : ''),
                td(fmtSignedPct(sc.portfolioReturn, 1), signClass(sc.portfolioReturn)),
                td(fmtSignedPct(sc.maxDrawdown, 1), signClass(sc.maxDrawdown)),
                td(fmtSignedPct(sc.benchmarkReturn, 1), signClass(sc.benchmarkReturn)),
                h('td', { class: 't-left' }, sc.worstAsset ? `${sc.worstAsset.ticker} (${fmtSignedPct(sc.worstAsset.ret, 1)})` : '—')
              )
            )
          )
        )
      )
    )
  }

  const shocks = stress.shocks ?? []
  if (shocks.length > 0) {
    box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Choques hipotéticos de mercado (aproximação linear por beta)'))
    box.appendChild(
      tableWrap(
        h(
          'table',
          { class: 'quant-table' },
          h('caption', { class: 'sr-only' }, 'Choques hipotéticos'),
          h('thead', null, h('tr', null, th('Choque no mercado'), th('Efeito na carteira'), th('Ativos com beta 1 assumido', { left: true }))),
          h(
            'tbody',
            null,
            ...shocks.map(sh =>
              h(
                'tr',
                null,
                td(fmtSignedPct(sh.marketShock, 0), signClass(sh.marketShock)),
                td(fmtSignedPct(sh.portfolioReturn, 1), signClass(sh.portfolioReturn)),
                h('td', { class: 't-left wrap' }, sh.assumedBeta1?.length ? `${sh.assumedBeta1.length}: ${sh.assumedBeta1.join(', ')}` : 'nenhum')
              )
            )
          )
        )
      )
    )
  }

  if (t) {
    box.appendChild(h('h4', { class: 'quant-subtitle' }, `Cauda da distribuição (${t.observations} retornos diários)`))
    const rows: Array<[string, string, string]> = [
      ['VaR 95% histórico / CVaR 95%', `${fmtPct(t.historicalVar95, 2)} / ${fmtPct(t.historicalCvar95, 2)}`, 'Perda diária que só é superada em 5% dos dias / média das perdas além dela.'],
      ['VaR 99% histórico / CVaR 99%', `${fmtPct(t.historicalVar99, 2)} / ${fmtPct(t.historicalCvar99, 2)}`, 'Idem para 1% dos dias.'],
      ['VaR 99% normal / Cornish-Fisher', `${fmtPct(t.normalVar99, 2)} / ${fmtPct(t.cornishFisherVar99, 2)}`, 'Cornish-Fisher corrige a normal por assimetria e curtose.'],
      ['Subestimação do VaR 99% normal', fmtMult(t.normalUnderestimation99, 2), '> 1× = a normal subestima o risco de cauda observado.'],
      ['Assimetria / curtose em excesso', `${fmtNum(t.skew, 2)} / ${fmtNum(t.excessKurtosis, 2)}`, 'Curtose alta = caudas gordas (eventos extremos mais frequentes que na normal).'],
      ['Pior dia / pior semana', `${fmtPct(t.worstDay, 2)} / ${fmtPct(t.worstWeek, 2)}`, 'Na janela analisada.'],
    ]
    box.appendChild(
      tableWrap(
        h(
          'table',
          { class: 'quant-table' },
          h('caption', { class: 'sr-only' }, 'Diagnóstico de cauda'),
          h('thead', null, h('tr', null, th('Métrica', { left: true }), th('Valor'), th('Leitura', { left: true }))),
          h('tbody', null, ...rows.map(([label, value, note]) => h('tr', null, th(label, { scope: 'row', left: true }), td(value), h('td', { class: 't-left wrap' }, note))))
        )
      )
    )
  }
  return box
}

function complianceSection(ips: IpsCompliance): HTMLElement {
  const box = h('div', { class: 'quant-compliance' })
  box.appendChild(
    h('p', null, h('strong', null, 'Aderência ao IPS: '), ips.compliant ? badge('ok', '✓ Aderente') : badge('bad', '✗ Fora do IPS'), ` · fração do patrimônio em ações: até ${fmtPct(ips.equityShare, 0)}`)
  )
  const checks = ips.checks ?? []
  box.appendChild(
    tableWrap(
      h(
        'table',
        { class: 'quant-table' },
        h('caption', { class: 'sr-only' }, 'Checagens de aderência ao IPS'),
        h('thead', null, h('tr', null, th('Checagem', { left: true }), th('Situação', { left: true }), th('Valor'), th('Limite'))),
        h(
          'tbody',
          null,
          ...checks.map(c => {
            const isSuit = c.id === 'suitability'
            return h(
              'tr',
              null,
              h('th', { scope: 'row', class: 't-left wrap' }, c.label),
              h('td', { class: 't-left' }, c.ok ? badge('ok', '✓ OK') : badge('bad', '✗ Falhou')),
              td(isSuit ? '—' : isNum(c.value) ? fmtPct(c.value, 1) : 'n/d (rode com estresse)'),
              td(isSuit ? '—' : fmtPct(c.limit, 1))
            )
          })
        )
      )
    )
  )
  box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Restrições derivadas do IPS'))
  box.appendChild(renderConstraints(ips.constraints))
  return box
}

export function createPortfolioTab(ctx: TabContext): TabModule {
  return {
    mount(panel) {
      const method = h('select', null, ...METHOD_OPTIONS.map(([value, label]) => h('option', { value }, label)))
      const stress = h('input', { type: 'checkbox', id: 'q-p-stress' })
      const out = h(
        'div',
        { class: 'quant-out', 'aria-live': 'polite' },
        h('p', { class: 'quant-hint' }, 'Escolha o método e construa. Com estresse, o servidor baixa ~18 anos de preços e leva mais tempo.')
      )
      const run = h('button', { type: 'submit', class: 'primary-btn quant-btn' }, 'Construir carteira')
      const form = h('form', { class: 'quant-form' })
      form.append(
        h(
          'div',
          { class: 'quant-form-grid' },
          field('q-p-method', 'Método de construção', method),
          h('div', { class: 'form-group quant-check-field' }, h('label', { class: 'quant-check-label' }, stress, ' Incluir testes de estresse e diagnóstico de cauda (mais lento)'))
        ),
        h('div', { class: 'quant-actions' }, run)
      )
      form.addEventListener('submit', event => {
        event.preventDefault()
        const params = new URLSearchParams()
        if (method.value) params.set('method', method.value)
        if (stress.checked) params.set('stress', '1')
        const qs = params.toString()
        void loadInto(
          out,
          stress.checked ? 'Construindo carteira e rodando estresse (pode demorar)...' : 'Construindo carteira...',
          () => apiJson<ConstructionReport>(`/api/portfolio/construct${qs ? `?${qs}` : ''}`, {}, { timeoutMs: 600_000 }),
          (report, host) => render(report, host, ctx),
          [run]
        )
      })

      panel.append(
        h('p', { class: 'quant-lead' }, 'Pesos calculados só com risco (covariância encolhida): sem extrapolar retornos passados. Os pesos descrevem a fração dentro da parcela em ações; o IPS define quanto do patrimônio vai para ações.'),
        form,
        out
      )
    },
  }
}

function render(report: ConstructionReport, host: HTMLElement, ctx: TabContext): void {
  const c = report.construction
  const p = report.params
  host.appendChild(
    statGrid(
      statCard('Método', METHOD_LABEL[c.method] ?? c.method),
      statCard('Preços até', fmtDate(report.asOf), `janela de ${p.lookbackDays} pregões`),
      statCard('Limites aplicados', `${fmtPct(p.maxWeight, 0)} por ativo`, `${fmtPct(p.maxSector, 0)} por setor`),
      statCard('Gerado em', fmtDateTime(report.generatedAt))
    )
  )
  if (Array.isArray(report.notes) && report.notes.length > 0) host.appendChild(notice('info', 'Como ler', report.notes))
  if (Array.isArray(report.excluded) && report.excluded.length > 0) {
    host.appendChild(notice('warn', 'Ativos fora da carteira por histórico incompleto na janela', report.excluded.join(', ')))
  }

  host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Pesos x contribuição ao risco'))
  host.appendChild(weightsTable(report))
  host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Diagnósticos da carteira'))
  host.appendChild(diagnosticsGrid(report))
  if (report.construction.diagnostics.capsRelaxed) {
    const d = report.construction.diagnostics
    host.appendChild(notice('warn', 'Tetos inviáveis foram relaxados', `Os limites pedidos não permitem somar 100%. Tetos efetivos: ${fmtPct(d.effectiveMaxWeight ?? 0, 1)} por ativo e ${fmtPct(d.effectiveMaxSector ?? 0, 1)} por setor.`))
  }
  const bl = blSection(report)
  if (bl) host.appendChild(bl)

  const sectors = sectorsTable(report)
  if (sectors) {
    host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Concentração por setor'))
    host.appendChild(sectors)
  }

  if (report.stress) host.appendChild(stressSection(report.stress))
  else if (p.includeStress) host.appendChild(notice('warn', 'Estresse indisponível', 'O servidor não devolveu o relatório de estresse para esta execução.'))

  host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Aderência ao IPS'))
  if (report.ips) host.appendChild(complianceSection(report.ips))
  else {
    host.appendChild(
      notice(
        'info',
        'Nenhum IPS configurado',
        'Defina seu perfil na aba IPS para checar posição máxima, setor, perda em estresse e adequação.',
        h('div', { class: 'quant-actions' }, button('Configurar IPS', () => ctx.goToTab('ips'), 'secondary'))
      )
    )
  }
  host.appendChild(bulletList(['Estas checagens são educacionais e dependem de dados históricos; não substituem avaliação profissional.'], 'quant-list quant-hint-list'))
}
