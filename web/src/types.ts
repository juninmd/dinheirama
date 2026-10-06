// Contratos das respostas da API usadas pelo shell e pelas views (a camada quant tem os seus em research-types.ts).

export type Action = 'buy' | 'hold' | 'sell'
export type Risk = 'low' | 'medium' | 'high'
export type Sentiment = 'bullish' | 'bearish' | 'neutral'

export interface NewsImpact {
  label: Sentiment
  score: number
  summary: string
}

export interface SignalItem {
  source: string
  title: string
  url?: string
}

export interface AnalyzeResponse {
  ticker: string
  name: string
  assetClass: 'stock'
  quote: { price: number; change: number; volume?: number; currency?: string }
  rsi: number | null
  score: number
  action: Action
  risk: Risk
  newsImpact: NewsImpact
  signals: SignalItem[]
  rationale: string[]
  analysis: string
  aiSource: string
  timestamp: string
}

export interface RadarStock {
  ticker: string
  name: string
  assetClass: 'stock'
  price: number
  change: number
  historyChange: number
  rsi: number | null
  score: number
  action: Action
  risk: Risk
  newsImpact: NewsImpact
  signals: SignalItem[]
}

export interface PortfolioResponse {
  portfolio: RadarStock[]
  recommendation: string
  aiSource: string
  tickersAnalyzed: number
  timestamp: string
}

export interface McDistribution {
  meanPct: number
  medianPct: number
  stdPct: number
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }
  probProfit: number
  probGain10: number
  probLoss10: number
  var95Pct: number
  cvar95Pct: number
  sharpe: number
}

export interface McCandidate {
  label: string
  weights: Array<{ ticker: string; weight: number }>
  distribution: McDistribution
  maxDrawdownP50Pct: number
}

export interface MonteCarloResponse {
  engine: 'bootstrap' | 'gbm'
  days: number
  sims: number
  candidates: number
  samples: number
  assets: string[]
  best: { sharpe: McCandidate; aggressive: McCandidate; defensive: McCandidate }
  frontier: Array<{ riskPct: number; returnPct: number; sharpe: number }>
  perAsset: Array<{
    ticker: string
    lastPrice: number
    volatility: { annualized: number }
    distribution: McDistribution
    priceTargets: { p5: number; p50: number; p95: number }
    maxDrawdownP50Pct: number
    kellyFraction: number
    verdict: Action
  }>
  generatedAt: string
}

export interface TrainingDrill {
  id: string
  ticker: string
  prompt: string
  context: string[]
  expectedDecision: Action
  answer: string
}

export interface TrainingResponse {
  generatedAt: string
  drills: TrainingDrill[]
  source: { tickersAnalyzed: number; aiSource: string }
}

export interface ResearchItem {
  kind: 'fast-news' | 'news' | 'paper'
  source: string
  title: string
  url?: string
  impact: Sentiment
  publishedAt?: string
  summary?: string
}

export interface ResearchResponse {
  asset: string
  generatedAt: string
  impact: NewsImpact
  items: ResearchItem[]
  nextQuestions: string[]
}

export type AlertType = 'price' | 'rsi' | 'ml_signal'
export type AlertCondition = 'above' | 'below' | 'action_equals'

export interface Alert {
  id: string
  ticker: string
  type: AlertType
  condition: AlertCondition
  value: number | string
  status: 'active' | 'triggered' | 'disabled'
  createdAt: string
  lastTriggeredAt: string | null
  triggerCount: number
  lastCheckedValue: number | string | null
}

export interface AlertHistory {
  id: string
  alertId: string
  ticker: string
  type: AlertType
  condition: string
  targetValue: number | string
  triggeredValue: number | string
  triggeredAt: string
  message: string
}

export interface QuoteResponse {
  symbol?: string
  shortName?: string
  longName?: string
  regularMarketPrice: number
  regularMarketChangePercent?: number
  currency?: string
}

export interface HistoryBar {
  date: string
  close: number | null
  adjClose?: number | null
}

export interface IntegrationStatus {
  generatedAt: string
  integrations: {
    llm: { configured: boolean; host: string; model: string }
    fastNews: { configured: boolean; endpoint: string | null }
    marketNewsFeeds: { configured: boolean; count: number }
    paperFeeds: { configured: boolean; count: number; fallback: string | null }
    telegram: { configured: boolean; notifyUtcHour: number }
  }
  missingForFull24h: string[]
}
