// Seção "Pesquisa quantitativa": sub-abas Fatores, Backtest, Carteira robusta, IPS e Diário.
// Padrão de abas acessíveis (WAI-ARIA tabs): setas, Home/End e carregamento preguiçoso por aba.

import './styles/quant.css'
import { createBacktestTab } from './research-backtest'
import { h } from './research-dom'
import { createFactorsTab } from './research-factors'
import { createIpsTab } from './research-ips'
import { createJournalTab } from './research-journal'
import { createPortfolioTab } from './research-portfolio'
import type { TabContext, TabModule } from './research-types'

interface TabEntry {
  id: string
  label: string
  module: TabModule
  tab: HTMLButtonElement
  panel: HTMLElement
  mounted: boolean
}

export interface ResearchHandle {
  /** Chamado quando a seção fica visível: garante que a aba ativa carregue seus dados (ou abre a aba pedida). */
  show(tab?: string): void
}

export interface ResearchOptions {
  /** Aba aberta na montagem (padrão: fatores). */
  initial?: string
  /** Avisa o shell quando a aba muda, para refletir na URL. */
  onSelect?(id: string): void
}

export const QUANT_TABS = ['factors', 'backtest', 'portfolio', 'ips', 'journal']

export function initResearch(root: HTMLElement, options: ResearchOptions = {}): ResearchHandle {
  const entries: TabEntry[] = []
  const tablist = h('div', { class: 'quant-tabs', role: 'tablist', 'aria-label': 'Pesquisa quantitativa' })
  const panels = h('div', { class: 'quant-panels' })
  let activeId = ''

  const ctx: TabContext = { goToTab: id => select(id, true) }

  function select(id: string, focus = false): void {
    const next = entries.find(e => e.id === id)
    if (!next) return
    activeId = id
    for (const e of entries) {
      const active = e === next
      e.tab.setAttribute('aria-selected', String(active))
      e.tab.tabIndex = active ? 0 : -1
      e.panel.hidden = !active
    }
    if (!next.mounted) {
      next.mounted = true
      next.module.mount(next.panel)
    }
    next.module.onShow?.()
    if (focus) next.tab.focus()
    options.onSelect?.(id)
  }

  function add(id: string, label: string, module: TabModule): void {
    const tab = h('button', { type: 'button', role: 'tab', class: 'quant-tab', id: `quant-tab-${id}`, 'aria-controls': `quant-panel-${id}`, 'aria-selected': 'false', tabindex: -1 }, label)
    const panel = h('div', { role: 'tabpanel', class: 'quant-panel', id: `quant-panel-${id}`, 'aria-labelledby': `quant-tab-${id}`, tabindex: 0 })
    panel.hidden = true
    tab.addEventListener('click', () => select(id))
    tab.addEventListener('keydown', event => {
      const index = entries.findIndex(e => e.id === id)
      let target = -1
      if (event.key === 'ArrowRight') target = (index + 1) % entries.length
      else if (event.key === 'ArrowLeft') target = (index - 1 + entries.length) % entries.length
      else if (event.key === 'Home') target = 0
      else if (event.key === 'End') target = entries.length - 1
      if (target >= 0) {
        event.preventDefault()
        select((entries[target] as TabEntry).id, true)
      }
    })
    entries.push({ id, label, module, tab, panel, mounted: false })
    tablist.appendChild(tab)
    panels.appendChild(panel)
  }

  add('factors', 'Fatores', createFactorsTab())
  add('backtest', 'Backtest', createBacktestTab())
  add('portfolio', 'Carteira robusta', createPortfolioTab(ctx))
  add('ips', 'IPS', createIpsTab(ctx))
  add('journal', 'Diário', createJournalTab())

  root.append(tablist, panels)
  select(entries.some(e => e.id === options.initial) ? (options.initial as string) : 'factors')
  // a primeira seleção acima carrega a aba inicial; show() só repete o onShow da aba ativa (idempotente)
  return {
    show(tab?: string): void {
      if (tab && tab !== activeId && entries.some(e => e.id === tab)) {
        select(tab)
        return
      }
      const current = entries.find(e => e.id === activeId)
      current?.module.onShow?.()
      options.onSelect?.(activeId)
    },
  }
}
