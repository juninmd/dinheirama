import { h } from '../research-dom'
import { type Route, type View } from '../router'
import type { Action, Alert, AlertCondition, AlertHistory, AlertType, IntegrationStatus } from '../types'
import { api } from '../ui/api'
import { confirmDialog } from '../ui/dialog'
import { GRID_MAIN_SIDE, STACK, emptyState, errorState, pill, sectionTitle, segmented, setBusy, skeleton, tickerInput, viewHeader } from '../ui/components'
import { ACTION_LABEL, fmtBrl, fmtDateTime, fmtNum, isNum, isValidTicker, relTime, shortTicker, stripTags, toTicker } from '../ui/format'
import { icon } from '../ui/icons'
import { toast } from '../ui/toast'

const TYPE_LABEL: Record<AlertType, string> = { price: 'Preço', rsi: 'RSI (14)', ml_signal: 'Sinal da IA' }

function describeRule(a: Pick<Alert, 'ticker' | 'type' | 'condition' | 'value'>): string {
  const t = shortTicker(a.ticker)
  if (a.type === 'ml_signal') return `${t}: sinal da IA igual a “${ACTION_LABEL[a.value as Action] ?? String(a.value)}”`
  const dir = a.condition === 'above' ? 'acima de' : 'abaixo de'
  const target = a.type === 'price' ? fmtBrl(Number(a.value)) : fmtNum(Number(a.value), 0)
  return `${t}: ${a.type === 'price' ? 'preço' : 'RSI'} ${dir} ${target}`
}

export function createAlertsView(): View {
  const el = h('div', { class: STACK })

  // ---- Formulário ----------------------------------------------------------
  const ticker = tickerInput({ id: 'alert-ticker', label: 'Ativo', placeholder: 'Ex.: PETR4' })
  let type: AlertType = 'price'
  const typePicker = segmented<AlertType>({
    label: 'Tipo de alerta',
    value: type,
    options: [{ value: 'price', label: 'Preço' }, { value: 'rsi', label: 'RSI' }, { value: 'ml_signal', label: 'Sinal da IA' }],
    onChange: v => {
      type = v
      syncFields()
    },
  })
  const condition = h('select', { class: 'select', id: 'alert-condition' }, h('option', { value: 'above' }, 'ficar acima de'), h('option', { value: 'below' }, 'ficar abaixo de'))
  const valueInput = h('input', { class: 'input', id: 'alert-value', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Ex.: 42,50' })
  const signalSelect = h('select', { class: 'select', id: 'alert-signal' }, ...(['buy', 'hold', 'sell'] as const).map(a => h('option', { value: a }, ACTION_LABEL[a])))
  const valueLabel = h('label', { for: 'alert-value' }, 'Valor (R$)')
  const conditionField = h('div', { class: 'field' }, h('label', { for: 'alert-condition' }, 'Disparar quando'), condition)
  const valueField = h('div', { class: 'field' }, valueLabel, valueInput)
  const signalField = h('div', { class: 'field' }, h('label', { for: 'alert-signal' }, 'Sinal igual a'), signalSelect)
  const preview = h('p', { class: 'min-h-[1.4em] font-semibold text-brand empty:hidden', 'aria-live': 'polite' })
  const formHint = h('p', { class: 'field-hint', role: 'status' })
  const createBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus', 18), 'Criar alerta')
  const form = h(
    'form',
    { class: 'card grid gap-[18px] [&>div:first-child]:mb-0', novalidate: true },
    sectionTitle('Novo alerta'),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'O que acompanhar'), typePicker.el),
    h('div', { class: 'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-[18px] gap-y-3.5' }, h('div', { class: 'field' }, h('label', { for: 'alert-ticker' }, 'Ativo'), ticker), conditionField, valueField, signalField),
    preview,
    formHint,
    h('div', { class: 'flex justify-end' }, createBtn)
  )

  function syncFields(): void {
    const ml = type === 'ml_signal'
    conditionField.hidden = ml
    valueField.hidden = ml
    signalField.hidden = !ml
    valueLabel.textContent = type === 'price' ? 'Valor (R$)' : 'Nível do RSI (0–100)'
    valueInput.placeholder = type === 'price' ? 'Ex.: 42,50' : 'Ex.: 30 ou 70'
    updatePreview()
  }

  /** Aceita "42,50", "42.50" e "1.234,56"; devolve null se não for número. */
  function parseValue(): number | null {
    let raw = valueInput.value.trim().replace(/^R\$\s*/i, '')
    if (!raw) return null
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.')
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  function updatePreview(): void {
    const t = toTicker(ticker.value)
    if (!t) {
      preview.textContent = ''
      return
    }
    if (type === 'ml_signal') {
      preview.textContent = `Avisar quando o sinal da IA para ${shortTicker(t)} for “${ACTION_LABEL[signalSelect.value as Action]}”.`
      return
    }
    const n = parseValue()
    if (n === null) {
      preview.textContent = ''
      return
    }
    preview.textContent = `Avisar quando ${type === 'price' ? 'o preço de' : 'o RSI de'} ${shortTicker(t)} ficar ${condition.value === 'above' ? 'acima' : 'abaixo'} de ${type === 'price' ? fmtBrl(n) : fmtNum(n, 0)}.`
  }
  for (const control of [ticker, condition, valueInput, signalSelect]) control.addEventListener('input', updatePreview)

  form.addEventListener('submit', event => {
    event.preventDefault()
    void createAlert()
  })

  async function createAlert(): Promise<void> {
    formHint.textContent = ''
    const t = toTicker(ticker.value)
    if (!t || !isValidTicker(t)) {
      formHint.textContent = 'Informe o código do ativo no formato da B3, como PETR4.'
      ticker.focus()
      return
    }
    let value: number | string
    let cond: AlertCondition
    if (type === 'ml_signal') {
      value = signalSelect.value
      cond = 'action_equals'
    } else {
      const n = parseValue()
      if (n === null || (type === 'price' && n <= 0) || (type === 'rsi' && (n < 0 || n > 100))) {
        formHint.textContent = type === 'rsi' ? 'Digite um nível de RSI entre 0 e 100.' : 'Digite um valor numérico maior que zero.'
        valueInput.focus()
        return
      }
      value = n
      cond = condition.value as AlertCondition
    }
    setBusy(createBtn, true, 'Criando…')
    try {
      await api('/api/alerts', { method: 'POST', body: JSON.stringify({ ticker: t, type, condition: cond, value }) }, { retries: 0 })
      toast(`Alerta para ${shortTicker(t)} criado`, 'success')
      valueInput.value = ''
      updatePreview()
      await loadAlerts()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Erro ao criar alerta', 'error')
    } finally {
      setBusy(createBtn, false)
    }
  }

  // ---- Telegram ------------------------------------------------------------
  const telegramBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, icon('send', 18), 'Enviar mensagem de teste')
  const telegramStatus = h('div', { class: 'my-3.5' }, skeleton(16, 120))
  const telegramCard = h(
    'section',
    { class: 'card' },
    sectionTitle('Telegram'),
    h('p', { class: 'text-[0.9375rem] leading-normal text-fg-2' }, 'Quando um alerta dispara, o aviso chega em tempo real no chat configurado no servidor.'),
    telegramStatus,
    h('p', { class: 'card-note' }, 'Defina ', h('code', null, 'TELEGRAM_BOT_TOKEN'), ' e ', h('code', null, 'TELEGRAM_CHAT_ID'), ' no ', h('code', null, '.env'), ' do backend.'),
    telegramBtn
  )
  telegramBtn.addEventListener('click', async () => {
    setBusy(telegramBtn, true, 'Enviando…')
    try {
      const res = await api<{ success?: boolean; error?: string }>('/api/alerts/test-telegram', { method: 'POST' }, { retries: 0 })
      if (res.success) toast('Mensagem de teste enviada! Confira o Telegram.', 'success')
      else throw new Error(res.error ?? 'Falha ao enviar a mensagem de teste.')
    } catch (error) {
      toast(error instanceof Error ? `${error.message} Verifique as credenciais no .env.` : 'Falha ao enviar a mensagem de teste.', 'error', 6000)
    } finally {
      setBusy(telegramBtn, false)
    }
  })

  async function loadTelegramStatus(): Promise<void> {
    try {
      const status = await api<IntegrationStatus>('/api/integrations/status', {}, { timeoutMs: 10_000, retries: 0 })
      const ok = status.integrations.telegram.configured
      telegramStatus.replaceChildren(pill(ok ? 'pos' : 'warn', ok ? 'Telegram configurado' : 'Telegram não configurado', { icon: ok ? 'check' : 'alert' }))
    } catch {
      telegramStatus.replaceChildren(pill('neutral', 'Status indisponível'))
    }
  }

  // ---- Lista de alertas ----------------------------------------------------
  const listHost = h('div', { class: 'grid gap-2.5' }, skeleton(64), skeleton(64))
  const listCard = h('section', { class: 'card' }, sectionTitle('Alertas'), listHost)

  function alertRow(a: Alert): HTMLElement {
    const active = a.status === 'active'
    const tone = a.status === 'active' ? 'pos' : a.status === 'triggered' ? 'warn' : 'neutral'
    const statusText = a.status === 'active' ? 'Ativo' : a.status === 'triggered' ? 'Disparado' : 'Pausado'
    const toggle = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(active), 'aria-label': `${active ? 'Pausar' : 'Ativar'} alerta: ${describeRule(a)}`, title: active ? 'Pausar' : 'Ativar' }, h('span', { class: 'switch-knob' }))
    toggle.addEventListener('click', async () => {
      toggle.disabled = true
      try {
        await api(`/api/alerts/${encodeURIComponent(a.id)}/toggle`, { method: 'PUT', body: JSON.stringify({ enable: !active }) }, { retries: 0 })
        toast(`Alerta ${active ? 'pausado' : 'ativado'}`, 'success', 2500)
        await loadAlerts()
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Não foi possível alterar o alerta', 'error')
        toggle.disabled = false
      }
    })
    const remove = h('button', { type: 'button', class: 'icon-btn icon-btn-danger', title: 'Excluir alerta', 'aria-label': `Excluir alerta: ${describeRule(a)}` }, icon('trash', 18))
    remove.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Excluir alerta?', message: `O alerta “${describeRule(a)}” será removido e deixará de avisar.`, confirmLabel: 'Excluir', danger: true }))) return
      try {
        await api(`/api/alerts/${encodeURIComponent(a.id)}`, { method: 'DELETE' }, { retries: 0 })
        toast('Alerta removido', 'success', 2500)
        await loadAlerts()
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Não foi possível excluir o alerta', 'error')
      }
    })
    const lastChecked = a.lastCheckedValue !== null && a.lastCheckedValue !== undefined && a.lastCheckedValue !== '' ? (isNum(Number(a.lastCheckedValue)) && a.type !== 'ml_signal' ? fmtNum(Number(a.lastCheckedValue), 2) : String(a.lastCheckedValue)) : null
    return h(
      'article',
      { class: `grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-3.5 rounded-md border border-line bg-surface-2 px-4 py-3.5 max-phone:grid-cols-[auto_minmax(0,1fr)_auto_auto] max-phone:[&>.pill]:hidden${a.status === 'disabled' ? ' opacity-75' : ''}` },
      h('span', { class: 'inline-flex size-10 items-center justify-center rounded-md bg-brand-soft text-brand' }, icon(a.type === 'price' ? 'activity' : a.type === 'rsi' ? 'target' : 'sparkles', 20)),
      h(
        'div',
        { class: 'grid min-w-0 gap-0.5' },
        h('strong', { class: 'font-bold [overflow-wrap:anywhere]' }, describeRule(a)),
        h('span', { class: 'text-[0.8125rem] text-fg-3' }, TYPE_LABEL[a.type], ' · ', lastChecked ? `última leitura ${lastChecked}` : 'ainda não verificado', a.triggerCount > 0 ? ` · disparou ${a.triggerCount}×` : '', a.lastTriggeredAt ? ` (${relTime(a.lastTriggeredAt)})` : '')
      ),
      pill(tone, statusText),
      toggle,
      remove
    )
  }

  async function loadAlerts(): Promise<void> {
    try {
      const alerts = await api<Alert[]>('/api/alerts', {}, { timeoutMs: 15_000 })
      if (!Array.isArray(alerts) || alerts.length === 0) {
        listHost.replaceChildren(emptyState({ icon: 'bell', title: 'Nenhum alerta ainda', text: 'Crie o primeiro acima: por exemplo, avisar quando PETR4 ficar abaixo de um preço que você considera atrativo.' }))
        return
      }
      listHost.replaceChildren(...alerts.map(alertRow))
    } catch (error) {
      listHost.replaceChildren(errorState(error, () => void loadAlerts()))
    }
  }

  // ---- Histórico -----------------------------------------------------------
  const historyHost = h('div', { class: 'grid gap-2.5' }, skeleton(48), skeleton(48))
  const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-danger-text', hidden: true }, icon('trash', 16), 'Limpar histórico')
  const historyCard = h('section', { class: 'card' }, sectionTitle('Histórico de disparos', clearBtn), historyHost)
  clearBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Limpar histórico?', message: 'Todos os registros de disparos serão apagados. Os alertas continuam ativos.', confirmLabel: 'Limpar', danger: true }))) return
    try {
      await api('/api/alerts/clear-history', { method: 'POST' }, { retries: 0 })
      toast('Histórico limpo', 'success', 2500)
      await loadHistory()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não foi possível limpar o histórico', 'error')
    }
  })

  async function loadHistory(): Promise<void> {
    try {
      const history = await api<AlertHistory[]>('/api/alerts/history', {}, { timeoutMs: 15_000 })
      clearBtn.hidden = !Array.isArray(history) || history.length === 0
      if (!Array.isArray(history) || history.length === 0) {
        historyHost.replaceChildren(emptyState({ icon: 'clock', title: 'Nenhum disparo registrado', text: 'Quando um alerta disparar, o registro aparece aqui.' }))
        return
      }
      historyHost.replaceChildren(
        ...history.map(item =>
          h('article', { class: 'grid gap-1.5 rounded-md bg-surface-2 px-3.5 py-3' }, h('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2 text-[0.8125rem]' }, h('strong', null, shortTicker(item.ticker)), pill('neutral', TYPE_LABEL[item.type] ?? item.type), h('time', { class: 'ml-auto text-fg-2', datetime: item.triggeredAt }, fmtDateTime(item.triggeredAt))), h('p', { class: 'text-[0.9rem] leading-normal whitespace-pre-line [overflow-wrap:anywhere]' }, stripTags(item.message)))
        )
      )
    } catch (error) {
      historyHost.replaceChildren(errorState(error, () => void loadHistory()))
    }
  }

  el.append(
    viewHeader({ title: 'Alertas & Telegram', subtitle: 'Seja avisado quando o preço, o RSI ou o sinal da IA de um ativo chegar onde você definiu.' }),
    h('div', { class: GRID_MAIN_SIDE }, form, telegramCard),
    listCard,
    historyCard
  )
  syncFields()

  return {
    el,
    show(route: Route) {
      const prefill = route.query.get('ticker')
      if (prefill) {
        ticker.value = shortTicker(toTicker(prefill))
        updatePreview()
        queueMicrotask(() => (type === 'ml_signal' ? signalSelect : valueInput).focus())
      }
      void loadAlerts()
      void loadHistory()
      void loadTelegramStatus()
    },
  }
}
