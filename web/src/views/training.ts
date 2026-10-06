import { h } from '../research-dom'
import { hrefAnalyze, type Route, type View } from '../router'
import type { Action, TrainingDrill, TrainingResponse } from '../types'
import { api } from '../ui/api'
import { OUT, STACK, emptyState, errorState, loadingPanel, pill, setBusy, skeleton, viewHeader } from '../ui/components'
import { ACTION_LABEL, type Tone, actionTone, relTime, shortTicker } from '../ui/format'
import { icon } from '../ui/icons'
import { toast } from '../ui/toast'

// classes completas (o Tailwind só gera o que aparece literalmente no código)
const DOT_BASE = 'size-9 rounded-full border border-line-strong bg-surface-2 text-[0.8125rem] font-bold text-fg-2 transition hover:scale-[1.08]'
const DOT_STATE: Record<string, string> = {
  todo: '',
  current: 'border-2 border-brand bg-brand-soft text-brand',
  hit: 'border-pos bg-pos-soft text-pos',
  miss: 'border-warn bg-warn-soft text-warn',
  seen: 'border-info bg-info-soft text-info',
}
const CHOICE_BASE =
  'relative grid justify-items-center gap-1.5 rounded-lg border-2 border-line-strong bg-surface-2 px-2.5 py-[18px] text-fg transition duration-150 enabled:hover:-translate-y-0.5 enabled:hover:border-brand-line disabled:opacity-55 max-xs:grid-flow-col max-xs:justify-center max-xs:p-3.5 [&_strong]:text-[1.0625rem]'
const CHOICE_ICON: Record<Tone, string> = { pos: '[&_.icon]:text-pos', neg: '[&_.icon]:text-neg', warn: '[&_.icon]:text-warn', info: '[&_.icon]:text-info', neutral: '' }
const FEEDBACK: Record<'pos' | 'warn' | 'info', string> = { pos: 'border-l-pos-solid bg-pos-soft', warn: 'border-l-warn-solid bg-warn-soft', info: 'border-l-info bg-info-soft' }

type Answer = Action | 'revealed'

export function createTrainingView(): View {
  const el = h('div', { class: STACK })
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('cap', 18), 'Novo treino')
  const out = h('div', { class: OUT })
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
      { class: 'flex flex-wrap items-center justify-between gap-3' },
      h(
        'ol',
        { class: 'flex flex-wrap gap-2', 'aria-label': 'Cenários' },
        ...drills.map((d, i) => {
          const a = answers[d.id]
          const state = i === index ? 'current' : a === undefined ? 'todo' : a === 'revealed' ? 'seen' : agreed(d) ? 'hit' : 'miss'
          const label = `Cenário ${i + 1}: ${shortTicker(d.ticker)}${a === undefined ? '' : a === 'revealed' ? ' (resposta vista)' : agreed(d) ? ' (concordou com o modelo)' : ' (divergiu do modelo)'}`
          return h('li', null, h('button', { type: 'button', class: `${DOT_BASE} ${DOT_STATE[state]}`, 'aria-label': label, 'aria-current': i === index ? 'step' : null, onClick: () => { index = i; render() } }, String(i + 1)))
        })
      ),
      h('p', { class: 'text-sm text-fg-2' }, `${done} de ${drills.length} vistos`, decided > 0 ? h('span', null, ` · concordou com o modelo em ${hits} de ${decided}`) : null)
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
        { type: 'button', class: `${CHOICE_BASE} ${CHOICE_ICON[actionTone(a)]}${chosen ? ' border-brand bg-brand-soft disabled:opacity-100' : ''}${expected ? ' border-dashed border-info disabled:opacity-100' : ''}`, disabled: answer !== undefined, 'aria-pressed': chosen ? 'true' : 'false', onClick: () => choose(drill, a) },
        icon(a === 'buy' ? 'up' : a === 'sell' ? 'down' : 'activity', 22),
        h('strong', null, ACTION_LABEL[a]),
        expected ? h('span', { class: 'absolute -top-2.5 rounded-full border border-info bg-surface px-[9px] py-px text-[0.6875rem] font-bold text-info' }, 'modelo') : null
      )
    })

    let feedback: HTMLElement | null = null
    if (answer !== undefined) {
      const ok = answer !== 'revealed' && agreed(drill)
      const tone = answer === 'revealed' ? 'info' : ok ? 'pos' : 'warn'
      const title = answer === 'revealed' ? `Leitura do modelo: ${ACTION_LABEL[drill.expectedDecision]}` : ok ? `Você concordou com o modelo: ${ACTION_LABEL[drill.expectedDecision]}` : `O modelo leu diferente: ${ACTION_LABEL[drill.expectedDecision]}`
      feedback = h(
        'div',
        { class: `grid gap-2.5 rounded-md border border-l-4 border-line px-[18px] py-4 outline-none ${FEEDBACK[tone]}`, role: 'status', tabindex: -1, id: 'train-feedback' },
        h('div', { class: 'flex items-center gap-2.5' }, icon(ok ? 'check' : answer === 'revealed' ? 'info' : 'alert', 20), h('strong', null, title)),
        h('p', null, drill.answer),
        h('p', { class: 'card-note' }, 'O gabarito é a leitura do modelo quantitativo — não uma verdade de mercado. Discordar pode ser legítimo; o valor está em entender o porquê.'),
        h('div', { class: 'mt-1 flex flex-wrap gap-2.5' }, h('a', { class: 'btn btn-secondary', href: hrefAnalyze(drill.ticker) }, icon('search', 18), `Analisar ${shortTicker(drill.ticker)}`), index < drills.length - 1 ? h('button', { type: 'button', class: 'btn btn-primary', onClick: () => { index++; render() } }, 'Próximo cenário', icon('arrow', 18)) : h('button', { type: 'button', class: 'btn btn-primary', onClick: () => void load() }, icon('refresh', 18), 'Novo treino'))
      )
    }

    out.replaceChildren(
      progress(drills),
      h(
        'section',
        { class: 'card grid gap-[18px] p-[clamp(18px,3vw,28px)]' },
        h('div', { class: 'flex flex-wrap gap-2' }, pill('neutral', `Cenário ${index + 1} de ${drills.length}`), pill('info', shortTicker(drill.ticker))),
        h('h2', { class: 'max-w-[40ch] text-[clamp(1.25rem,1rem+1vw,1.625rem)] leading-tight font-bold' }, drill.prompt),
        h('ul', { class: 'check-list' }, ...drill.context.map(c => h('li', { class: 'rounded-md bg-surface-2 px-3.5 py-2.5' }, icon('activity', 16), h('span', null, c)))),
        h('div', { class: 'grid grid-cols-3 gap-3 max-xs:grid-cols-1', role: 'group', 'aria-label': 'Sua decisão' }, ...decisions),
        answer === undefined ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => choose(drill, 'revealed') }, icon('info', 16), 'Ver a resposta sem escolher') : null,
        feedback
      ),
      h('p', { class: 'text-[0.8125rem] text-fg-2' }, `Treino gerado ${relTime(data.generatedAt)} com ${data.source.tickersAnalyzed} ações · IA: ${data.source.aiSource}`)
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
