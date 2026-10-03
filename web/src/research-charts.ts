// Gráficos SVG inline (sem bibliotecas): curva de patrimônio e curva de confiabilidade.
// Cores vêm de variáveis CSS (--viz-*), validadas para tema claro e escuro; textos usam tokens de texto.

import { type Child, append, fmtDate, fmtNum, fmtPct, h, isNum, s } from './research-dom'

// ---- Auxiliares ------------------------------------------------------------

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    min -= 0.5
    max += 0.5
  }
  const rawStep = (max - min) / Math.max(1, count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const norm = rawStep / magnitude
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

function createTooltip(container: HTMLElement) {
  const tip = h('div', { class: 'quant-tooltip' })
  tip.hidden = true
  container.appendChild(tip)
  return {
    show(x: number, y: number, children: Child[]): void {
      tip.replaceChildren()
      append(tip, children)
      tip.hidden = false
      const width = tip.offsetWidth
      const left = x + 14 + width > container.clientWidth ? Math.max(0, x - 14 - width) : x + 14
      tip.style.left = `${left}px`
      tip.style.top = `${Math.max(0, y - 10)}px`
    },
    hide(): void {
      tip.hidden = true
    },
  }
}

export type SeriesKind = 'strategy' | 'benchmark' | 'cdi'

function legendItem(label: string, kind: SeriesKind | 'perfect' | 'points'): HTMLElement {
  return h('li', null, h('span', { class: `quant-key quant-key-${kind}`, 'aria-hidden': 'true' }), h('span', null, label))
}

// ---- Curva de patrimônio ---------------------------------------------------

export interface LineSeries {
  label: string
  kind: SeriesKind
  values: Array<number | null>
}

export interface LineChartSpec {
  dates: string[]
  series: LineSeries[]
  ariaLabel: string
  yTitle: string
  format: (v: number) => string
}

const M = { top: 12, right: 16, bottom: 26, left: 50 }

export function lineChart(spec: LineChartSpec): HTMLElement {
  const times = spec.dates.map(d => Date.parse(`${d}T00:00:00Z`))
  const n = times.length
  const lastIndexWithData = (): number => {
    for (let i = n - 1; i >= 0; i--) if (spec.series.some(sr => isNum(sr.values[i]))) return i
    return -1
  }

  const plot = h('div', {
    class: 'quant-chart-plot',
    tabindex: 0,
    role: 'img',
    'aria-label': `${spec.ariaLabel}. Use as setas esquerda e direita para ler os valores por data; a tabela de dados está logo abaixo.`,
  })
  const tooltip = createTooltip(plot)
  let drawnWidth = 0
  let cursor = -1
  let overlay: { move(index: number): void; clear(): void } | null = null

  function draw(width: number): void {
    plot.querySelector('svg')?.remove()
    drawnWidth = width
    const height = Math.round(Math.min(320, Math.max(210, width * 0.48)))
    const innerW = width - M.left - M.right
    const innerH = height - M.top - M.bottom

    let min = Infinity
    let max = -Infinity
    for (const sr of spec.series) {
      for (const v of sr.values) {
        if (!isNum(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, focusable: 'false', 'aria-hidden': 'true' })
    plot.insertBefore(svg, plot.firstChild)
    if (!isFinite(min) || n < 2) {
      svg.appendChild(s('text', { x: 12, y: 24, class: 'q-axis-text' }, 'Sem dados suficientes para o gráfico.'))
      overlay = null
      return
    }

    const ticks = niceTicks(min, max, 5)
    const yMin = ticks[0] as number
    const yMax = ticks[ticks.length - 1] as number
    const t0 = times[0] as number
    const t1 = times[n - 1] as number
    const x = (t: number): number => M.left + ((t - t0) / (t1 - t0 || 1)) * innerW
    const y = (v: number): number => M.top + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH

    for (const tick of ticks) {
      svg.appendChild(s('line', { x1: M.left, x2: width - M.right, y1: y(tick), y2: y(tick), class: 'q-grid' }))
      svg.appendChild(s('text', { x: M.left - 6, y: y(tick) + 4, class: 'q-axis-text', 'text-anchor': 'end' }, fmtNum(tick, tick % 1 === 0 ? 0 : 1)))
    }

    // eixo X: primeiro pregão de cada ano (no máximo ~7 rótulos)
    const years: Array<{ year: string; t: number }> = []
    let lastYear = ''
    spec.dates.forEach((d, i) => {
      const year = d.slice(0, 4)
      if (year !== lastYear) {
        years.push({ year, t: times[i] as number })
        lastYear = year
      }
    })
    const every = Math.max(1, Math.ceil(years.length / 7))
    years.forEach((entry, i) => {
      if (i % every !== 0) return
      const px = x(entry.t)
      if (px < M.left + 8 || px > width - M.right - 8) return
      svg.appendChild(s('line', { x1: px, x2: px, y1: M.top + innerH, y2: M.top + innerH + 4, class: 'q-grid' }))
      svg.appendChild(s('text', { x: px, y: height - 8, class: 'q-axis-text', 'text-anchor': 'middle' }, entry.year))
    })

    const order: SeriesKind[] = ['cdi', 'benchmark', 'strategy'] // estratégia por cima
    const sorted = [...spec.series].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    for (const sr of sorted) {
      let path = ''
      let pen = false
      sr.values.forEach((v, i) => {
        if (!isNum(v)) {
          pen = false
          return
        }
        path += `${pen ? 'L' : 'M'}${x(times[i] as number).toFixed(1)} ${y(v).toFixed(1)}`
        pen = true
      })
      svg.appendChild(s('path', { d: path, class: `q-line q-line-${sr.kind}`, fill: 'none' }))
    }

    // marcador no último ponto (anel na cor da superfície)
    const end = lastIndexWithData()
    for (const sr of sorted) {
      const v = sr.values[end]
      if (end >= 0 && isNum(v)) svg.appendChild(s('circle', { cx: x(times[end] as number), cy: y(v), r: 4, class: `q-dot q-dot-${sr.kind}` }))
    }

    // camada de hover/teclado
    const cross = s('line', { y1: M.top, y2: M.top + innerH, class: 'q-cross' })
    const hoverDots = sorted.map(sr => s('circle', { r: 4, class: `q-dot q-dot-${sr.kind}` }))
    const layer = s('g', null, cross, ...hoverDots)
    layer.setAttribute('visibility', 'hidden')
    svg.appendChild(layer)

    overlay = {
      move(index: number): void {
        const i = Math.max(0, Math.min(n - 1, index))
        cursor = i
        const px = x(times[i] as number)
        cross.setAttribute('x1', String(px))
        cross.setAttribute('x2', String(px))
        const rowBySeries = new Map<LineSeries, HTMLElement>()
        let topY = M.top + innerH
        sorted.forEach((sr, k) => {
          const v = sr.values[i]
          const dot = hoverDots[k] as SVGCircleElement
          if (isNum(v)) {
            dot.setAttribute('cx', String(px))
            dot.setAttribute('cy', String(y(v)))
            dot.setAttribute('visibility', 'visible')
            topY = Math.min(topY, y(v))
            rowBySeries.set(
              sr,
              h('div', { class: 'quant-tooltip-row' }, h('span', { class: `quant-key quant-key-${sr.kind}`, 'aria-hidden': 'true' }), h('strong', null, spec.format(v)), h('span', { class: 'quant-tooltip-label' }, sr.label))
            )
          } else {
            dot.setAttribute('visibility', 'hidden')
          }
        })
        layer.setAttribute('visibility', 'visible')
        // linhas do tooltip na ordem da legenda (estratégia primeiro)
        const rows: Child[] = [h('div', { class: 'quant-tooltip-date' }, fmtDate(spec.dates[i])), ...spec.series.map(sr => rowBySeries.get(sr) ?? null)]
        tooltip.show(px, topY, rows)
      },
      clear(): void {
        layer.setAttribute('visibility', 'hidden')
        tooltip.hide()
      },
    }
  }

  const indexAt = (clientX: number): number => {
    const rect = plot.getBoundingClientRect()
    const innerW = rect.width - M.left - M.right
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - M.left) / (innerW || 1)))
    const target = (times[0] as number) + ratio * ((times[n - 1] as number) - (times[0] as number))
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((times[mid] as number) < target) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && Math.abs((times[lo - 1] as number) - target) < Math.abs((times[lo] as number) - target) ? lo - 1 : lo
  }

  plot.addEventListener('pointermove', e => overlay?.move(indexAt(e.clientX)))
  plot.addEventListener('pointerleave', () => {
    if (document.activeElement !== plot) overlay?.clear()
  })
  plot.addEventListener('focus', () => overlay?.move(cursor >= 0 ? cursor : lastIndexWithData()))
  plot.addEventListener('blur', () => overlay?.clear())
  plot.addEventListener('keydown', e => {
    if (!overlay || n < 2) return
    const step = Math.max(1, Math.round(n / 60))
    const from = cursor >= 0 ? cursor : lastIndexWithData()
    let next: number | null = null
    if (e.key === 'ArrowRight') next = from + step
    else if (e.key === 'ArrowLeft') next = from - step
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    if (next !== null) {
      e.preventDefault()
      overlay.move(next)
    }
  })

  const redraw = (width: number): void => {
    if (width > 0 && Math.abs(width - drawnWidth) >= 1) draw(Math.floor(width))
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) redraw(entry.contentRect.width)
    }).observe(plot)
  } else {
    draw(640)
  }

  // legenda (>= 2 séries) e tabela de dados (alternativa acessível ao gráfico)
  const legend = h('ul', { class: 'quant-legend' }, ...spec.series.map(sr => legendItem(sr.label, sr.kind)))

  const sampleCount = Math.min(n, 14)
  const rowsIdx = new Set<number>()
  for (let k = 0; k < sampleCount; k++) rowsIdx.add(Math.round((k * (n - 1)) / Math.max(1, sampleCount - 1)))
  const dataTable = h(
    'table',
    { class: 'quant-table' },
    h('caption', { class: 'sr-only' }, `${spec.ariaLabel} — valores em datas selecionadas`),
    h('thead', null, h('tr', null, h('th', { scope: 'col', class: 't-left' }, 'Data'), ...spec.series.map(sr => h('th', { scope: 'col' }, sr.label)))),
    h(
      'tbody',
      null,
      ...[...rowsIdx].sort((a, b) => a - b).map(i =>
        h('tr', null, h('th', { scope: 'row', class: 't-left' }, fmtDate(spec.dates[i])), ...spec.series.map(sr => h('td', null, isNum(sr.values[i]) ? spec.format(sr.values[i] as number) : '—')))
      )
    )
  )

  const end = lastIndexWithData()
  const summary =
    end >= 0
      ? h(
          'p',
          { class: 'quant-hint' },
          `${spec.yTitle}. Último ponto (${fmtDate(spec.dates[end])}): ` +
            spec.series.map(sr => `${sr.label} ${isNum(sr.values[end]) ? spec.format(sr.values[end] as number) : '—'}`).join(' · ')
        )
      : null

  return h(
    'div',
    { class: 'quant-chart' },
    legend,
    plot,
    summary,
    h('details', { class: 'quant-details' }, h('summary', null, 'Ver tabela de dados'), h('div', { class: 'quant-table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Tabela de dados do gráfico' }, dataTable))
  )
}

// ---- Curva de confiabilidade ----------------------------------------------

export interface ReliabilityPoint {
  from: number
  to: number
  count: number
  forecast: number
  observed: number
}

export function reliabilityChart(points: ReliabilityPoint[]): HTMLElement {
  const plot = h('div', { class: 'quant-chart-plot quant-chart-square', role: 'group', 'aria-label': 'Curva de confiabilidade: probabilidade prevista contra frequência observada. Os valores de cada faixa estão na tabela abaixo.' })
  const tooltip = createTooltip(plot)
  let drawnWidth = 0
  const m = { top: 10, right: 14, bottom: 44, left: 48 }

  function draw(width: number): void {
    plot.querySelector('svg')?.remove()
    drawnWidth = width
    const size = width
    const innerW = size - m.left - m.right
    const innerH = size - m.top - m.bottom
    const x = (v: number): number => m.left + v * innerW
    const y = (v: number): number => m.top + (1 - v) * innerH
    const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, focusable: 'false' })
    plot.insertBefore(svg, plot.firstChild)

    for (let k = 0; k <= 5; k++) {
      const v = k / 5
      svg.appendChild(s('line', { x1: m.left, x2: m.left + innerW, y1: y(v), y2: y(v), class: 'q-grid' }))
      svg.appendChild(s('line', { x1: x(v), x2: x(v), y1: m.top, y2: m.top + innerH, class: 'q-grid' }))
      svg.appendChild(s('text', { x: m.left - 6, y: y(v) + 4, class: 'q-axis-text', 'text-anchor': 'end' }, fmtPct(v, 0)))
      svg.appendChild(s('text', { x: x(v), y: m.top + innerH + 16, class: 'q-axis-text', 'text-anchor': 'middle' }, fmtPct(v, 0)))
    }
    svg.appendChild(s('text', { x: m.left + innerW / 2, y: size - 6, class: 'q-axis-text', 'text-anchor': 'middle' }, 'Probabilidade prevista'))
    const yTitle = s('text', { x: 0, y: 0, class: 'q-axis-text', 'text-anchor': 'middle', transform: `translate(12 ${m.top + innerH / 2}) rotate(-90)` }, 'Frequência observada')
    svg.appendChild(yTitle)

    svg.appendChild(s('line', { x1: x(0), y1: y(0), x2: x(1), y2: y(1), class: 'q-line q-line-cdi q-line-perfect' }))

    const sorted = [...points].sort((a, b) => a.forecast - b.forecast)
    if (sorted.length > 1) {
      svg.appendChild(s('path', { d: sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.forecast).toFixed(1)} ${y(p.observed).toFixed(1)}`).join(''), class: 'q-line q-line-strategy', fill: 'none' }))
    }
    for (const p of sorted) {
      const radius = Math.min(11, 5 + Math.sqrt(p.count))
      svg.appendChild(s('circle', { cx: x(p.forecast), cy: y(p.observed), r: radius, class: 'q-dot q-dot-strategy' }))
    }
    for (const p of sorted) {
      const label = `Faixa ${fmtPct(p.from, 0)} a ${fmtPct(p.to, 0)}: ${p.count} previsões; previsto ${fmtPct(p.forecast, 0)}, observado ${fmtPct(p.observed, 0)}`
      const hit = s('circle', { cx: x(p.forecast), cy: y(p.observed), r: 16, class: 'q-hit', tabindex: 0, role: 'img', 'aria-label': label })
      const show = (): void =>
        tooltip.show(x(p.forecast), y(p.observed), [
          h('div', { class: 'quant-tooltip-date' }, `Faixa ${fmtPct(p.from, 0)}–${fmtPct(p.to, 0)}`),
          h('div', { class: 'quant-tooltip-row' }, h('strong', null, fmtPct(p.observed, 0)), h('span', { class: 'quant-tooltip-label' }, 'observado')),
          h('div', { class: 'quant-tooltip-row' }, h('strong', null, fmtPct(p.forecast, 0)), h('span', { class: 'quant-tooltip-label' }, 'previsto (média)')),
          h('div', { class: 'quant-tooltip-row' }, h('strong', null, String(p.count)), h('span', { class: 'quant-tooltip-label' }, 'previsões')),
        ])
      hit.addEventListener('pointerenter', show)
      hit.addEventListener('focus', show)
      hit.addEventListener('pointerleave', () => tooltip.hide())
      hit.addEventListener('blur', () => tooltip.hide())
      svg.appendChild(hit)
    }
  }

  const redraw = (width: number): void => {
    if (width > 0 && Math.abs(width - drawnWidth) >= 1) draw(Math.floor(width))
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) redraw(entry.contentRect.width)
    }).observe(plot)
  } else {
    draw(360)
  }

  return h(
    'div',
    { class: 'quant-chart' },
    h('ul', { class: 'quant-legend' }, legendItem('Previsões por faixa (tamanho = nº de previsões)', 'points'), legendItem('Calibração perfeita', 'perfect')),
    plot
  )
}
