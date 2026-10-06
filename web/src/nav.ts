import type { IconName } from './ui/icons'

export interface NavItem {
  id: string
  label: string
  icon: IconName
  description: string
  group: 'Descobrir' | 'Aprofundar' | 'Praticar'
  keywords: string
}

export const NAV: NavItem[] = [
  { id: 'inicio', label: 'Início', icon: 'home', description: 'Visão geral, watchlist e atalhos', group: 'Descobrir', keywords: 'home painel dashboard' },
  { id: 'analisar', label: 'Analisar ativo', icon: 'search', description: 'Score, RSI, notícias e decisão da IA para um ticker', group: 'Descobrir', keywords: 'ação ticker cotação rsi score' },
  { id: 'radar', label: 'Radar B3', icon: 'radar', description: 'Ranking das ações monitoradas com sinal e risco', group: 'Descobrir', keywords: 'portfólio portfolio carteira ranking' },
  { id: 'simulacao', label: 'Monte Carlo', icon: 'dice', description: 'Simule milhares de cenários e carteiras ótimas', group: 'Aprofundar', keywords: 'simulação risco sharpe var cvar' },
  { id: 'quant', label: 'Pesquisa quant', icon: 'flask', description: 'Fatores, backtest, carteira robusta, IPS e diário', group: 'Aprofundar', keywords: 'fatores backtest ips diário carteira robusta valuation' },
  { id: 'noticias', label: 'Notícias & papers', icon: 'news', description: 'Notícias e artigos científicos com impacto no ativo', group: 'Aprofundar', keywords: 'papers pesquisa fast news' },
  { id: 'treino', label: 'Treino de decisão', icon: 'cap', description: 'Pratique decisões em cenários reais do mercado', group: 'Praticar', keywords: 'quiz exercício aprender' },
  { id: 'alertas', label: 'Alertas & Telegram', icon: 'bell', description: 'Avisos de preço, RSI e sinal enviados ao Telegram', group: 'Praticar', keywords: 'telegram notificação aviso' },
]

export const GROUPS: NavItem['group'][] = ['Descobrir', 'Aprofundar', 'Praticar']

/** Itens fixos da barra inferior no celular; o restante fica em "Mais". */
export const MOBILE_PRIMARY = ['inicio', 'analisar', 'radar', 'quant']

export const TITLES: Record<string, string> = Object.fromEntries(NAV.map(item => [item.id, item.label]))
