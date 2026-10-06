import { h } from '../research-dom'
import { icon, type IconName } from './icons'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

const ICON: Record<ToastType, IconName> = { success: 'check', error: 'alert', info: 'info', warning: 'alert' }
const MAX_VISIBLE = 4

export function toast(message: string, type: ToastType = 'info', duration = 4000): void {
  const host = document.getElementById('toast-container')
  if (!host) return

  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const dismiss = (): void => {
    clearTimeout(timer)
    el.classList.remove('show')
    setTimeout(() => el.remove(), 250)
  }
  const close = h('button', { type: 'button', class: 'inline-flex rounded-md p-1 text-fg-3 hover:text-fg', 'aria-label': 'Fechar aviso', onClick: dismiss }, icon('x', 16))
  el.append(h('span', { class: 'toast-icon mt-px inline-flex' }, icon(ICON[type], 18)), h('span', { class: 'min-w-0 flex-1 [overflow-wrap:anywhere]' }, message), close)

  while (host.childElementCount >= MAX_VISIBLE) host.firstElementChild?.remove()
  host.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  timer = setTimeout(dismiss, duration)
}
