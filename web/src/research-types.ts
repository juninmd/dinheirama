// Tipos das respostas da camada quantitativa (core/quant/*).
// Campos numéricos podem chegar como null (JSON não representa NaN/Infinity): os formatadores tratam isso.

export interface TabContext {
  goToTab(id: string): void
}

export interface TabModule {
  mount(panel: HTMLElement): void
  /** Chamado toda vez que a sub-aba fica visível (carregamento preguiçoso). */
  onShow?(): void
}

// ---- Fatores ---------------------------------------------------------------

export interface FactorGroups {
  value: number | null
  quality: number | null
  momentum: number | null
  lowVol: number | null
}

export interface GrahamCriterion {
  name: string
  passed: boolean | null
  detail: string
}

export interface GrahamResult {
  passed: number
  evaluated: number
  total: number
  criteria: GrahamCriterion[]
}

export interface PiotroskiResult {
  score: number
  available: number
  scaled: number
  details: Array<{ name: string; passed: boolean | null }>
}

export interface FactorRow {
  ticker: string
  name: string
  sector: string
  price: number | null
  composite: number | null
  score: number | null
  groups: FactorGroups
  coverage: number
  trendOk: boolean | null
  grahamMarginOfSafety: number | null
  magicFormulaRank: number | null
  metrics: {
    momentum12_1: number | null
    vol: number | null
    drawdown: number | null
    earningsYield: number | null
    bookToPrice: number | null
    fcfYield: number | null
    dividendYield: number | null
    roe: number | null
    roic: number | null
    netDebtToEbitda: number | null
    piotroski: number | null
  }
  graham: GrahamResult | null
  piotroskiDetail: PiotroskiResult | null
  hasFundamentals: boolean
}

export interface FactorTable {
  generatedAt: string
  asOf: string
  weights: FactorGroups
  universeSize: number
  scored: number
  withFundamentals: number
  missingPrices: string[]
  rows: FactorRow[]
  notes: string[]
}

// ---- Valuation -------------------------------------------------------------

export interface ValuationScenario {
  label: 'pessimista' | 'base' | 'otimista'
  initialGrowth: number
  costOfEquity: number
  valuePerShare: number | null
  marginOfSafety: number | null
}

export interface ValuationResult {
  ticker: string
  method: 'dcf-fcfe' | 'ddm' | 'indisponivel'
  price: number | null
  assumptions: {
    riskFree: number
    equityRiskPremium: number
    beta: number
    initialGrowth: number
    terminalGrowth: number
    years: number
    costOfEquity: number
  }
  baseFcf: number | null
  valuePerShare: number | null
  marginOfSafety: number | null
  scenarios: ValuationScenario[]
  sensitivity: { growths: number[]; costsOfEquity: number[]; values: Array<Array<number | null>> }
  warnings: string[]
  generatedAt?: string
}

// ---- Backtest --------------------------------------------------------------

export interface PerformanceMetrics {
  days: number
  totalReturn: number
  cagr: number
  annVol: number
  sharpe: number
  sortino: number
  maxDrawdown: number
  calmar: number
  skew: number
  excessKurtosis: number
  var95Daily: number
  cvar95Daily: number
  hitRateMonthly: number | null
  psr: number
}

export interface BenchmarkRelative {
  alphaAnnual: number
  beta: number
  r2: number
  trackingError: number
  informationRatio: number
  excessCagr: number
}

export interface EquityPoint {
  date: string
  strategy: number
  cdi: number
  benchmark?: number
}

export interface BacktestResult {
  strategy: string
  label: string
  startDate: string
  endDate: string
  years: number
  net: PerformanceMetrics
  gross: PerformanceMetrics
  cash: PerformanceMetrics
  benchmark?: PerformanceMetrics & { name: string }
  relative?: BenchmarkRelative
  turnoverAnnual: number
  totalCosts: number
  totalTax: number
  trades: number
  rebalances: number
  delistings?: number
  avgPositions: number
  deflatedSharpe?: number
  equityCurve: EquityPoint[]
  caveats: string[]
}

export interface BacktestRobustness {
  folds: number
  chosen: string[]
  oosSharpe: number
  meanTrialOosSharpe: number
  probabilityOfOverfit: number
  variants: string[]
  trainDays: number
  testDays: number
}

export interface PboResult {
  partitions: number
  combinations: number
  variants: number
  pbo: number
  medianLogit: number
  probOosLoss: number
  meanIsSharpe: number
  meanOosSharpe: number
  selectionShare: Record<string, number>
}

export interface BacktestReport {
  generatedAt: string
  params: { years: number; topN: number; costs: boolean; tax: boolean; initialCapital: number }
  benchmark: string | null
  cdiSource: 'bcb' | 'constant'
  assets: number
  missing: string[]
  results: BacktestResult[]
  robustness: BacktestRobustness | null
  pbo?: PboResult | null
  universeHistory?: boolean
  pointInTimeFundamentals?: boolean
  trialsCounted: number
  caveats: string[]
}

// ---- Carteira robusta ------------------------------------------------------

export type ConstructionMethod = 'hrp' | 'erc' | 'ivol' | 'minvar' | 'meanvar' | 'bl'

export interface IpsConstraints {
  method: ConstructionMethod
  maxWeight: number
  maxSector: number
  maxEquityShare: number
  suitability: 'adequado' | 'cautela' | 'inadequado'
  warnings: string[]
  rationale: string[]
}

export interface IpsCheck {
  id: string
  label: string
  ok: boolean
  value: number | null
  limit: number
}

export interface IpsCompliance {
  compliant: boolean
  checks: IpsCheck[]
  constraints: IpsConstraints
  equityShare: number
}

export interface TailDiagnostics {
  observations: number
  skew: number
  excessKurtosis: number
  historicalVar95: number
  historicalCvar95: number
  historicalVar99: number
  historicalCvar99: number
  normalVar95: number
  normalVar99: number
  cornishFisherVar99: number
  normalUnderestimation99: number
  worstDay: number
  worstWeek: number
}

export interface ScenarioResult {
  id: string
  name: string
  from: string
  to: string
  coverage: number
  portfolioReturn: number | null
  maxDrawdown: number | null
  benchmarkReturn: number | null
  worstAsset: { ticker: string; ret: number } | null
  missing: string[]
}

export interface ShockResult {
  marketShock: number
  portfolioReturn: number
  assumedBeta1: string[]
}

export interface StressReport {
  tail: TailDiagnostics
  scenarios: ScenarioResult[]
  shocks: ShockResult[]
  correlationInCrisis: { normal: number | null; stressed: number | null } | null
  worstScenarioLoss: number | null
}

export interface ConstructionReport {
  generatedAt: string
  params: { method: ConstructionMethod; maxWeight: number; maxSector: number; lookbackDays: number; includeStress: boolean }
  asOf: string
  excluded: string[]
  construction: {
    method: ConstructionMethod
    weights: Array<{ ticker: string; weight: number; riskContribution: number }>
    diagnostics: {
      observations: number
      assets: number
      covarianceShrinkage: number
      expectedReturnShrinkage: number
      annualVol: number
      effectiveN: number
      herfindahl: number
      maxWeight: number
      diversificationRatio: number
      capsRelaxed?: boolean
      effectiveMaxWeight?: number
      effectiveMaxSector?: number
    }
    blackLitterman?: {
      tau: number
      riskAversion: number
      ic: number
      confidence: number
      views: number
      marketWeightsSource: 'capitalizacao' | 'igual'
      assets: Array<{ ticker: string; equilibriumAnnual: number; posteriorAnnual: number }>
    }
  }
  sectors: Array<{ sector: string; weight: number }>
  stress: StressReport | null
  ips: IpsCompliance | null
  notes: string[]
}

// ---- IPS -------------------------------------------------------------------

export type IpsObjective = 'preservation' | 'income' | 'balanced' | 'growth'

export interface Ips {
  objective: IpsObjective
  horizonYears: number
  maxDrawdownTolerance: number
  maxPositionWeight: number
  maxSectorWeight: number
  capital: number
  emergencyFundMonths: number
  hasHighInterestDebt: boolean
  monthlyContribution?: number
  notes?: string
}

export interface IpsResponse {
  ips: Ips | null
  constraints: IpsConstraints | null
}

// ---- Diário ----------------------------------------------------------------

export interface JournalEntry {
  id: string
  ticker: string
  action: 'buy' | 'hold' | 'sell'
  probability: number
  horizonDays: number
  entryPrice: number
  source?: 'score' | 'manual' | 'llm'
  thesis?: string
  createdAt: string
  dueAt: string
  status: 'open' | 'resolved'
  resolvedAt?: string
  exitPrice?: number
  returnPct?: number
  referenceReturnPct?: number
  outcome?: 0 | 1
}

export interface ReliabilityBin {
  from: number
  to: number
  count: number
  meanForecast: number | null
  observedFrequency: number | null
}

export interface CalibrationReport {
  resolved: number
  open: number
  brier: number | null
  brierBaseline: number | null
  brierSkill: number | null
  logLoss: number | null
  baseRate: number | null
  directionalHitRate: number | null
  avgExcessReturnPctBuy: number | null
  avgExcessReturnPctSell: number | null
  bins: ReliabilityBin[]
  warnings: string[]
}

export interface JournalResponse {
  entries: JournalEntry[]
  calibration: CalibrationReport
}
