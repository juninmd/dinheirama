// Conjunto de ícones de traço (24×24, currentColor). Cada ícone é uma lista de formas: string = path, tupla = circle/rect.

import { s } from '../research-dom'

type Shape = string | ['circle', number, number, number] | ['rect', number, number, number, number, number]

const ICONS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20h5v-6h4v6h5V9.5'],
  search: [['circle', 11, 11, 7], 'm20 20-3.6-3.6'],
  radar: [['circle', 12, 12, 9], ['circle', 12, 12, 4.5], 'm12 12 6-6'],
  dice: [['rect', 4, 4, 16, 16, 3.5], 'M9 9h.01', 'M15 9h.01', 'M12 12h.01', 'M9 15h.01', 'M15 15h.01'],
  flask: ['M9 3h6', 'M10 3v6L5 19a1.6 1.6 0 0 0 1.4 2.3h11.2A1.6 1.6 0 0 0 19 19l-5-10V3', 'M7.5 15h9'],
  news: ['M5 4h11a1 1 0 0 1 1 1v14a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2V4Z', 'M17 9h3v10a2 2 0 0 1-2 2', 'M8.5 8h5', 'M8.5 12h5', 'M8.5 16h5'],
  cap: ['M2 9 12 4l10 5-10 5L2 9Z', 'M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5', 'M22 9v5'],
  bell: ['M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z', 'M10 20a2 2 0 0 0 4 0'],
  star: ['m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z'],
  sun: [['circle', 12, 12, 4], 'M12 2.5v2', 'M12 19.5v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2.5 12h2', 'M19.5 12h2', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'm6 7 1 13h10l1-13', 'M9 7V4h6v3'],
  pause: [['rect', 6, 5, 4, 14, 1], ['rect', 14, 5, 4, 14, 1]],
  play: ['M7 4.5v15l12-7.5-12-7.5Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  refresh: ['M20 11a8 8 0 0 0-14.5-4', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.5 4', 'M20 20v-4h-4'],
  up: ['M3 17l6.5-6.5 4 4L21 7', 'M15 7h6v6'],
  down: ['M3 7l6.5 6.5 4-4L21 17', 'M15 17h6v-6'],
  shield: ['M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z'],
  alert: ['M12 4 2.8 19.5h18.4L12 4Z', 'M12 10v4.5', 'M12 17.3h.01'],
  info: [['circle', 12, 12, 9], 'M12 11v5', 'M12 8h.01'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  send: ['m21 3-9.5 18-2.5-7.5L1.5 11 21 3Z', 'M21 3 9 13.5'],
  more: [['circle', 5, 12, 1], ['circle', 12, 12, 1], ['circle', 19, 12, 1]],
  clock: [['circle', 12, 12, 9], 'M12 7v5l3 2'],
  sparkles: ['m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z', 'm19 16 .7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16Z'],
  chevron: ['m9 6 6 6-6 6'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  zap: ['M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 13 9 5 9-5'],
  target: [['circle', 12, 12, 9], ['circle', 12, 12, 5], ['circle', 12, 12, 1]],
  book: ['M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Z', 'M5 16a4 4 0 0 1 4-4h9'],
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof ICONS

export function icon(name: IconName, size = 20, opts: { filled?: boolean; class?: string } = {}): SVGSVGElement {
  const svg = s('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: opts.filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: opts.class ? `icon ${opts.class}` : 'icon',
  })
  for (const shape of ICONS[name] as Shape[]) {
    if (typeof shape === 'string') svg.appendChild(s('path', { d: shape }))
    else if (shape[0] === 'circle') svg.appendChild(s('circle', { cx: shape[1], cy: shape[2], r: shape[3] }))
    else svg.appendChild(s('rect', { x: shape[1], y: shape[2], width: shape[3], height: shape[4], rx: shape[5] }))
  }
  return svg
}
