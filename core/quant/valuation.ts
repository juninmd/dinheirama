// Valuation simples e transparente (Damodaran, Graham): premissas explícitas, cenários e sensibilidade.
// Fluxo de caixa livre aproximado como FCFE (caixa operacional - capex) descontado ao custo do capital próprio.
// Bancos/seguradoras: FCF não se aplica; usa-se desconto de dividendos (Gordon).

import type { Fundamentals } from './fundamentals.ts'

export interface DcfAssumptions {
  /** Taxa livre de risco nominal em BRL (juro longo). */
  riskFree: number
  equityRiskPremium: number
  beta: number
  /** Crescimento anual do FCF nos primeiros anos; decai linearmente até o crescimento terminal. */
  initialGrowth: number
  terminalGrowth: number
  years: number
}

export const DEFAULT_RISK_FREE = Number(process.env.DCF_RISK_FREE ?? 0.115)
export const DEFAULT_ERP = Number(process.env.DCF_EQUITY_RISK_PREMIUM ?? 0.055)
export const MAX_TERMINAL_GROWTH = 0.045

export function costOfEquity(a: Pick<DcfAssumptions, 'riskFree' | 'equityRiskPremium' | 'beta'>): number {
  return a.riskFree + a.beta * a.equityRiskPremium
}

/** Valor presente de FCF com crescimento em decaimento linear + perpetuidade de Gordon. */
export function dcfEquityValue(fcf0: number, a: DcfAssumptions): number | null {
  const ke = costOfEquity(a)
  const g = Math.min(a.terminalGrowth, MAX_TERMINAL_GROWTH)
  if (!(fcf0 > 0) || ke <= g + 0.005) return null
  let fcf = fcf0
  let pv = 0
  for (let year = 1; year <= a.years; year++) {
    const growth = a.initialGrowth + ((g - a.initialGrowth) * (year - 1)) / Math.max(1, a.years - 1)
    fcf *= 1 + growth
    pv += fcf / (1 + ke) ** year
  }
  const terminal = (fcf * (1 + g)) / (ke - g)
  return pv + terminal / (1 + ke) ** a.years
}

/** Gordon para financeiras: DPS × (1 + g) / (ke − g). */
export function ddmValue(dps: number, ke: number, g: number): number | null {
  const growth = Math.min(g, MAX_TERMINAL_GROWTH)
  if (!(dps > 0) || ke <= growth + 0.005) return null
  return (dps * (1 + growth)) / (ke - growth)
}

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
  assumptions: DcfAssumptions & { costOfEquity: number }
  baseFcf: number | null
  valuePerShare: number | null
  marginOfSafety: number | null
  scenarios: ValuationScenario[]
  /** Linhas = crescimento inicial, colunas = custo do capital. */
  sensitivity: { growths: number[]; costsOfEquity: number[]; values: Array<Array<number | null>> }
  warnings: string[]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function normalizedFcf(f: Fundamentals): { fcf: number | null; note?: string } {
  const history = f.statements
    .slice(0, 3)
    .map(s => (s.operatingCashFlow !== null && s.capex !== null ? s.operatingCashFlow - s.capex : null))
    .filter((v): v is number => v !== null)
  if (f.freeCashFlow !== null && f.freeCashFlow > 0) {
    // média com histórico quando houver, para suavizar picos de capital de giro
    if (history.length >= 2 && history.every(v => v > 0)) {
      const avg = (f.freeCashFlow + history.reduce((a, b) => a + b, 0)) / (history.length + 1)
      return { fcf: avg, note: 'FCF normalizado pela média do último ano e do histórico.' }
    }
    return { fcf: f.freeCashFlow }
  }
  if (history.length >= 2) {
    const avg = history.reduce((a, b) => a + b, 0) / history.length
    if (avg > 0) return { fcf: avg, note: 'FCF atual não positivo; usada média histórica.' }
  }
  return { fcf: null }
}

export function valueAsset(f: Fundamentals, overrides: Partial<DcfAssumptions> = {}): ValuationResult {
  const warnings: string[] = []
  const beta = clamp(overrides.beta ?? f.beta ?? 1, 0.5, 1.8)
  const growthSeed = f.revenueGrowth ?? f.earningsGrowth ?? 0.05
  const assumptions: DcfAssumptions = {
    riskFree: overrides.riskFree ?? DEFAULT_RISK_FREE,
    equityRiskPremium: overrides.equityRiskPremium ?? DEFAULT_ERP,
    beta,
    initialGrowth: overrides.initialGrowth ?? clamp(growthSeed, -0.02, 0.12),
    terminalGrowth: Math.min(overrides.terminalGrowth ?? 0.04, MAX_TERMINAL_GROWTH),
    years: overrides.years ?? 10,
  }
  const ke = costOfEquity(assumptions)
  const shares = f.marketCap && f.price ? f.marketCap / f.price : null
  const price = f.price

  const empty = (reason: string): ValuationResult => ({
    ticker: f.ticker,
    method: 'indisponivel',
    price,
    assumptions: { ...assumptions, costOfEquity: ke },
    baseFcf: null,
    valuePerShare: null,
    marginOfSafety: null,
    scenarios: [],
    sensitivity: { growths: [], costsOfEquity: [], values: [] },
    warnings: [...warnings, reason],
  })

  let valueFn: (growth: number, cost: number) => number | null
  let method: ValuationResult['method']
  let baseFcf: number | null = null

  if (f.isFinancial) {
    const dps = f.dividendYield !== null && price ? f.dividendYield * price : null
    if (dps === null || dps <= 0) return empty('Financeira sem dividendos para o modelo de desconto de dividendos.')
    method = 'ddm'
    warnings.push('Instituição financeira: DCF de FCF não se aplica; usado desconto de dividendos (Gordon).')
    valueFn = (growth, cost) => ddmValue(dps, cost, Math.min(growth, assumptions.terminalGrowth))
  } else {
    const { fcf, note } = normalizedFcf(f)
    if (fcf === null || !shares) return empty('Fluxo de caixa livre não positivo ou ações em circulação indisponíveis: DCF não aplicável.')
    if (note) warnings.push(note)
    method = 'dcf-fcfe'
    baseFcf = fcf
    valueFn = (growth, cost) => {
      const value = dcfEquityValue(fcf, { ...assumptions, initialGrowth: growth, riskFree: cost - assumptions.beta * assumptions.equityRiskPremium })
      return value === null ? null : value / shares
    }
  }

  const mos = (value: number | null) => (value !== null && price && value > 0 ? (value - price) / value : null)
  const baseGrowth = assumptions.initialGrowth
  const mk = (label: ValuationScenario['label'], growth: number, cost: number): ValuationScenario => {
    const v = valueFn(growth, cost)
    return { label, initialGrowth: growth, costOfEquity: cost, valuePerShare: v, marginOfSafety: mos(v) }
  }
  const scenarios = [
    mk('pessimista', clamp(baseGrowth - 0.04, -0.05, 0.12), ke + 0.01),
    mk('base', baseGrowth, ke),
    mk('otimista', clamp(baseGrowth + 0.03, -0.05, 0.15), ke - 0.005),
  ]

  const growths = [-0.02, 0, 0.03, 0.06, 0.09, 0.12]
  const costs = [ke - 0.02, ke - 0.01, ke, ke + 0.01, ke + 0.02]
  const values = growths.map(g => costs.map(c => {
    const v = valueFn(g, c)
    return v === null ? null : Math.round(v * 100) / 100
  }))

  if (beta !== (f.beta ?? 1)) warnings.push('Beta limitado ao intervalo 0,5–1,8.')
  warnings.push('Valuation é muito sensível às premissas; use o intervalo de cenários, não um número único.')

  const base = scenarios[1] as ValuationScenario
  return {
    ticker: f.ticker,
    method,
    price,
    assumptions: { ...assumptions, costOfEquity: ke },
    baseFcf,
    valuePerShare: base.valuePerShare,
    marginOfSafety: base.marginOfSafety,
    scenarios,
    sensitivity: { growths, costsOfEquity: costs, values },
    warnings,
  }
}
