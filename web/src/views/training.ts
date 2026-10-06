import { h } from '../research-dom'
import { hrefAnalyze, type Route, type View } from '../router'
import type { Action, TrainingDrill, TrainingResponse } from '../types'
import { api } from '../ui/api'
import { emptyState, errorState, loadingPanel, pill, setBusy, skeleton, viewHeader } from '../ui/components'
import { ACTION_LABEL, actionTone, relTime, shortTicker } from '../ui/format'
import { icon } from '../ui/icons'
import { toast } from '../ui/toast'

type Answer = Action | 'revealed'

export function createTrainingView(): View {
  const el = h('div', { class: 'view-stack' })
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('cap', 18), 'Novo treino')
  const out = h('div', { class: 'training-out' })
  el.append(
    viewHeader({ title: 'Treino de decisão', subtitle: 'Cenários reais do mercado de hoje. Decida primeiro, confira o raciocínio do modelo depois — a melhor forma de calibrar o seu critério.', actions: [newBtn] }),
    out
  )

  let data: TrainingResponse | null = null
  let answers: Record<string, Answer> = {}
  let index = 0
  let busy = false

  function intro(): void {
    out.replaceChildren(
      emptyState({
        icon: 'cap',
        title: 'Hora de treinar o olhar',
        text: 'Vamos montar cenários com as ações de maior e menor score do momento. Para cada um você escolhe comprar, manter ou vender e compara com a leitura do modelo.',
        action: h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => void load() }, icon('cap', 20), 'Começar treino'),
      })
    )
  }

  async function load(): Promise<void> {
    if (busy) return
    busy = true
    setBusy(newBtn, true, 'Montando…')
    out.replaceChildren(loadingPanel('Montando o treino do mercado…', skeleton(24, 180), skeleton(160)))
    try {
      data = await api<TrainingResponse>('/api/training', {}, { timeoutMs: 150_000 })
      answers = {}
      index = 0
      if (data.drills.length === 0) {
        out.replaceChildren(emptyState({ icon: 'cap', title: 'Nenhum cenário gerado', text: 'O mercado não devolveu dados suficientes agora. Tente novamente em instantes.' }))
      } else {
        render()
        toast(`Treino pronto: ${data.drills.length} cenários`, 'success')
      }
    } catch (error) {
      out.replaceChildren(errorState(error, () => void load()))
    } finally {
      busy = false
      setBusy(newBtn, false)
      newBtn.replaceChildren(icon('refresh', 18), data ? 'Novo treino' : 'Começar treino')
    }
  }

  const agreed = (drill: TrainingDrill): boolean => answers[drill.id] === drill.expectedDecision

  function progress(drills: TrainingDrill[]): HTMLElement {
    const done = drills.filter(d => answers[d.id] !== undefined).length
    const hits = drills.filter(d => answers[d.id] !== undefined && answers[d.id] !== 'revealed' && agreed(d)).length
    const decided = drills.filter(d => answers[d.id] !== undefined && answers[d.id] !== 'revealed').length
    return h(
      'div',
      { class: 'train-progress' },
      h(
        'ol',
        { class: 'dots', 'aria-label': 'Cenários' },
        ...drills.map((d, i) => {
          const a = answers[d.id]
          const state = i === index ? 'current' : a === undefined ? 'todo' : a === 'revealed' ? 'seen' : agreed(d) ? 'hit' : 'miss'
          const label = `Cenário ${i + 1}: ${shortTicker(d.ticker)}${a === undefined ? '' : a === 'revealed' ? ' (resposta vista)' : agreed(d) ? ' (concordou com o modelo)' : ' (divergiu do modelo)'}`
          return h('li', null, h('button', { type: 'button', class: `dot dot-${state}`, 'aria-label': label, 'aria-current': i === index ? 'step' : null, onClick: () => { index = i; render() } }, String(i + 1)))
        })
      ),
      h('p', { class: 'train-score' }, `${done} de ${drills.length} vistos`, decided > 0 ? h('span', null, ` · concordou com o modelo em ${hits} de ${decided}`) : null)
    )
  }

  function choose(drill: TrainingDrill, value: Answer): void {
    answers[drill.id] = value
    render(true)
  }

  function render(focusResult = false): void {
    if (!data) return
    const drills = data.drills
    const drill = drills[index] as TrainingDrill
    const answer = answers[drill.id]

    const decisions = (['buy', 'hold', 'sell'] as const).map(a => {
      const chosen = answer === a
      const expected = answer !== undefined && drill.expectedDecision === a
      return h(
        'button',
        { type: 'button', class: `choice choice-${actionTone(a)}${chosen ? ' is-chosen' : ''}${expected ? ' is-expected' : ''}`, disabled: answer !== undefined, 'aria-pressed': chosen ? 'true' : 'false', onClick: () => choose(drill, a) },
        icon(a === 'buy' ? 'up' : a === 'sell' ? 'down' : 'activity', 22),
        h('strong', null, ACTION_LABEL[a]),
        expected ? h('span', { class: 'choice-flag' }, 'modelo') : null
      )
    })

    let feedback: HTMLElement | null = null
    if (answer !== undefined) {
      const ok = answer !== 'revealed' && agreed(drill)
      const tone = answer === 'revealed' ? 'info' : ok ? 'pos' : 'warn'
      const title = answer === 'revealed' ? `Leitura do modelo: ${ACTION_LABEL[drill.expectedDecision]}` : ok ? `Você concordou com o modelo: ${ACTION_LABEL[drill.expectedDecision]}` : `O modelo leu diferente: ${ACTION_LABEL[drill.expectedDecision]}`
      feedback = h(
        'div',
        { class: `feedback feedback-${tone}`, role: 'status', tabindex: -1, id: 'train-feedback' },
        h('div', { class: 'feedback-head' }, icon(ok ? 'check' : answer === 'revealed' ? 'info' : 'alert', 20), h('strong', null, title)),
        h('p', null, drill.answer),
        h('p', { class: 'card-note' }, 'O gabarito é a leitura do modelo quantitativo — não uma verdade de mercado. Discordar pode ser legítimo; o valor está em entender o porquê.'),
        h('div', { class: 'feedback-actions' }, h('a', { class: 'btn btn-secondary', href: hrefAnalyze(drill.ticker) }, icon('search', 18), `Analisar ${shortTicker(drill.ticker)}`), index < drills.length - 1 ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => { index++; render() } }, 'Próximo cenário', icon('arrow', 18)) : h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void load() }, icon('refresh', 18), 'Novo treino'))
      )
    }

    out.replaceChildren(
      progress(drills),
      h(
        'section',
        { class: 'card drill' },
        h('div', { class: 'drill-top' }, pill('neutral', `Cenário ${index + 1} de ${drills.length}`), pill('info', shortTicker(drill.ticker))),
        h('h2', { class: 'drill-prompt' }, drill.prompt),
        h('ul', { class: 'check-list drill-context' }, ...drill.context.map(c => h('li', null, icon('activity', 16), h('span', null, c)))),
        h('div', { class: 'choices', role: 'group', 'aria-label': 'Sua decisão' }, ...decisions),
        answer === undefined ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => choose(drill, 'revealed') }, icon('info', 16), 'Ver a resposta sem escolher') : null,
        feedback
      ),
      h('p', { class: 'muted small' }, `Treino gerado ${relTime(data.generatedAt)} com ${data.source.tickersAnalyzed} ações · IA: ${data.source.aiSource}`)
    )
    if (focusResult) document.getElementById('train-feedback')?.focus({ preventScroll: false })
  }

  newBtn.addEventListener('click', () => void load())

  return {
    el,
    show(_route: Route) {
      if (!data && !busy) intro()
    },
  }
}
