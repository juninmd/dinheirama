// Investment Policy Statement (IPS): perfil do investidor -> restrições da carteira e checagem de aderência.
// Ideia central de Graham/Bogle/Marks: o risco certo é o que o investidor consegue suportar,
// e só se investe em ações o dinheiro que não será necessário no curto prazo.

import { z } from 'zod'
import type { ConstructionMethod, ConstructionResult } from './portfolio.ts'
import type { StressReport } from './stress.ts'

export const ipsSchema = z.object({
  objective: z.enum(['preservation', 'income', 'balanced', 'growth']),
  horizonYears: z.number().min(0.5).max(60),
  /** Queda máxima suportável da carteira (fração, ex.: 0.25 = 25%). */
  maxDrawdownTolerance: z.number().min(0.05).max(0.9),
  maxPositionWeight: z.number().min(0.03).max(0.5).default(0.15),
  maxSectorWeight: z.number().min(0.1).max(1).default(0.35),
  capital: z.number().positive(),
  emergencyFundMonths: z.number().min(0).max(120),
  hasHighInterestDebt: z.boolean().default(false),
  monthlyContribution: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
})

export type Ips = z.infer<typeof ipsSchema>

export type Suitability = 'adequado' | 'cautela' | 'inadequado'

export interface IpsConstraints {
  method: ConstructionMethod
  maxWeight: number
  maxSector: number
  /** Fração máxima do patrimônio em ações (o resto em CDI/renda fixa). */
  maxEquityShare: number
  suitability: Suitability
  warnings: string[]
  rationale: string[]
}

const OBJECTIVE_RULES: Record<Ips['objective'], { method: ConstructionMethod; equityCap: number; why: string }> = {
  preservation: { method: 'minvar', equityCap: 0.3, why: 'Preservação: mínima variância e pouca renda variável.' },
  income: { method: 'erc', equityCap: 0.5, why: 'Renda: risco igualmente distribuído (risk parity) para evitar concentração em poucos pagadores.' },
  balanced: { method: 'hrp', equityCap: 0.7, why: 'Equilíbrio: HRP diversifica por clusters de correlação sem inverter a covariância.' },
  growth: { method: 'hrp', equityCap: 0.9, why: 'Crescimento: HRP com teto de posição maior; longo horizonte permite maior volatilidade.' },
}

/** Pior perda histórica plausível de uma carteira de ações da B3 quando não há replay disponível. */
export const DEFAULT_EQUITY_STRESS_LOSS = 0.5

/** Deriva restrições da carteira a partir do IPS. `worstLoss` = pior perda de cenário (fração positiva). */
export function deriveConstraints(ips: Ips, worstLoss: number | null = null): IpsConstraints {
  const rule = OBJECTIVE_RULES[ips.objective]
  const warnings: string[] = []
  const rationale = [rule.why]

  let suitability = 'adequado' as Suitability
  const downgrade = (level: Suitability, message: string) => {
    warnings.push(message)
    if (level === 'inadequado' || suitability === 'adequado') suitability = level
  }

  if (ips.hasHighInterestDebt) downgrade('inadequado', 'Há dívida cara (ex.: cartão/cheque especial): quitar costuma render mais, sem risco, do que qualquer ação.')
  if (ips.emergencyFundMonths < 6) downgrade('inadequado', 'Reserva de emergência abaixo de 6 meses: monte-a em renda fixa líquida antes de assumir risco em ações.')
  if (ips.horizonYears < 3) downgrade('inadequado', 'Horizonte menor que 3 anos: ações podem passar anos em queda; prefira renda fixa para esse prazo.')
  else if (ips.horizonYears < 5) downgrade('cautela', 'Horizonte de 3 a 5 anos: reduza a exposição a ações.')

  const stressLoss = Math.max(0.1, worstLoss ?? DEFAULT_EQUITY_STRESS_LOSS)
  const fromDrawdown = ips.maxDrawdownTolerance / stressLoss
  rationale.push(`Tolerância de queda ${(ips.maxDrawdownTolerance * 100).toFixed(0)}% ÷ pior cenário ${(stressLoss * 100).toFixed(0)}% limita ações a ${(Math.min(1, fromDrawdown) * 100).toFixed(0)}% do patrimônio.`)

  let maxEquityShare = Math.min(rule.equityCap, fromDrawdown, 1)
  if (suitability === 'inadequado') maxEquityShare = Math.min(maxEquityShare, 0.1)
  else if (suitability === 'cautela') maxEquityShare = Math.min(maxEquityShare, 0.4)

  return {
    method: rule.method,
    maxWeight: ips.maxPositionWeight,
    maxSector: ips.maxSectorWeight,
    maxEquityShare: Math.round(maxEquityShare * 1000) / 1000,
    suitability,
    warnings,
    rationale,
  }
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
  /** Pesos finais considerando a fração em ações (restante em CDI). */
  equityShare: number
}

/** Confere a carteira construída contra o IPS (concentração, setor, perda em estresse). */
export function checkCompliance(
  ips: Ips,
  construction: ConstructionResult,
  sectors: Record<string, string>,
  stress: StressReport | null
): IpsCompliance {
  const worst = stress?.worstScenarioLoss !== null && stress?.worstScenarioLoss !== undefined ? Math.abs(Math.min(0, stress.worstScenarioLoss)) : null
  const constraints = deriveConstraints(ips, worst)
  const equityShare = constraints.maxEquityShare

  const bySector = new Map<string, number>()
  for (const w of construction.weights) {
    const s = sectors[w.ticker] ?? 'outros'
    bySector.set(s, (bySector.get(s) ?? 0) + w.weight)
  }
  const topSector = Math.max(0, ...bySector.values())
  const maxPos = Math.max(0, ...construction.weights.map(w => w.weight))

  const checks: IpsCheck[] = [
    { id: 'position', label: 'Maior posição ≤ limite do IPS', ok: maxPos <= ips.maxPositionWeight + 1e-6, value: maxPos, limit: ips.maxPositionWeight },
    { id: 'sector', label: 'Maior setor ≤ limite do IPS', ok: topSector <= ips.maxSectorWeight + 1e-6, value: topSector, limit: ips.maxSectorWeight },
    {
      id: 'stress',
      label: 'Perda no pior cenário histórico (já considerando a fração em ações) ≤ tolerância',
      ok: worst === null ? true : worst * equityShare <= ips.maxDrawdownTolerance + 1e-6,
      value: worst === null ? null : worst * equityShare,
      limit: ips.maxDrawdownTolerance,
    },
    { id: 'suitability', label: 'Perfil adequado a renda variável', ok: constraints.suitability !== 'inadequado', value: null, limit: 0 },
  ]
  return { compliant: checks.every(c => c.ok), checks, constraints, equityShare }
}
