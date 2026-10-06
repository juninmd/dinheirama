import './styles/app.css'

import { h } from './research-dom'
import { GROUPS, MOBILE_PRIMARY, NAV, TITLES, type NavItem } from './nav'
import { type Route, type View, pathFor, parseRoute } from './router'
import { theme } from './store'
import { type IconName, icon } from './ui/icons'
import { createPalette } from './ui/palette'
import { toast } from './ui/toast'
import { createAlertsView } from './views/alerts'
import { createAnalyzeView } from './views/analyze'
import { createHomeView } from './views/home'
import { createMonteCarloView } from './views/montecarlo'
import { createNewsView } from './views/news'
import { createQuantView, preloadQuant } from './views/quant'
import { createRadarView } from './views/radar'
import { createTrainingView } from './views/training'

const FACTORIES: Record<string, () => View> = {
  inicio: createHomeView,
  analisar: createAnalyzeView,
  radar: createRadarView,
  simulacao: createMonteCarloView,
  quant: createQuantView,
  noticias: createNewsView,
  treino: createTrainingView,
  alertas: createAlertsView,
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

theme.init()

// ---- Navegação (lateral no desktop, barra inferior no celular) -----------------

// no trilho de ícones (tablet) o rótulo some; na barra inferior ele sempre aparece
function navLink(item: NavItem, className: string, labelClass = ''): HTMLAnchorElement {
  return h('a', { class: className, href: pathFor(item.id), 'data-nav': item.id, title: item.label }, icon(item.icon, 20), h('span', { class: labelClass || null }, item.label))
}

const GROUP_TITLE =
  'px-3 pt-4 pb-1.5 text-[0.6875rem] font-bold tracking-[0.08em] text-fg-3 uppercase max-lg:mx-2 max-lg:my-2.5 max-lg:h-px max-lg:overflow-hidden max-lg:bg-line max-lg:p-0 max-lg:text-[0px]'

function buildNavigation(): void {
  const side = $('side-nav')
  for (const group of GROUPS) {
    side.appendChild(h('p', { class: GROUP_TITLE }, group))
    for (const item of NAV.filter(n => n.group === group)) side.appendChild(navLink(item, 'nav-link', 'max-lg:hidden'))
  }

  const bar = $('tab-bar')
  for (const id of MOBILE_PRIMARY) {
    const item = NAV.find(n => n.id === id)
    if (item) bar.appendChild(navLink(item, 'tab-link'))
  }
  const more = h('button', { type: 'button', class: 'tab-link', id: 'more-btn', 'aria-haspopup': 'dialog', title: 'Mais ferramentas' }, icon('more', 20), h('span', null, 'Mais'))
  bar.appendChild(more)

  // folha "Mais": o que não cabe na barra + tema
  const sheet = h('dialog', { class: 'sheet', 'aria-label': 'Mais ferramentas' })
  const rest = NAV.filter(n => !MOBILE_PRIMARY.includes(n.id))
  sheet.append(
    h('div', { class: 'mx-auto mb-3.5 h-[5px] w-11 rounded-full bg-line-strong', 'aria-hidden': 'true' }),
    h('h2', { class: 'mb-2 text-[1.0625rem] font-bold' }, 'Mais ferramentas'),
    h('div', { class: 'grid gap-1' }, ...rest.map(item => h('a', { class: 'sheet-item', href: pathFor(item.id), 'data-nav': item.id, onClick: () => sheet.close() }, h('span', { class: 'explore-icon' }, icon(item.icon, 20)), h('span', { class: 'explore-text' }, h('strong', null, item.label), h('span', null, item.description))))),
    h('button', { type: 'button', class: 'btn btn-ghost mt-2 w-full', onClick: () => sheet.close() }, 'Fechar')
  )
  sheet.addEventListener('click', event => {
    if (event.target === sheet) sheet.close()
  })
  document.body.appendChild(sheet)
  more.addEventListener('click', () => sheet.showModal())

  // carrega a pesquisa quant (maior parte do JS) assim que o usuário demonstra interesse
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-nav="quant"]')) {
    link.addEventListener('pointerenter', () => void preloadQuant().catch(() => undefined), { once: true })
    link.addEventListener('focus', () => void preloadQuant().catch(() => undefined), { once: true })
  }
}

// ---- Roteamento entre views (montadas uma vez; o estado de cada uma sobrevive à navegação) ----

const views = new Map<string, View>()
let activeId = ''
let firstRender = true

function highlightNav(id: string): void {
  for (const link of document.querySelectorAll<HTMLElement>('[data-nav]')) {
    const active = link.dataset.nav === id
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  $('more-btn')?.classList.toggle('is-active', !MOBILE_PRIMARY.includes(id))
}

function renderRoute(): void {
  const route: Route = parseRoute()
  const id = FACTORIES[route.id] ? route.id : 'inicio'
  const host = $('views')

  let view = views.get(id)
  if (!view) {
    view = (FACTORIES[id] as () => View)()
    view.el.classList.add('view', 'animate-view-in')
    view.el.hidden = true
    view.el.dataset.view = id
    host.appendChild(view.el)
    views.set(id, view)
  }

  if (activeId && activeId !== id) {
    const previous = views.get(activeId)
    if (previous) {
      previous.el.hidden = true
      previous.hide?.()
    }
  }
  const switched = activeId !== id
  activeId = id
  view.el.hidden = false
  document.title = `${TITLES[id] ?? 'Início'} · Dinheirama`
  highlightNav(id)
  view.show(route)

  if (!firstRender) {
    if (switched) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    // leitores de tela anunciam a nova tela; o foco não rola a página
    view.el.querySelector<HTMLElement>('.view-title')?.focus({ preventScroll: true })
  }
  firstRender = false
}

// ---- Barra superior, tema, rede e atalhos ---------------------------------------

function paintThemeButton(): void {
  const dark = theme.current() === 'dark'
  const button = $('theme-toggle')
  const name: IconName = dark ? 'sun' : 'moon'
  button.replaceChildren(icon(name, 20))
  const label = dark ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'
  button.setAttribute('aria-label', label)
  button.title = label
}

function setupChrome(): void {
  $('search-trigger-icon').replaceChildren(icon('search', 18))
  $('disclaimer-icon').replaceChildren(icon('alert', 16))
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  $('search-kbd').textContent = mac ? '⌘ K' : 'Ctrl K'

  const palette = createPalette()
  $('open-palette').addEventListener('click', () => palette.open())
  document.addEventListener('keydown', event => {
    const target = event.target as HTMLElement | null
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable === true
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      palette.open()
    } else if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      palette.open()
    }
  })

  paintThemeButton()
  theme.subscribe(paintThemeButton)
  $('theme-toggle').addEventListener('click', () => theme.toggle())

  const net = $('net-status')
  const paintNet = (): void => {
    net.hidden = navigator.onLine
    net.replaceChildren(icon('alert', 14), 'Offline')
  }
  paintNet()
  window.addEventListener('online', () => {
    paintNet()
    toast('Conexão restaurada', 'success', 2500)
  })
  window.addEventListener('offline', () => {
    paintNet()
    toast('Você está offline. Algumas funções podem não funcionar.', 'error')
  })
}

buildNavigation()
setupChrome()
window.addEventListener('hashchange', renderRoute)
renderRoute()
