// Sub-aba "IPS": Investment Policy Statement (perfil, limites) e restrições derivadas.

import { apiJson, type FieldLabels } from './research-api'
import { badge, bulletList, button, errorNotice, field, fmtPct, h, isNum, loadInto, notice, statCard, statGrid } from './research-dom'
import type { Ips, IpsConstraints, IpsObjective, IpsResponse, TabContext, TabModule } from './research-types'

export const OBJECTIVE_LABEL: Record<IpsObjective, string> = {
  preservation: 'Preservação do capital',
  income: 'Renda (dividendos)',
  balanced: 'Equilibrado',
  growth: 'Crescimento',
}

export const METHOD_LABEL: Record<string, string> = {
  hrp: 'HRP (paridade de risco hierárquica)',
  erc: 'ERC (risk parity)',
  ivol: 'Inverso da volatilidade',
  minvar: 'Mínima variância',
  meanvar: 'Média-variância encolhida',
  bl: 'Black-Litterman (equilíbrio de mercado + visões de fator)',
}

const FIELD_LABELS: FieldLabels = {
  objective: 'Objetivo',
  horizonYears: 'Horizonte (anos)',
  maxDrawdownTolerance: 'Queda máxima suportável',
  maxPositionWeight: 'Posição máxima por ativo',
  maxSectorWeight: 'Setor máximo',
  capital: 'Capital',
  emergencyFundMonths: 'Reserva de emergência (meses)',
  hasHighInterestDebt: 'Dívida cara',
  monthlyContribution: 'Aporte mensal',
  notes: 'Observações',
}

const SUITABILITY: Record<IpsConstraints['suitability'], { tone: 'ok' | 'warn' | 'bad'; label: string }> = {
  adequado: { tone: 'ok', label: 'Adequado a renda variável' },
  cautela: { tone: 'warn', label: 'Cautela' },
  inadequado: { tone: 'bad', label: 'Inadequado a renda variável' },
}

/** Restrições derivadas do IPS (usado aqui e na checagem de aderência da carteira). */
export function renderConstraints(c: IpsConstraints): HTMLElement {
  const suit = SUITABILITY[c.suitability] ?? { tone: 'warn' as const, label: String(c.suitability) }
  const box = h('div', { class: 'quant-constraints' })
  box.appendChild(h('p', null, h('strong', null, 'Adequação do perfil: '), badge(suit.tone, suit.label)))
  box.appendChild(
    statGrid(
      statCard('Máx. do patrimônio em ações', fmtPct(c.maxEquityShare, 0), 'o restante fica em CDI/renda fixa'),
      statCard('Método sugerido', METHOD_LABEL[c.method] ?? c.method),
      statCard('Posição máxima', fmtPct(c.maxWeight, 1), 'por ativo, dentro da parcela em ações'),
      statCard('Setor máximo', fmtPct(c.maxSector, 0), 'dentro da parcela em ações')
    )
  )
  if (Array.isArray(c.warnings) && c.warnings.length > 0) {
    box.appendChild(notice(c.suitability === 'inadequado' ? 'bad' : 'warn', 'Avisos do seu perfil', c.warnings))
  } else {
    box.appendChild(notice('ok', 'Sem avisos do perfil', 'Nenhum alerta de reserva, dívida ou horizonte.'))
  }
  if (Array.isArray(c.rationale) && c.rationale.length > 0) {
    box.appendChild(h('h4', { class: 'quant-subtitle' }, 'Como as restrições foram derivadas'))
    box.appendChild(bulletList(c.rationale))
  }
  return box
}

const pctToFraction = (pct: number): number => Number((pct / 100).toFixed(4))
const fractionToPct = (f: number): number => Number((f * 100).toFixed(2))

export function createIpsTab(ctx: TabContext): TabModule {
  let loaded = false
  let busy = false
  let form!: HTMLFormElement
  let status!: HTMLElement
  let result!: HTMLElement
  let saveBtn!: HTMLButtonElement

  const control = <T extends HTMLElement>(id: string): T => form.querySelector<T>(`#${id}`) as T

  function fill(ips: Ips | null): void {
    if (!ips) return
    control<HTMLSelectElement>('q-ips-objective').value = ips.objective
    control<HTMLInputElement>('q-ips-horizon').value = String(ips.horizonYears)
    control<HTMLInputElement>('q-ips-drawdown').value = String(fractionToPct(ips.maxDrawdownTolerance))
    control<HTMLInputElement>('q-ips-position').value = String(fractionToPct(ips.maxPositionWeight))
    control<HTMLInputElement>('q-ips-sector').value = String(fractionToPct(ips.maxSectorWeight))
    control<HTMLInputElement>('q-ips-capital').value = String(ips.capital)
    control<HTMLInputElement>('q-ips-emergency').value = String(ips.emergencyFundMonths)
    control<HTMLInputElement>('q-ips-debt').checked = ips.hasHighInterestDebt === true
    control<HTMLInputElement>('q-ips-contribution').value = isNum(ips.monthlyContribution) ? String(ips.monthlyContribution) : ''
    control<HTMLTextAreaElement>('q-ips-notes').value = ips.notes ?? ''
  }

  function renderResponse(data: IpsResponse, host: HTMLElement): void {
    if (!data.ips || !data.constraints) {
      host.appendChild(notice('info', 'Nenhum IPS definido ainda', 'Preencha o formulário e salve. Sem IPS, a carteira robusta usa limites padrão (15% por ativo, 35% por setor, HRP).'))
      return
    }
    host.appendChild(h('h4', { class: 'quant-subtitle' }, 'Restrições derivadas do seu IPS'))
    host.appendChild(renderConstraints(data.constraints))
  }

  function load(): void {
    if (busy) return
    busy = true
    void loadInto(
      result,
      'Carregando IPS...',
      async () => {
        const data = await apiJson<IpsResponse>('/api/ips', {}, { timeoutMs: 30_000 })
        fill(data.ips)
        return data
      },
      renderResponse
    ).then(() => {
      busy = false
      loaded = result.querySelector('.quant-notice-bad') === null
    })
  }

  function readPayload(): Ips {
    const num = (id: string): number => control<HTMLInputElement>(id).valueAsNumber
    const payload: Ips = {
      objective: control<HTMLSelectElement>('q-ips-objective').value as IpsObjective,
      horizonYears: num('q-ips-horizon'),
      maxDrawdownTolerance: pctToFraction(num('q-ips-drawdown')),
      maxPositionWeight: pctToFraction(num('q-ips-position')),
      maxSectorWeight: pctToFraction(num('q-ips-sector')),
      capital: num('q-ips-capital'),
      emergencyFundMonths: num('q-ips-emergency'),
      hasHighInterestDebt: control<HTMLInputElement>('q-ips-debt').checked,
    }
    const contribution = control<HTMLInputElement>('q-ips-contribution').value.trim()
    if (contribution !== '') payload.monthlyContribution = Number(contribution)
    const notes = control<HTMLTextAreaElement>('q-ips-notes').value.trim()
    if (notes !== '') payload.notes = notes
    return payload
  }

  async function save(): Promise<void> {
    if (!form.reportValidity()) return
    status.replaceChildren()
    saveBtn.disabled = true
    try {
      const data = await apiJson<IpsResponse>('/api/ips', { method: 'PUT', body: JSON.stringify(readPayload()) }, { timeoutMs: 30_000, labels: FIELD_LABELS })
      result.replaceChildren()
      renderResponse(data, result)
      status.replaceChildren(
        notice(
          'ok',
          'IPS salvo',
          'As restrições abaixo valem para a carteira robusta. Reconstrua a carteira para checar a aderência.',
          h('div', { class: 'quant-actions' }, button('Ir para a carteira robusta', () => ctx.goToTab('portfolio'), 'secondary'))
        )
      )
    } catch (error) {
      status.replaceChildren(errorNotice(error))
    } finally {
      saveBtn.disabled = false
    }
  }

  return {
    mount(panel) {
      const number = (attrs: Record<string, string | number | boolean>) => h('input', { type: 'number', inputmode: 'decimal', ...attrs })
      form = h('form', { class: 'quant-form', 'aria-label': 'Investment Policy Statement' })
      form.append(
        h(
          'div',
          { class: 'quant-form-grid' },
          field(
            'q-ips-objective',
            'Objetivo',
            h('select', { required: true }, ...(Object.keys(OBJECTIVE_LABEL) as IpsObjective[]).map(k => h('option', { value: k, selected: k === 'balanced' }, OBJECTIVE_LABEL[k])))
          ),
          field('q-ips-horizon', 'Horizonte (anos)', number({ min: 0.5, max: 60, step: 0.5, value: 10, required: true }), 'De 0,5 a 60. Menos de 3 anos é considerado inadequado para ações.'),
          field('q-ips-drawdown', 'Queda máxima suportável (%)', number({ min: 5, max: 90, step: 0.5, value: 25, required: true }), 'Perda que você aguenta ver na carteira sem vender em pânico (5 a 90).'),
          field('q-ips-position', 'Posição máxima por ativo (%)', number({ min: 3, max: 50, step: 0.5, value: 15, required: true }), 'De 3 a 50.'),
          field('q-ips-sector', 'Setor máximo (%)', number({ min: 10, max: 100, step: 1, value: 35, required: true }), 'De 10 a 100.'),
          field('q-ips-capital', 'Capital disponível (R$)', number({ min: 0.01, step: 0.01, required: true, placeholder: 'ex.: 50000' }), 'Maior que zero.'),
          field('q-ips-emergency', 'Reserva de emergência (meses de gasto)', number({ min: 0, max: 120, step: 0.5, value: 6, required: true }), 'Menos de 6 meses gera aviso de inadequação.'),
          field('q-ips-contribution', 'Aporte mensal (R$, opcional)', number({ min: 0, step: 0.01 }))
        ),
        h(
          'div',
          { class: 'form-group quant-check-field' },
          h('label', { class: 'quant-check-label' }, h('input', { type: 'checkbox', id: 'q-ips-debt' }), ' Tenho dívida cara (cartão de crédito, cheque especial)')
        ),
        field('q-ips-notes', 'Observações (opcional, até 500 caracteres)', h('textarea', { rows: 2, maxlength: 500 })),
        h('div', { class: 'quant-actions' }, (saveBtn = h('button', { type: 'submit', class: 'primary-btn quant-btn' }, 'Salvar IPS')))
      )
      form.addEventListener('submit', event => {
        event.preventDefault()
        void save()
      })

      status = h('div', { class: 'quant-status', role: 'status', 'aria-live': 'polite' })
      result = h('div', { class: 'quant-out', 'aria-live': 'polite' })
      panel.append(
        h('p', { class: 'quant-lead' }, 'O IPS registra seu perfil e limites. Ele define quanto do patrimônio pode ir para ações, o método de construção e os tetos por posição e setor.'),
        form,
        status,
        result
      )
    },
    onShow() {
      if (!loaded) load()
    },
  }
}
