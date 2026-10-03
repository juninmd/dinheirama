// Construção de carteira robusta a erro de estimação.
// - Covariância com encolhimento (Ledoit-Wolf 2004, alvo identidade escalada);
// - HRP (López de Prado 2016), ERC/risk parity (Maillard et al. 2010), inverso da volatilidade e mínima variância;
// - retornos esperados encolhidos (James-Stein/Bayes-Stein) em vez de médias amostrais ruidosas;
// - Kelly fracionado (Thorp) com teto de posição; limites por ativo e por setor.

import { correlationFromCovariance, covarianceMatrix, mean, round } from './stats.ts'

export type Matrix = number[][]

/** Ledoit-Wolf (2004) com alvo identidade escalada. `rows`: observações (T) × ativos (N). */
export function ledoitWolfCovariance(rows: number[][]): { cov: Matrix; shrinkage: number } {
  const t = rows.length
  const n = t > 0 ? (rows[0] as number[]).length : 0
  if (t < 2 || n === 0) return { cov: [], shrinkage: 0 }

  const sample = covarianceMatrix(rows)
  // usa estimador com divisor T (como no artigo) para a intensidade
  const scale = (t - 1) / t
  const S = sample.map(r => r.map(v => v * scale))
  const mu = S.reduce((a, r, i) => a + (r[i] as number), 0) / n

  const means = Array.from({ length: n }, (_, j) => mean(rows.map(r => r[j] as number)))
  let d2 = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const diff = (S[i] as number[])[j]! - (i === j ? mu : 0)
      d2 += diff * diff
    }
  }
  d2 /= n

  let b2bar = 0
  for (const row of rows) {
    let acc = 0
    for (let i = 0; i < n; i++) {
      const di = (row[i] as number) - (means[i] as number)
      for (let j = 0; j < n; j++) {
        const dj = (row[j] as number) - (means[j] as number)
        const diff = di * dj - (S[i] as number[])[j]!
        acc += diff * diff
      }
    }
    b2bar += acc / n
  }
  b2bar /= t * t
  const b2 = Math.min(b2bar, d2)
  const shrinkage = d2 === 0 ? 0 : b2 / d2

  const cov = S.map((r, i) =>
    r.map((v, j) => shrinkage * (i === j ? mu : 0) + (1 - shrinkage) * v)
  )
  return { cov, shrinkage }
}

/** Encolhe médias para a média global (James-Stein): intensidade ~ ruído / (ruído + dispersão). */
export function shrinkMeans(means: number[], variances: number[], observations: number): { shrunk: number[]; intensity: number } {
  const n = means.length
  if (n < 3 || observations < 2) return { shrunk: means.slice(), intensity: 0 }
  const grand = mean(means)
  const noise = mean(variances) / observations
  const dispersion = means.reduce((a, m) => a + (m - grand) ** 2, 0) / (n - 1)
  const intensity = dispersion + noise === 0 ? 0 : Math.min(1, Math.max(0, noise / (noise + dispersion)))
  return { shrunk: means.map(m => intensity * grand + (1 - intensity) * m), intensity }
}

export function portfolioVariance(w: number[], cov: Matrix): number {
  let v = 0
  for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) v += (w[i] as number) * (w[j] as number) * ((cov[i] as number[])[j] as number)
  return v
}

/** Contribuição percentual de cada ativo ao risco da carteira. */
export function riskContributions(w: number[], cov: Matrix): number[] {
  const total = portfolioVariance(w, cov)
  if (total <= 0) return w.map(() => 0)
  return w.map((wi, i) => {
    let marginal = 0
    for (let j = 0; j < w.length; j++) marginal += ((cov[i] as number[])[j] as number) * (w[j] as number)
    return (wi * marginal) / total
  })
}

export function normalize(w: number[]): number[] {
  const s = w.reduce((a, b) => a + Math.max(0, b), 0)
  return s === 0 ? w.map(() => 1 / w.length) : w.map(x => Math.max(0, x) / s)
}

/** Pesos ∝ 1/σ. */
export function inverseVolatility(cov: Matrix): number[] {
  return normalize(cov.map((r, i) => 1 / Math.sqrt(Math.max(1e-12, r[i] as number))))
}

/** Equal Risk Contribution por iteração de ponto fixo (convergência estável para long-only). */
export function equalRiskContribution(cov: Matrix, iterations = 500): number[] {
  const n = cov.length
  let w = inverseVolatility(cov)
  for (let it = 0; it < iterations; it++) {
    const rc = riskContributions(w, cov)
    const target = 1 / n
    const next = w.map((wi, i) => wi * Math.sqrt(target / Math.max(1e-12, rc[i] as number)))
    const normalized = normalize(next)
    const diff = normalized.reduce((a, v, i) => a + Math.abs(v - (w[i] as number)), 0)
    w = normalized
    if (diff < 1e-10) break
  }
  return w
}

/** Projeção no simplex com teto por ativo (soma 1, 0 <= w <= cap) por bisseção. */
export function projectCappedSimplex(v: number[], cap: number): number[] {
  const n = v.length
  const effectiveCap = Math.max(cap, 1 / n)
  let lo = Math.min(...v) - effectiveCap
  let hi = Math.max(...v)
  for (let it = 0; it < 80; it++) {
    const tau = (lo + hi) / 2
    const sum = v.reduce((a, x) => a + Math.min(effectiveCap, Math.max(0, x - tau)), 0)
    if (sum > 1) lo = tau
    else hi = tau
  }
  const tau = (lo + hi) / 2
  return v.map(x => Math.min(effectiveCap, Math.max(0, x - tau)))
}

/** Mínima variância long-only com teto por ativo (gradiente projetado). */
export function minimumVariance(cov: Matrix, maxWeight = 1, iterations = 2000): number[] {
  const n = cov.length
  let w = projectCappedSimplex(Array.from({ length: n }, () => 1 / n), maxWeight)
  const lipschitz = Math.max(1e-12, ...cov.map(r => r.reduce((a, b) => a + Math.abs(b), 0)))
  const step = 1 / (2 * lipschitz)
  for (let it = 0; it < iterations; it++) {
    const grad = w.map((_, i) => 2 * w.reduce((a, wj, j) => a + ((cov[i] as number[])[j] as number) * wj, 0))
    const next = projectCappedSimplex(w.map((wi, i) => wi - step * (grad[i] as number)), maxWeight)
    const diff = next.reduce((a, v, i) => a + Math.abs(v - (w[i] as number)), 0)
    w = next
    if (diff < 1e-12) break
  }
  return w
}

/**
 * Média-variância com retornos encolhidos e teto por ativo: maximiza μ'w − (λ/2) w'Σw.
 * `riskAversion` alto => próximo da mínima variância.
 */
export function meanVarianceShrunk(mu: number[], cov: Matrix, riskAversion = 6, maxWeight = 0.25, iterations = 3000): number[] {
  const n = cov.length
  let w = projectCappedSimplex(Array.from({ length: n }, () => 1 / n), maxWeight)
  const lipschitz = Math.max(1e-12, ...cov.map(r => r.reduce((a, b) => a + Math.abs(b), 0)))
  const step = 1 / (riskAversion * lipschitz + 1e-12)
  for (let it = 0; it < iterations; it++) {
    const grad = w.map((_, i) => (mu[i] as number) - riskAversion * w.reduce((a, wj, j) => a + ((cov[i] as number[])[j] as number) * wj, 0))
    const next = projectCappedSimplex(w.map((wi, i) => wi + step * (grad[i] as number)), maxWeight)
    const diff = next.reduce((a, v, i) => a + Math.abs(v - (w[i] as number)), 0)
    w = next
    if (diff < 1e-12) break
  }
  return w
}

// ---- Hierarchical Risk Parity ---------------------------------------------

interface Cluster {
  id: number
  members: number[]
}

/** Ordem quase-diagonal por clusterização hierárquica (ligação simples) na distância de correlação. */
export function hierarchicalOrder(corr: Matrix): number[] {
  const n = corr.length
  if (n <= 2) return Array.from({ length: n }, (_, i) => i)
  const dist = corr.map(r => r.map(c => Math.sqrt(Math.max(0, (1 - c) / 2))))

  let clusters: Cluster[] = Array.from({ length: n }, (_, i) => ({ id: i, members: [i] }))
  while (clusters.length > 1) {
    let best = { a: 0, b: 1, d: Infinity }
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let d = Infinity
        for (const i of (clusters[a] as Cluster).members) {
          for (const j of (clusters[b] as Cluster).members) d = Math.min(d, (dist[i] as number[])[j] as number)
        }
        if (d < best.d) best = { a, b, d }
      }
    }
    const merged: Cluster = {
      id: n + clusters.length,
      // concatenação preserva adjacência dos filhos => ordem quase-diagonal
      members: [...(clusters[best.a] as Cluster).members, ...(clusters[best.b] as Cluster).members],
    }
    clusters = clusters.filter((_, k) => k !== best.a && k !== best.b)
    clusters.push(merged)
  }
  return (clusters[0] as Cluster).members
}

function clusterVariance(cov: Matrix, items: number[]): number {
  const ivp = normalize(items.map(i => 1 / Math.max(1e-12, (cov[i] as number[])[i] as number)))
  let v = 0
  for (let a = 0; a < items.length; a++) {
    for (let b = 0; b < items.length; b++) {
      v += (ivp[a] as number) * (ivp[b] as number) * (((cov[items[a] as number] as number[])[items[b] as number]) as number)
    }
  }
  return v
}

/** Hierarchical Risk Parity: não inverte a covariância (estável com ativos muito correlacionados). */
export function hierarchicalRiskParity(cov: Matrix): number[] {
  const n = cov.length
  if (n === 0) return []
  if (n === 1) return [1]
  const order = hierarchicalOrder(correlationFromCovariance(cov))
  const weights = Array.from({ length: n }, () => 1)
  let groups: number[][] = [order]
  while (groups.length > 0) {
    const next: number[][] = []
    for (const group of groups) {
      if (group.length <= 1) continue
      const mid = Math.floor(group.length / 2)
      const left = group.slice(0, mid)
      const right = group.slice(mid)
      const vl = clusterVariance(cov, left)
      const vr = clusterVariance(cov, right)
      const alpha = vl + vr === 0 ? 0.5 : 1 - vl / (vl + vr)
      for (const i of left) weights[i] = (weights[i] as number) * alpha
      for (const i of right) weights[i] = (weights[i] as number) * (1 - alpha)
      next.push(left, right)
    }
    groups = next
  }
  return normalize(weights)
}

// ---- Restrições e Kelly ----------------------------------------------------

/** Aplica teto por ativo e por setor redistribuindo o excesso para quem tem folga (proporcional). */
export function applyCaps(
  weights: number[],
  sectors: string[],
  caps: { maxWeight: number; maxSector: number }
): number[] {
  const n = weights.length
  const feasibleAsset = Math.max(caps.maxWeight, 1 / n)
  const uniqueSectors = new Set(sectors).size
  const feasibleSector = Math.max(caps.maxSector, 1 / uniqueSectors)
  let w = normalize(weights)
  for (let it = 0; it < 200; it++) {
    let changed = false
    // teto por ativo
    let excess = 0
    w = w.map(x => {
      if (x > feasibleAsset + 1e-12) {
        excess += x - feasibleAsset
        changed = true
        return feasibleAsset
      }
      return x
    })
    // teto por setor
    const bySector = new Map<string, number>()
    sectors.forEach((s, i) => bySector.set(s, (bySector.get(s) ?? 0) + (w[i] as number)))
    for (const [sector, total] of bySector) {
      if (total > feasibleSector + 1e-12) {
        const factor = feasibleSector / total
        sectors.forEach((s, i) => {
          if (s === sector) {
            excess += (w[i] as number) * (1 - factor)
            w[i] = (w[i] as number) * factor
          }
        })
        changed = true
      }
    }
    if (excess > 1e-12) {
      // redistribui nos ativos com folga (ativo e setor)
      const sectorTotals = new Map<string, number>()
      sectors.forEach((s, i) => sectorTotals.set(s, (sectorTotals.get(s) ?? 0) + (w[i] as number)))
      const slack = w.map((x, i) => Math.max(0, Math.min(feasibleAsset - x, feasibleSector - (sectorTotals.get(sectors[i] as string) ?? 0))))
      const slackTotal = slack.reduce((a, b) => a + b, 0)
      if (slackTotal <= 1e-12) break
      const give = Math.min(excess, slackTotal)
      w = w.map((x, i) => x + (give * (slack[i] as number)) / slackTotal)
    }
    if (!changed) break
  }
  return w
}

/** Kelly contínuo f* = (μ − r) / σ², fracionado (¼ por padrão) e limitado. */
export function fractionalKelly(excessReturn: number, variance: number, fraction = 0.25, cap = 0.2): number {
  if (variance <= 0 || excessReturn <= 0) return 0
  return Math.max(0, Math.min(cap, fraction * (excessReturn / variance)))
}

export type ConstructionMethod = 'hrp' | 'erc' | 'ivol' | 'minvar' | 'meanvar'

export interface ConstructionInput {
  tickers: string[]
  /** Retornos diários (T × N), alinhados e sem lacunas. */
  returns: number[][]
  sectors?: string[]
  method: ConstructionMethod
  maxWeight: number
  maxSector: number
  riskAversion?: number
}

export interface ConstructionResult {
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
  }
}

export function constructPortfolio(input: ConstructionInput): ConstructionResult | null {
  const { tickers, returns, method } = input
  const n = tickers.length
  if (n < 2 || returns.length < Math.max(60, n + 5)) return null

  const { cov, shrinkage } = ledoitWolfCovariance(returns)
  const colMeans = Array.from({ length: n }, (_, j) => mean(returns.map(r => r[j] as number)))
  const variances = cov.map((r, i) => r[i] as number)
  const mu = shrinkMeans(colMeans, variances, returns.length)

  let w: number[]
  switch (method) {
    case 'hrp': w = hierarchicalRiskParity(cov); break
    case 'erc': w = equalRiskContribution(cov); break
    case 'ivol': w = inverseVolatility(cov); break
    case 'minvar': w = minimumVariance(cov, input.maxWeight); break
    case 'meanvar': w = meanVarianceShrunk(mu.shrunk, cov, input.riskAversion ?? 6, input.maxWeight); break
  }
  w = applyCaps(w, input.sectors ?? tickers.map(t => t), { maxWeight: input.maxWeight, maxSector: input.maxSector })

  const rc = riskContributions(w, cov)
  const variance = portfolioVariance(w, cov)
  const hhi = w.reduce((a, x) => a + x * x, 0)
  const weightedVol = w.reduce((a, x, i) => a + x * Math.sqrt(variances[i] as number), 0)

  return {
    method,
    weights: tickers
      .map((ticker, i) => ({ ticker, weight: round(w[i] as number, 4), riskContribution: round(rc[i] as number, 4) }))
      .filter(x => x.weight >= 0.001)
      .sort((a, b) => b.weight - a.weight),
    diagnostics: {
      observations: returns.length,
      assets: n,
      covarianceShrinkage: round(shrinkage, 4),
      expectedReturnShrinkage: round(mu.intensity, 4),
      annualVol: round(Math.sqrt(variance * 252), 4),
      effectiveN: round(hhi > 0 ? 1 / hhi : 0, 2),
      herfindahl: round(hhi, 4),
      maxWeight: round(Math.max(...w), 4),
      diversificationRatio: round(variance > 0 ? weightedVol / Math.sqrt(variance) : 1, 3),
    },
  }
}
