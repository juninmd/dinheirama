// Utilitários de DOM e formatação da seção "Pesquisa".
// Regra: dados vindos da API entram SEMPRE como nós de texto (textContent); nunca innerHTML.

import { describeError } from './research-api'

export type Child = Node | string | number | null | undefined | false
type AttrValue = string | number | boolean | null | undefined | ((event: Event) => void)
export type Attrs = Record<string, AttrValue>

const SVG_NS = 'http://www.w3.org/2000/svg'

function applyAttrs(node: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (key.startsWith('on')) {
      // handlers só como função (nunca atributo inline em string)
      if (typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
      continue
    }
    if (typeof value === 'function') continue
    node.setAttribute(key, value === true ? '' : String(value))
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  applyAttrs(node, attrs)
  append(node, children)
  return node
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  applyAttrs(node, attrs)
  append(node, children)
  return node
}

// ---- Formatação (pt-BR) ----------------------------------------------------

export const NA = '—'
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const formats = new Map<number, Intl.NumberFormat>()
function nf(decimals: number): Intl.NumberFormat {
  let f = formats.get(decimals)
  if (!f) {
    f = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    formats.set(decimals, f)
  }
  return f
}

export function fmtNum(v: unknown, decimals = 2): string {
  return isNum(v) ? nf(decimals).format(v) : NA
}

export function fmtSigned(v: unknown, decimals = 2): string {
  if (!isNum(v)) return NA
  const text = nf(decimals).format(v)
  return v > 0 ? `+${text}` : text
}

/** Fração -> porcentagem (0,123 -> "12,3%"). */
export function fmtPct(v: unknown, decimals = 1): string {
  return isNum(v) ? `${nf(decimals).format(v * 100)}%` : NA
}

export function fmtSignedPct(v: unknown, decimals = 1): string {
  return isNum(v) ? `${fmtSigned(v * 100, decimals)}%` : NA
}

/** Valor já em pontos percentuais (12,3 -> "+12,3%"). */
export function fmtSignedPoints(v: unknown, decimals = 1): string {
  return isNum(v) ? `${fmtSigned(v, decimals)}%` : NA
}

export function fmtBrl(v: unknown, decimals = 2): string {
  return isNum(v) ? `R$ ${nf(decimals).format(v)}` : NA
}

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
export function fmtBrlCompact(v: unknown): string {
  return isNum(v) ? `R$ ${compact.format(v)}` : NA
}

export function fmtMult(v: unknown, decimals = 2): string {
  return isNum(v) ? `${nf(decimals).format(v)}×` : NA
}

/** yyyy-mm-dd (ou ISO) -> dd/mm/aaaa, sem depender de fuso horário. */
export function fmtDate(value: unknown): string {
  if (typeof value !== 'string') return NA
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : NA
}

export function fmtDateTime(value: unknown): string {
  if (typeof value !== 'string') return NA
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? NA : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

/** Classe de texto por sinal (o sinal +/- também aparece no texto: cor nunca é o único canal). */
export function signClass(v: unknown): string {
  if (!isNum(v) || v === 0) return ''
  return v > 0 ? 'q-pos' : 'q-neg'
}

// ---- Componentes -----------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

const NOTICE_ICON: Record<Exclude<Tone, 'neutral'>, string> = { ok: '✓', warn: '⚠', bad: '✗', info: 'ℹ' }

/** Aviso com título e corpo (texto ou lista de textos). */
export function notice(tone: Exclude<Tone, 'neutral'>, title: string, body?: string | string[] | null, extra?: Child): HTMLElement {
  const lines = Array.isArray(body) ? body : body ? [body] : []
  return h(
    'div',
    { class: `quant-notice quant-notice-${tone}`, role: tone === 'bad' ? 'alert' : 'note' },
    h('p', { class: 'quant-notice-title' }, h('span', { 'aria-hidden': 'true' }, `${NOTICE_ICON[tone]} `), title),
    lines.length === 1
      ? h('p', null, lines[0])
      : lines.length > 1
        ? h('ul', null, ...lines.map(line => h('li', null, line)))
        : null,
    extra
  )
}

export function errorNotice(error: unknown): HTMLElement {
  const view = describeError(error)
  return h(
    'div',
    { class: 'quant-notice quant-notice-bad', role: 'alert' },
    h('p', { class: 'quant-notice-title' }, h('span', { 'aria-hidden': 'true' }, '✗ '), view.title),
    h('p', null, view.message),
    view.details.length > 0 ? h('ul', null, ...view.details.map(d => h('li', null, d))) : null,
    view.hint ? h('p', { class: 'quant-hint' }, view.hint) : null
  )
}

export function badge(tone: Tone, text: string, title?: string): HTMLElement {
  return h('span', { class: `quant-badge quant-badge-${tone}`, title }, text)
}

export function statCard(label: string, value: Child, hint?: string | null, valueClass = ''): HTMLElement {
  return h(
    'div',
    { class: 'quant-stat' },
    h('span', { class: 'quant-stat-label' }, label),
    h('span', { class: `quant-stat-value ${valueClass}`.trim() }, value),
    hint ? h('span', { class: 'quant-stat-hint' }, hint) : null
  )
}

export function statGrid(...cards: Array<HTMLElement | null>): HTMLElement {
  return h('div', { class: 'quant-stats' }, ...cards)
}

export function bulletList(items: string[], className = 'quant-list'): HTMLElement {
  return h('ul', { class: className }, ...items.map(item => h('li', null, item)))
}

/** Campo de formulário com label associado (for/id) e dica opcional (aria-describedby). */
export function field(id: string, label: string, control: HTMLElement, hint?: string): HTMLElement {
  control.id = id
  if (hint) control.setAttribute('aria-describedby', `${id}-hint`)
  return h(
    'div',
    { class: 'form-group' },
    h('label', { for: id }, label),
    control,
    hint ? h('small', { class: 'quant-hint', id: `${id}-hint` }, hint) : null
  )
}

export function button(label: string, onClick: (event: Event) => void, kind: 'primary' | 'secondary' = 'primary', type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  return h('button', { type, class: kind === 'primary' ? 'primary-btn quant-btn' : 'quant-btn-secondary', onClick }, label)
}

/** Tabela dentro de contêiner com rolagem horizontal (mobile). */
export function tableWrap(table: HTMLTableElement): HTMLElement {
  return h('div', { class: 'quant-table-wrap', tabindex: 0, role: 'region', 'aria-label': table.querySelector('caption')?.textContent ?? 'Tabela' }, table)
}

export function th(text: string, opts: { scope?: 'col' | 'row'; title?: string; left?: boolean; colspan?: number; rowspan?: number; className?: string } = {}): HTMLTableCellElement {
  return h('th', {
    scope: opts.scope ?? 'col',
    title: opts.title,
    colspan: opts.colspan,
    rowspan: opts.rowspan,
    class: [opts.left ? 't-left' : '', opts.className ?? ''].join(' ').trim() || null,
  }, text)
}

export function td(content: Child, className = ''): HTMLTableCellElement {
  return h('td', { class: className || null }, content)
}

/** Barra horizontal (fração 0..1 do máximo). `alt` usa a segunda cor categórica. */
export function bar(fraction: number, alt = false): HTMLElement {
  const fill = h('span', null)
  fill.style.width = `${Math.max(0, Math.min(1, isNum(fraction) ? fraction : 0)) * 100}%`
  return h('div', { class: alt ? 'quant-bar quant-bar-alt' : 'quant-bar', 'aria-hidden': 'true' }, fill)
}

export function loadingEl(message: string): HTMLElement {
  return h('div', { class: 'quant-loading', role: 'status' }, h('span', { class: 'quant-spinner', 'aria-hidden': 'true' }), h('span', null, message))
}

/**
 * Carrega dados para dentro de `host`: mostra progresso, trata erro (inclusive 503) sem quebrar a tela
 * e ignora respostas atrasadas (se outra carga começou depois no mesmo host).
 */
export async function loadInto<T>(
  host: HTMLElement,
  message: string,
  task: () => Promise<T>,
  render: (data: T, host: HTMLElement) => void,
  controls: HTMLButtonElement[] = []
): Promise<void> {
  const token = String(Number(host.dataset.loadToken ?? '0') + 1)
  host.dataset.loadToken = token
  host.setAttribute('aria-busy', 'true')
  for (const c of controls) c.disabled = true
  host.replaceChildren(loadingEl(message))
  try {
    const data = await task()
    if (host.dataset.loadToken !== token) return
    host.replaceChildren()
    render(data, host)
  } catch (error) {
    if (host.dataset.loadToken !== token) return
    host.replaceChildren(errorNotice(error))
  } finally {
    if (host.dataset.loadToken === token) {
      host.removeAttribute('aria-busy')
      for (const c of controls) c.disabled = false
    }
  }
}
