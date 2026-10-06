// Paleta de comandos (Ctrl/⌘ K ou "/"): digite um ticker para analisar, ou navegue pelas ferramentas.

import { h } from '../research-dom'
import { NAV } from '../nav'
import { hrefAlert, hrefAnalyze, hrefNews, navigate, pathFor } from '../router'
import { recents, theme, watchlist } from '../store'
import { UNIVERSE, isValidTicker, shortTicker, toTicker } from './format'
import { type IconName, icon } from './icons'
import { toast } from './toast'

interface Item {
  id: string
  group: string
  label: string
  hint?: string
  icon: IconName
  run(): void
}

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function createPalette(): { open(): void; close(): void } {
  const input = h('input', {
    type: 'text',
    class: 'min-w-0 flex-1 bg-transparent text-[1.0625rem] text-fg outline-none placeholder:text-fg-3',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'palette-list',
    'aria-autocomplete': 'list',
    'aria-label': 'Buscar ação ou ferramenta',
    placeholder: 'Digite um ticker (PETR4) ou o nome de uma ferramenta…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  })
  const list = h('ul', { class: 'flex-1 overflow-y-auto px-2 pt-1.5 pb-2', id: 'palette-list', role: 'listbox', 'aria-label': 'Resultados' })
  const dialog = h(
    'dialog',
    { class: 'palette', 'aria-label': 'Busca rápida' },
    h(
      'div',
      { class: 'flex max-h-[inherit] flex-col' },
      h('div', { class: 'flex items-center gap-3 border-b border-line px-4 py-3.5 text-fg-3' }, icon('search', 20), input, h('kbd', { class: 'kbd' }, 'Esc')),
      list,
      h(
        'div',
        { class: 'flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-fg-3' },
        h('span', { class: 'max-phone:hidden' }, h('kbd', { class: 'kbd mr-[3px]' }, '↑'), h('kbd', { class: 'kbd mr-[3px]' }, '↓'), ' navegar'),
        h('span', { class: 'max-phone:hidden' }, h('kbd', { class: 'kbd mr-[3px]' }, 'Enter'), ' abrir'),
        h('span', { class: 'ml-auto max-phone:ml-0' }, 'Não é recomendação de investimento')
      )
    )
  )
  document.body.appendChild(dialog)

  let items: Item[] = []
  let active = 0

  const go = (path: string) => (): void => navigate(path)

  function build(query: string): Item[] {
    const q = fold(query.trim())
    const out: Item[] = []

    // 1) o texto parece um ticker: ações diretas
    const ticker = toTicker(query)
    if (query.trim() && isValidTicker(ticker)) {
      const t = shortTicker(ticker)
      out.push(
        { id: `a:${ticker}`, group: 'Ativo', label: `Analisar ${t}`, hint: 'Score, RSI, notícias e IA', icon: 'search', run: go(hrefAnalyze(ticker)) },
        { id: `n:${ticker}`, group: 'Ativo', label: `Notícias e papers de ${t}`, icon: 'news', run: go(hrefNews(ticker)) },
        { id: `l:${ticker}`, group: 'Ativo', label: `Criar alerta para ${t}`, icon: 'bell', run: go(hrefAlert(ticker)) },
        {
          id: `w:${ticker}`,
          group: 'Ativo',
          label: watchlist.has(ticker) ? `Remover ${t} da watchlist` : `Adicionar ${t} à watchlist`,
          icon: 'star',
          run: () => {
            if (watchlist.has(ticker)) watchlist.remove(ticker)
            else watchlist.add(ticker)
            toast(watchlist.has(ticker) ? `${ticker} adicionada à watchlist` : `${ticker} removida da watchlist`, 'success', 2500)
          },
        }
      )
    }

    // 2) empresas do universo que casam com o texto
    if (q) {
      const matches = UNIVERSE.filter(u => fold(`${u.ticker} ${u.name}`).includes(q) && !(out.length > 0 && u.ticker === ticker)).slice(0, 5)
      for (const u of matches) out.push({ id: `u:${u.ticker}`, group: 'Ações', label: `${shortTicker(u.ticker)} — ${u.name}`, hint: 'Analisar', icon: 'search', run: go(hrefAnalyze(u.ticker)) })
    } else {
      for (const t of recents.get().slice(0, 4)) out.push({ id: `r:${t}`, group: 'Recentes', label: shortTicker(t), hint: 'Analisar', icon: 'clock', run: go(hrefAnalyze(t)) })
      for (const w of watchlist.get().slice(0, 4)) out.push({ id: `wl:${w.ticker}`, group: 'Watchlist', label: shortTicker(w.ticker), hint: 'Analisar', icon: 'star', run: go(hrefAnalyze(w.ticker)) })
    }

    // 3) navegação
    for (const n of NAV) {
      if (!q || fold(`${n.label} ${n.description} ${n.keywords}`).includes(q)) out.push({ id: `nav:${n.id}`, group: 'Ir para', label: n.label, hint: n.description, icon: n.icon, run: go(pathFor(n.id)) })
    }
    // sub-abas da pesquisa quant
    const quantTabs: Array<[string, string]> = [['factors', 'Fatores'], ['backtest', 'Backtest'], ['portfolio', 'Carteira robusta'], ['ips', 'IPS (política de investimento)'], ['journal', 'Diário de decisões']]
    for (const [id, label] of quantTabs) {
      if (q && fold(`quant ${label}`).includes(q)) out.push({ id: `q:${id}`, group: 'Pesquisa quant', label, icon: 'flask', run: go(pathFor('quant', [id])) })
    }

    // 4) preferências
    if (!q || fold('tema claro escuro modo').includes(q)) out.push({ id: 'theme', group: 'Preferências', label: theme.current() === 'dark' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro', icon: theme.current() === 'dark' ? 'sun' : 'moon', run: () => void theme.toggle() })
    return out
  }

  function render(): void {
    items = build(input.value)
    active = Math.min(active, Math.max(0, items.length - 1))
    list.replaceChildren()
    if (items.length === 0) {
      list.appendChild(h('li', { class: 'px-3 py-7 text-center text-fg-2', role: 'presentation' }, `Nada encontrado para “${input.value}”. Tente um código como PETR4.`))
      input.removeAttribute('aria-activedescendant')
      return
    }
    let lastGroup = ''
    items.forEach((item, i) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group
        list.appendChild(h('li', { class: 'px-2.5 pt-3 pb-1 text-[0.6875rem] font-bold tracking-[0.08em] text-fg-3 uppercase', role: 'presentation' }, item.group))
      }
      const row = h('li', { class: `palette-item${i === active ? ' is-active' : ''}`, role: 'option', id: `pal-${i}`, 'aria-selected': String(i === active) }, h('span', { class: 'palette-icon inline-flex text-fg-2' }, icon(item.icon, 18)), h('span', { class: 'min-w-0 flex-1 font-semibold' }, item.label), item.hint ? h('span', { class: 'min-w-0 truncate text-[0.8125rem] text-fg-3 max-phone:hidden' }, item.hint) : null)
      row.addEventListener('pointermove', () => setActive(i, false))
      row.addEventListener('click', () => choose(i))
      list.appendChild(row)
    })
    input.setAttribute('aria-activedescendant', `pal-${active}`)
  }

  function setActive(next: number, scroll = true): void {
    if (items.length === 0 || next === active) return
    active = (next + items.length) % items.length
    list.querySelectorAll('.palette-item').forEach((el, i) => {
      el.classList.toggle('is-active', i === active)
      el.setAttribute('aria-selected', String(i === active))
      if (i === active && scroll) el.scrollIntoView({ block: 'nearest' })
    })
    input.setAttribute('aria-activedescendant', `pal-${active}`)
  }

  function choose(index: number): void {
    const item = items[index]
    if (!item) return
    close()
    item.run()
  }

  function open(): void {
    if (dialog.open) return
    input.value = ''
    active = 0
    render()
    dialog.showModal()
    input.focus()
  }

  function close(): void {
    if (dialog.open) dialog.close()
  }

  input.addEventListener('input', () => {
    active = 0
    render()
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(active + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(active - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    }
  })
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close()
  })

  return { open, close }
}
