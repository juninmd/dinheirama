// Componentes de interface reutilizáveis. Dados da API entram sempre como nós de texto (nunca innerHTML).

import { describeError } from '../research-api'
import { type Child, h, s } from '../research-dom'
import type { Tone } from './format'
import { TEXT_TONE, UNIVERSE } from './format'
import { type IconName, icon } from './icons'

// ---- Classes de layout compartilhadas pelas telas ----
export const STACK = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5'
export const OUT = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4'
export const GRID_3 = 'grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4'
export const GRID_TILES = 'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3'
export const GRID_TILES_3 = 'grid grid-cols-3 gap-3 max-sm:grid-cols-2'
export const GRID_MAIN_SIDE = 'grid grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)] items-start gap-4 max-md:grid-cols-[minmax(0,1fr)]'
export const GRID_2 = 'grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4 max-md:grid-cols-[minmax(0,1fr)]'
export const PARAM_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-x-[18px] gap-y-3.5'
export const TOOLBAR = 'flex flex-wrap items-center justify-between gap-3'
export const SEARCH_BAR = 'flex flex-wrap gap-2.5 max-xs:[&_.btn]:flex-[1_1_100%]'
export const INPUT_GROW = 'w-auto min-w-0 flex-[1_1_220px]'
export const CHIPS = 'mt-3.5 grid gap-2 empty:hidden'
export const LINK_ARROW = 'mt-2.5 inline-flex items-center gap-1.5 text-sm font-semibold no-underline hover:underline'
export const DISCLAIMER_INLINE = 'mt-4 flex items-start gap-2 border-t border-dashed border-line-strong pt-3.5 text-[0.8125rem] leading-[1.45] text-fg-3 [&_.icon]:mt-0.5 [&_.icon]:text-warn'
export const BIG_METRIC = 'flex flex-wrap items-baseline gap-2.5'
export const SECTION_PAD = 'p-4'

export function pill(tone: Tone, content: Child, opts: { icon?: IconName; title?: string } = {}): HTMLElement {
  return h('span', { class: `pill pill-${tone}`, title: opts.title }, opts.icon ? icon(opts.icon, 14) : null, content)
}

export const EYEBROW = 'mb-1.5 text-xs font-bold tracking-[0.1em] text-brand uppercase'
export const VIEW_TITLE = 'text-[clamp(1.5rem,1.15rem+1.2vw,2.125rem)] font-extrabold tracking-[-0.03em] outline-none'

export function viewHeader(opts: { title: string; subtitle?: string; eyebrow?: string; actions?: Child[] }): HTMLElement {
  return h(
    'header',
    { class: 'flex flex-wrap items-end justify-between gap-4' },
    h(
      'div',
      { class: 'min-w-0' },
      opts.eyebrow ? h('p', { class: EYEBROW }, opts.eyebrow) : null,
      h('h1', { class: VIEW_TITLE, tabindex: -1 }, opts.title),
      opts.subtitle ? h('p', { class: 'mt-1.5 max-w-[68ch] text-fg-2' }, opts.subtitle) : null
    ),
    opts.actions && opts.actions.length > 0 ? h('div', { class: 'flex flex-wrap gap-2.5' }, ...opts.actions) : null
  )
}

export function sectionTitle(text: string, aside?: Child): HTMLElement {
  return h('div', { class: 'mb-3.5 flex items-center justify-between gap-3' }, h('h2', { class: 'text-[1.0625rem] font-bold' }, text), aside ?? null)
}

export function emptyState(opts: { icon: IconName; title: string; text?: string; action?: Child }): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon' }, icon(opts.icon, 26)),
    h('p', { class: 'empty-title' }, opts.title),
    opts.text ? h('p', { class: 'empty-text' }, opts.text) : null,
    opts.action ?? null
  )
}

export function errorState(error: unknown, retry?: () => void): HTMLElement {
  const view = describeError(error)
  return h(
    'div',
    { class: 'error-state', role: 'alert' },
    h('span', { class: 'empty-icon empty-icon-bad' }, icon('alert', 26)),
    h('p', { class: 'empty-title' }, view.title),
    h('p', { class: 'empty-text' }, view.message),
    view.details.length > 0 ? h('ul', { class: 'grid list-disc gap-1 pl-5 text-left text-sm text-fg-2' }, ...view.details.map(d => h('li', null, d))) : null,
    view.hint ? h('p', { class: 'empty-text' }, view.hint) : null,
    retry ? h('button', { type: 'button', class: 'btn btn-secondary', onClick: retry }, icon('refresh', 16), 'Tentar novamente') : null
  )
}

export function skeleton(height: number | string = 16, width: number | string = '100%'): HTMLElement {
  const el = h('span', { class: 'skeleton', 'aria-hidden': 'true' })
  el.style.height = typeof height === 'number' ? `${height}px` : height
  el.style.width = typeof width === 'number' ? `${width}px` : width
  return el
}

export function loadingPanel(message: string, ...blocks: HTMLElement[]): HTMLElement {
  return h(
    'div',
    { class: 'grid gap-4', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'flex items-center gap-3 text-fg-2' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, message)),
    ...blocks
  )
}

/** Alterna estado "ocupado" de um botão, preservando o conteúdo original. */
export function setBusy(button: HTMLButtonElement, busy: boolean, label?: string): void {
  if (busy) {
    if (!button.dataset.idle) button.dataset.idle = button.innerHTML
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    button.replaceChildren(h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), label ?? 'Processando…')
  } else {
    button.disabled = false
    button.removeAttribute('aria-busy')
    if (button.dataset.idle) {
      button.innerHTML = button.dataset.idle
      delete button.dataset.idle
    }
  }
}

// ---- Controle segmentado (radiogroup acessível) ----------------------------

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  count?: number
}

export function segmented<T extends string>(opts: {
  label: string
  options: Array<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  compact?: boolean
}): { el: HTMLElement; set(value: T): void; setCount(value: T, count: number): void } {
  let current = opts.value
  const group = h('div', { class: `segmented${opts.compact ? ' segmented-compact' : ''}`, role: 'radiogroup', 'aria-label': opts.label })
  const buttons = new Map<T, HTMLButtonElement>()
  const counts = new Map<T, HTMLElement>()

  const paint = (): void => {
    for (const [value, button] of buttons) {
      const active = value === current
      button.setAttribute('aria-checked', String(active))
      button.tabIndex = active ? 0 : -1
    }
  }
  const select = (value: T, focus = false): void => {
    current = value
    paint()
    if (focus) buttons.get(value)?.focus()
    opts.onChange(value)
  }

  for (const option of opts.options) {
    const count = option.count !== undefined ? h('span', { class: 'segmented-count' }, String(option.count)) : null
    if (count) counts.set(option.value, count)
    const button = h('button', { type: 'button', role: 'radio', class: 'segmented-btn' }, option.label, count)
    button.addEventListener('click', () => select(option.value))
    button.addEventListener('keydown', event => {
      const keys = opts.options.map(o => o.value)
      const index = keys.indexOf(current)
      let next = -1
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % keys.length
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + keys.length) % keys.length
      if (next >= 0) {
        event.preventDefault()
        select(keys[next] as T, true)
      }
    })
    buttons.set(option.value, button)
    group.appendChild(button)
  }
  paint()

  return {
    el: group,
    set(value) {
      current = value
      paint()
    },
    setCount(value, count) {
      const el = counts.get(value)
      if (el) el.textContent = String(count)
    },
  }
}

// ---- Texto rico seguro (**negrito**, quebras de linha e listas "- item") ----

export function richText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const inline = (parent: HTMLElement, line: string): void => {
    for (const part of line.split(/(\*\*[^*]+\*\*)/g)) {
      if (/^\*\*[^*]+\*\*$/.test(part)) parent.appendChild(h('strong', null, part.slice(2, -2)))
      else if (part) parent.appendChild(document.createTextNode(part))
    }
  }
  for (const block of text.trim().split(/\n{2,}/)) {
    const lines = block.split('\n').map(l => l.trimEnd())
    if (lines.every(l => /^\s*[-*•]\s+/.test(l))) {
      const ul = h('ul', { class: 'rich-list' })
      for (const line of lines) {
        const li = h('li')
        inline(li, line.replace(/^\s*[-*•]\s+/, ''))
        ul.appendChild(li)
      }
      frag.appendChild(ul)
      continue
    }
    const p = h('p')
    lines.forEach((line, index) => {
      if (index > 0) p.appendChild(h('br'))
      inline(p, line)
    })
    frag.appendChild(p)
  }
  return frag
}

// ---- Indicadores -----------------------------------------------------------

/** Anel de score 0–100. A cor vem da classe de tom (e o número fica no centro: não depende só de cor). */
export function scoreRing(score: number, tone: Tone, size = 132): HTMLElement {
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, score))
  const arc = s('circle', {
    class: 'score-arc',
    cx: 60,
    cy: 60,
    r: radius,
    'stroke-dasharray': circumference,
    'stroke-dashoffset': circumference,
    transform: 'rotate(-90 60 60)',
  })
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(circumference * (1 - clamped / 100)))))
  const svg = s(
    'svg',
    { viewBox: '0 0 120 120', width: size, height: size, role: 'img', 'aria-label': `Score ${Math.round(clamped)} de 100` },
    s('circle', { class: 'score-track', cx: 60, cy: 60, r: radius }),
    arc
  )
  return h('div', { class: `score-ring score-ring-${tone}` }, svg, h('div', { class: 'score-center' }, h('strong', null, String(Math.round(clamped))), h('span', null, 'de 100')))
}

/** Faixa 0–100 com zonas (sobrevendido < 30 < neutro < 70 < sobrecomprado) e marcador na posição do RSI. */
export function rsiMeter(rsi: number | null): HTMLElement {
  const track = h('div', { class: 'meter-track', role: 'img', 'aria-label': rsi === null ? 'RSI indisponível' : `RSI ${rsi.toFixed(1)} em 100` }, h('span', { class: 'meter-zone meter-zone-low' }), h('span', { class: 'meter-zone meter-zone-mid' }), h('span', { class: 'meter-zone meter-zone-high' }))
  if (rsi !== null) {
    const marker = h('span', { class: 'meter-marker' })
    marker.style.left = `${Math.max(0, Math.min(100, rsi))}%`
    track.appendChild(marker)
  }
  return h('div', { class: 'meter' }, track, h('div', { class: 'meter-scale' }, h('span', null, '0'), h('span', null, '30'), h('span', null, '70'), h('span', null, '100')))
}

export function statTile(label: string, value: Child, hint?: string | null, opts: { tone?: Tone; title?: string } = {}): HTMLElement {
  return h(
    'div',
    { class: 'tile', title: opts.title },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: `tile-value${opts.tone && opts.tone !== 'neutral' ? ` ${TEXT_TONE[opts.tone]}` : ''}` }, value),
    hint ? h('span', { class: 'tile-hint' }, hint) : null
  )
}

// ---- Campo de ticker com sugestões nativas (<datalist>) ---------------------

let datalistReady = false
export const TICKER_LIST_ID = 'ticker-options'

export function ensureTickerList(): void {
  if (datalistReady) return
  datalistReady = true
  document.body.appendChild(h('datalist', { id: TICKER_LIST_ID }, ...UNIVERSE.map(u => h('option', { value: u.ticker.replace(/\.SA$/, '') }, u.name))))
}

/** `grow` = campo de uma barra de busca em linha (ocupa o espaço livre ao lado do botão). */
export function tickerInput(opts: { id: string; label: string; placeholder?: string; value?: string; grow?: boolean }): HTMLInputElement {
  ensureTickerList()
  return h('input', {
    type: 'text',
    id: opts.id,
    class: opts.grow ? `input ${INPUT_GROW}` : 'input',
    list: TICKER_LIST_ID,
    placeholder: opts.placeholder ?? 'Ex.: PETR4',
    value: opts.value ?? '',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    inputmode: 'text',
    'aria-label': opts.label,
  })
}

/** Linha de atalhos de tickers clicáveis. */
export function chipRow(label: string, tickers: readonly string[], onPick: (ticker: string) => void): HTMLElement | null {
  if (tickers.length === 0) return null
  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2' },
    h('span', { class: 'text-xs font-semibold text-fg-3' }, label),
    ...tickers.map(t => h('button', { type: 'button', class: 'chip', onClick: () => onPick(t) }, t.replace(/\.SA$/, '')))
  )
}

export function linkOut(href: string, content: Child, className = ''): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: className || null }, content, h('span', { class: 'sr-only' }, ' (abre em nova aba)'))
}

export function kbd(text: string): HTMLElement {
  return h('kbd', { class: 'kbd' }, text)
}
