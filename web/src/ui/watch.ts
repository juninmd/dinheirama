import { h } from '../research-dom'
import { watchlist } from '../store'
import { icon } from './icons'
import { toast } from './toast'

let wired = false

function paint(button: HTMLButtonElement, active: boolean): void {
  button.setAttribute('aria-pressed', String(active))
  button.classList.toggle('is-active', active)
  const ticker = button.dataset.watch ?? ''
  const label = active ? `Remover ${ticker} da watchlist` : `Adicionar ${ticker} à watchlist`
  button.title = label
  button.setAttribute('aria-label', label)
  const text = button.querySelector('.watch-text')
  if (text) text.textContent = active ? 'Na watchlist' : 'Watchlist'
  const svg = button.querySelector('svg')
  if (svg) svg.setAttribute('fill', active ? 'currentColor' : 'none')
}

function syncAll(): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-watch]').forEach(button => paint(button, watchlist.has(button.dataset.watch ?? '')))
}

/** Botão estrela ligado à watchlist; todas as cópias na tela se mantêm sincronizadas. */
export function watchToggle(ticker: string, opts: { labelled?: boolean } = {}): HTMLButtonElement {
  if (!wired) {
    wired = true
    watchlist.subscribe(syncAll)
  }
  const button = h(
    'button',
    { type: 'button', class: opts.labelled ? 'btn btn-secondary watch-btn' : 'icon-btn watch-btn', 'data-watch': ticker },
    icon('star', opts.labelled ? 18 : 20),
    opts.labelled ? h('span', { class: 'watch-text' }) : null
  )
  button.addEventListener('click', () => {
    if (watchlist.has(ticker)) {
      watchlist.remove(ticker)
      toast(`${ticker} removida da watchlist`, 'info', 2500)
    } else {
      const { dropped } = watchlist.add(ticker)
      toast(dropped ? `${ticker} adicionada; ${dropped} saiu por falta de espaço` : `${ticker} adicionada à watchlist`, 'success', 2500)
    }
  })
  paint(button, watchlist.has(ticker))
  return button
}
