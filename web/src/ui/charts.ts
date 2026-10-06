// Gráficos SVG/HTML leves, sem dependências: preço (área com cursor), sparkline, faixa de percentis e fronteira.

import { h, s } from '../research-dom'
import { TEXT_TONE, fmtBrl, fmtDate, fmtNum, fmtSignedPoints } from './format'

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / magnitude
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min]
  const step = niceStep(max - min, count)
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

/** dd/mm/aa a partir de uma data ISO. */
function shortDate(value: string): string {
  const full = fmtDate(value)
  return full === '—' ? full : `${full.slice(0, 6)}${full.slice(8)}`
}

export interface PricePoint {
  date: string
  close: number
}

/** Gráfico de preço em área com cursor, tooltip e foco por teclado (setas). Verde/vermelho conforme o período. */
export function priceChart(points: PricePoint[]): HTMLElement {
  const compact = window.innerWidth < 640
  const W = compact ? 360 : 720
  const H = compact ? 240 : 260
  const pad = { l: 8, r: 52, t: 14, b: 26 }
  const wrap = h('div', { class: 'relative min-w-0', role: 'group', 'aria-label': 'Gráfico de preço de fechamento' })
  if (points.length < 2) return h('p', { class: 'text-fg-2' }, 'Histórico insuficiente para o gráfico.')

  const closes = points.map(p => p.close)
  const lo = Math.min(...closes)
  const hi = Math.max(...closes)
  const span = hi - lo || 1
  const yMin = lo - span * 0.08
  const yMax = hi + span * 0.08
  const x = (i: number): number => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r)
  const y = (v: number): number => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b)
  const tone = (closes[closes.length - 1] as number) >= (closes[0] as number) ? 'pos' : 'neg'

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.close).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${H - pad.b} L${x(0).toFixed(1)} ${H - pad.b} Z`

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: `chart-svg chart-${tone}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' })
  const gradientId = `grad-${Math.random().toString(36).slice(2, 8)}`
  svg.appendChild(
    s('defs', null, s('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: '0%', class: 'grad-top' }), s('stop', { offset: '100%', class: 'grad-bottom' })))
  )
  for (const tick of niceTicks(yMin, yMax, 4)) {
    svg.append(s('line', { class: 'chart-grid', x1: pad.l, x2: W - pad.r, y1: y(tick), y2: y(tick) }), s('text', { class: 'chart-axis', x: W - pad.r + 8, y: y(tick) + 4 }, fmtNum(tick, tick >= 100 ? 0 : 2)))
  }
  const labelCount = Math.min(4, points.length)
  for (let k = 0; k < labelCount; k++) {
    const i = Math.round((k / Math.max(1, labelCount - 1)) * (points.length - 1))
    const anchor = k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle'
    svg.appendChild(s('text', { class: 'chart-axis', x: x(i), y: H - 6, 'text-anchor': anchor }, shortDate((points[i] as PricePoint).date)))
  }
  svg.append(s('path', { class: 'chart-area', d: area, fill: `url(#${gradientId})` }), s('path', { class: 'chart-line', d: line }))

  const cursor = s('line', { class: 'chart-cursor', y1: pad.t, y2: H - pad.b, visibility: 'hidden' })
  const dot = s('circle', { class: 'chart-dot', r: 4.5, visibility: 'hidden' })
  svg.append(cursor, dot)

  const tip = h('div', { class: 'chart-tip', hidden: true })
  const tipDate = h('span', { class: 'text-xs text-fg-3' })
  const tipValue = h('strong', null)
  const tipDelta = h('span', { class: 'text-xs font-semibold' })
  tip.append(tipDate, tipValue, tipDelta)

  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' })
  const surface = h('div', { class: 'chart-surface', tabindex: 0, role: 'img', 'aria-label': 'Use as setas para percorrer o histórico de preços' }, svg, tip)

  const first = points[0] as PricePoint
  function show(i: number): void {
    const p = points[Math.max(0, Math.min(points.length - 1, i))] as PricePoint
    const px = x(points.indexOf(p))
    cursor.setAttribute('x1', String(px))
    cursor.setAttribute('x2', String(px))
    cursor.setAttribute('visibility', 'visible')
    dot.setAttribute('cx', String(px))
    dot.setAttribute('cy', String(y(p.close)))
    dot.setAttribute('visibility', 'visible')
    tipDate.textContent = fmtDate(p.date)
    tipValue.textContent = fmtBrl(p.close)
    const delta = ((p.close - first.close) / first.close) * 100
    tipDelta.textContent = `${fmtSignedPoints(delta, 1)} no período`
    tipDelta.className = `text-xs font-semibold ${TEXT_TONE[delta >= 0 ? 'pos' : 'neg']}`
    tip.hidden = false
    const pct = (px / W) * 100
    tip.style.left = `${Math.min(Math.max(pct, 12), 88)}%`
    live.textContent = `${fmtDate(p.date)}: ${fmtBrl(p.close)}`
  }
  function hide(): void {
    cursor.setAttribute('visibility', 'hidden')
    dot.setAttribute('visibility', 'hidden')
    tip.hidden = true
  }
  let active = points.length - 1
  surface.addEventListener('pointermove', event => {
    const rect = surface.getBoundingClientRect()
    const ratio = ((event.clientX - rect.left) / rect.width) * W
    active = Math.round(((ratio - pad.l) / (W - pad.l - pad.r)) * (points.length - 1))
    active = Math.max(0, Math.min(points.length - 1, active))
    show(active)
  })
  surface.addEventListener('pointerleave', hide)
  surface.addEventListener('blur', hide)
  surface.addEventListener('keydown', event => {
    const step = event.shiftKey ? 10 : 1
    if (event.key === 'ArrowLeft') active = Math.max(0, active - step)
    else if (event.key === 'ArrowRight') active = Math.min(points.length - 1, active + step)
    else if (event.key === 'Home') active = 0
    else if (event.key === 'End') active = points.length - 1
    else return
    event.preventDefault()
    show(active)
  })

  wrap.append(surface, live)
  return wrap
}

/** Mini gráfico de linha para cartões. */
export function sparkline(values: number[], tone: 'pos' | 'neg' | 'neutral' = 'neutral', width = 96, height = 32): SVGSVGElement {
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: `spark spark-${tone}`, 'aria-hidden': 'true' })
  if (values.length < 2) return svg
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)} ${(height - 3 - ((v - lo) / span) * (height - 6)).toFixed(1)}`).join(' ')
  svg.appendChild(s('path', { d, class: 'spark-line' }))
  return svg
}

export interface BandStats {
  p5: number
  p25: number
  p50: number
  p75: number
  p95: number
}

/** Faixa de percentis (P5–P95 clara, P25–P75 escura, mediana em traço) com linha do zero. Valores em %. */
export function percentileBand(stats: BandStats, mean?: number): HTMLElement {
  const lo = Math.min(stats.p5, 0)
  const hi = Math.max(stats.p95, 0)
  const pad = (hi - lo || 1) * 0.08
  const min = lo - pad
  const max = hi + pad
  const pos = (v: number): number => ((v - min) / (max - min)) * 100
  const box = (from: number, to: number, cls: string): HTMLElement => {
    const el = h('span', { class: cls })
    el.style.left = `${pos(from)}%`
    el.style.width = `${Math.max(0.5, pos(to) - pos(from))}%`
    return el
  }
  const mark = (v: number, cls: string): HTMLElement => {
    const el = h('span', { class: cls })
    el.style.left = `${pos(v)}%`
    return el
  }
  const label = (v: number, text: string): HTMLElement => {
    const el = h('span', { class: 'band-label' }, h('b', null, text), fmtSignedPoints(v, 1))
    el.style.left = `${Math.min(92, Math.max(8, pos(v)))}%`
    return el
  }
  return h(
    'div',
    { class: 'pb-1', role: 'img', 'aria-label': `Distribuição simulada: 5% dos cenários abaixo de ${fmtSignedPoints(stats.p5, 1)}, mediana ${fmtSignedPoints(stats.p50, 1)}, 95% abaixo de ${fmtSignedPoints(stats.p95, 1)}` },
    h('div', { class: 'band-track' }, box(stats.p5, stats.p95, 'band-wide'), box(stats.p25, stats.p75, 'band-core'), mark(0, 'band-zero'), mark(stats.p50, 'band-median'), mean !== undefined ? mark(mean, 'band-mean') : null),
    h('div', { class: 'band-labels' }, label(stats.p5, 'P5 '), label(stats.p50, 'Mediana '), label(stats.p95, 'P95 '))
  )
}

export interface FrontierPoint {
  riskPct: number
  returnPct: number
}

export interface FrontierMark extends FrontierPoint {
  key: string
  label: string
}

/** Dispersão risco × retorno das carteiras simuladas, com as três carteiras-destaque rotuladas. */
export function frontierChart(points: FrontierPoint[], marks: FrontierMark[]): HTMLElement {
  const compact = window.innerWidth < 640
  const W = compact ? 360 : 560
  const H = compact ? 280 : 300
  const pad = { l: 54, r: 14, t: 14, b: 40 }
  const all = [...points, ...marks]
  if (all.length === 0) return h('p', { class: 'text-fg-2' }, 'Sem pontos para a fronteira.')
  const xs = all.map(p => p.riskPct)
  const ys = all.map(p => p.returnPct)
  const xr = (Math.max(...xs) - Math.min(...xs) || 1) * 0.08
  const yr = (Math.max(...ys) - Math.min(...ys) || 1) * 0.1
  const xMin = Math.min(...xs) - xr
  const xMax = Math.max(...xs) + xr
  const yMin = Math.min(...ys, 0) - yr
  const yMax = Math.max(...ys) + yr
  const x = (v: number): number => pad.l + ((v - xMin) / (xMax - xMin)) * (W - pad.l - pad.r)
  const y = (v: number): number => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b)

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg frontier', 'aria-hidden': 'true' })
  for (const tick of niceTicks(yMin, yMax, 4)) {
    svg.append(s('line', { class: 'chart-grid', x1: pad.l, x2: W - pad.r, y1: y(tick), y2: y(tick) }), s('text', { class: 'chart-axis', x: pad.l - 8, y: y(tick) + 4, 'text-anchor': 'end' }, `${fmtNum(tick, 1)}%`))
  }
  for (const tick of niceTicks(xMin, xMax, 5)) {
    svg.append(s('line', { class: 'chart-grid chart-grid-v', x1: x(tick), x2: x(tick), y1: pad.t, y2: H - pad.b }), s('text', { class: 'chart-axis', x: x(tick), y: H - pad.b + 16, 'text-anchor': 'middle' }, `${fmtNum(tick, 1)}%`))
  }
  svg.append(
    s('text', { class: 'chart-axis chart-axis-title', x: (pad.l + W - pad.r) / 2, y: H - 4, 'text-anchor': 'middle' }, 'Risco (desvio-padrão) →'),
    s('text', { class: 'chart-axis chart-axis-title', x: 11, y: (pad.t + H - pad.b) / 2, 'text-anchor': 'middle', transform: `rotate(-90 12 ${(pad.t + H - pad.b) / 2})` }, 'Retorno médio →')
  )
  for (const p of points) {
    svg.appendChild(s('circle', { class: 'fp', cx: x(p.riskPct), cy: y(p.returnPct), r: 3 }, s('title', null, `Risco ${fmtNum(p.riskPct, 1)}% · retorno ${fmtSignedPoints(p.returnPct, 1)}`)))
  }
  for (const m of marks) {
    svg.append(s('circle', { class: `fp-mark fp-${m.key}`, cx: x(m.riskPct), cy: y(m.returnPct), r: 7 }, s('title', null, `${m.label}: risco ${fmtNum(m.riskPct, 1)}% · retorno ${fmtSignedPoints(m.returnPct, 1)}`)))
  }

  return h(
    'figure',
    { class: 'relative min-w-0', role: 'group', 'aria-label': 'Fronteira de risco e retorno das carteiras simuladas' },
    svg,
    h('figcaption', { class: 'mt-2.5 flex flex-wrap gap-x-[18px] gap-y-2 text-[0.8125rem] text-fg-2' }, ...marks.map(m => h('span', { class: 'inline-flex items-center gap-[7px]' }, h('span', { class: `size-[11px] rounded-full fp-${m.key}` }), m.label)), h('span', { class: 'inline-flex items-center gap-[7px]' }, h('span', { class: 'fp-all size-[11px] rounded-full' }), 'Carteiras simuladas'))
  )
}
