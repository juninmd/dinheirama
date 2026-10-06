import { h } from '../research-dom'
import { pathFor, type Route, type View } from '../router'
import { errorState, loadingPanel, skeleton, viewHeader } from '../ui/components'
import { icon } from '../ui/icons'
import type { ResearchHandle } from '../research'

// O módulo de pesquisa quantitativa (a maior parte do JS) só é baixado na primeira visita (ou ao passar o mouse no menu).
let loader: Promise<typeof import('../research')> | null = null
export function preloadQuant(): Promise<typeof import('../research')> {
  loader ??= import('../research').catch(error => {
    loader = null
    throw error
  })
  return loader
}

export function createQuantView(): View {
  const el = h('div', { class: 'view-stack' })
  const root = h('div', { class: 'quant-root card' })
  el.append(
    viewHeader({ title: 'Pesquisa quantitativa', subtitle: 'Fatores, backtest, carteira robusta, IPS e diário de decisões. Ferramentas para estudar e testar ideias, sempre com as limitações à vista.' }),
    h('div', { class: 'callout' }, icon('info', 18), h('p', null, 'Resultados de backtest são históricos e carregam vieses (sobrevivência, dados e custos). Eles ajudam a estudar uma ideia — não a prometer retorno.')),
    root
  )

  let handle: ResearchHandle | null = null
  let starting: Promise<void> | null = null

  function start(tab: string | undefined): Promise<void> {
    root.replaceChildren(loadingPanel('Carregando a pesquisa quantitativa…', skeleton(44), skeleton(200)))
    return preloadQuant()
      .then(({ initResearch, QUANT_TABS }) => {
        root.replaceChildren()
        handle = initResearch(root, {
          initial: tab && QUANT_TABS.includes(tab) ? tab : undefined,
          onSelect: id => {
            // reflete a aba na URL sem disparar o roteador (permite copiar o link da aba aberta)
            const target = pathFor('quant', [id])
            if (location.hash !== target) history.replaceState(null, '', target)
          },
        })
      })
      .catch(error => {
        root.replaceChildren(errorState(error, () => void start(tab)))
      })
      .finally(() => {
        starting = null
      })
  }

  return {
    el,
    show(route: Route) {
      const tab = route.segments[0]
      if (handle) {
        handle.show(tab)
        return
      }
      starting ??= start(tab)
    },
  }
}
