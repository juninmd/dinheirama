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

// ---- Black-Litterman -------------------------------------------------------

/** Inversa por Gauss-Jordan com pivoteamento parcial; null se singular. */
export function invertMatrix(m: Matrix): Matrix | null {
  const n = m.length
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs((a[r] as number[])[col] as number) > Math.abs((a[pivot] as number[])[col] as number)) pivot = r
    if (Math.abs((a[pivot] as number[])[col] as number) < 1e-14) return null
    ;[a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]]
    const p = (a[col] as number[])[col] as number
    a[col] = (a[col] as number[]).map(v => v / p)
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = (a[r] as number[])[col] as number
      if (f === 0) continue
      a[r] = (a[r] as number[]).map((v, c) => v - f * ((a[col] as number[])[c] as number))
    }
  }
  return a.map(row => row.slice(n))
}

function matMul(a: Matrix, b: Matrix): Matrix {
  const n = a.length
  const k = b.length
  const m = (b[0] as number[]).length
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      let s = 0
      for (let x = 0; x < k; x++) s += ((a[i] as number[])[x] as number) * ((b[x] as number[])[j] as number)
      return s
    })
  )
}

const transpose = (a: Matrix): Matrix => (a.length === 0 ? [] : (a[0] as number[]).map((_, j) => a.map(row => row[j] as number)))

/** Retornos de equilíbrio implícitos (otimização reversa): π = λ Σ w_mercado. */
export function impliedEquilibriumReturns(cov: Matrix, marketWeights: number[], riskAversion: number): number[] {
  return cov.map(row => riskAversion * row.reduce((a, c, j) => a + c * (marketWeights[j] as number), 0))
}

export interface BlView {
  /** Linha da matriz P: pesos dos ativos que compõem a visão (ex.: [0,1,0] = visão absoluta no ativo 1). */
  p: number[]
  /** Retorno esperado da visão (mesma unidade de π). */
  q: number
  /** Confiança de Idzorek (0..1): 1 = certeza (Ω→0), perto de 0 = visão quase ignorada. */
  confidence: number
}

export interface BlackLittermanResult {
  equilibrium: number[]
  posteriorMean: number[]
  posteriorCov: Matrix
}

/**
 * Posterior de Black-Litterman (He-Litterman): μ = π + τΣP'(PτΣP' + Ω)⁻¹(Q − Pπ);
 * Σ_post = Σ + τΣ − τΣP'(PτΣP' + Ω)⁻¹PτΣ. Ω_kk = (1/c_k − 1)·p_k τΣ p_k' (Idzorek).
 */
export function blackLittermanPosterior(
  cov: Matrix,
  marketWeights: number[],
  views: BlView[],
  tau = 0.05,
  riskAversion = 2.5
): BlackLittermanResult | null {
  const pi = impliedEquilibriumReturns(cov, marketWeights, riskAversion)
  if (views.length === 0) return { equilibrium: pi, posteriorMean: pi.slice(), posteriorCov: cov.map(r => r.map(v => v * (1 + tau))) }

  const tauSigma = cov.map(r => r.map(v => v * tau))
  const P = views.map(v => v.p)
  const Pt = transpose(P)
  const PtauSigma = matMul(P, tauSigma) // k × n
  const PtauSigmaPt = matMul(PtauSigma, Pt) // k × k
  const omega = views.map((v, k) => {
    const c = Math.min(0.99, Math.max(0.01, v.confidence))
    return Array.from({ length: views.length }, (_, j) => (j === k ? (1 / c - 1) * (PtauSigmaPt[k] as number[])[k]! : 0))
  })
  const inner = PtauSigmaPt.map((row, i) => row.map((v, j) => v + ((omega[i] as number[])[j] as number)))
  const innerInv = invertMatrix(inner)
  if (!innerInv) return null

  const diff = views.map((v, k) => v.q - P[k]!.reduce((a, pj, j) => a + pj * (pi[j] as number), 0))
  const gain = matMul(matMul(tauSigma, Pt), innerInv) // n × k
  const posteriorMean = pi.map((p, i) => p + diff.reduce((a, d, k) => a + ((gain[i] as number[])[k] as number) * d, 0))

  const correction = matMul(gain, PtauSigma) // n × n
  const posteriorCov = cov.map((row, i) => row.map((v, j) => v + ((tauSigma[i] as number[])[j] as number) - ((correction[i] as number[])[j] as number)))
  return { equilibrium: pi, posteriorMean, posteriorCov }
}

/**
 * Visões de fator (regra fundamental de Grinold-Kahn): alfa anual = IC × σ_anual × z.
 * IC pequeno (default 0,03) mantém as visões modestas; confiança baixa limita o desvio do equilíbrio.
 */
export function factorViews(
  composites: Array<number | null>,
  dailyVariances: number[],
  equilibrium: number[],
  options: { ic?: number; confidence?: number } = {}
): BlView[] {
  const ic = options.ic ?? 0.03
  const confidence = options.confidence ?? 0.25
  const n = composites.length
  const views: BlView[] = []
  composites.forEach((z, i) => {
    if (z === null || !Number.isFinite(z)) return
    const sigmaAnnual = Math.sqrt((dailyVariances[i] as number) * 252)
    const alphaDaily = (ic * sigmaAnnual * z) / 252
    views.push({ p: Array.from({ length: n }, (_, j) => (j === i ? 1 : 0)), q: (equilibrium[i] as number) + alphaDaily, confidence })
  })
  return views
}

// ---- Restrições e Kelly ----------------------------------------------------

export interface CapsResult {
  weights: number[]
  /** Tetos informados eram inviáveis (não há como somar 100%) e foram relaxados até o mínimo viável. */
  relaxed: boolean
  effectiveMaxWeight: number
  effectiveMaxSector: number
}

/** Capacidade máxima de alocação (soma 1 exige capacidade >= 1) dados os tetos por ativo e por setor. */
function capacity(sectors: string[], maxWeight: number, maxSector: number): number {
  const counts = new Map<string, number>()
  for (const s of sectors) counts.set(s, (counts.get(s) ?? 0) + 1)
  let total = 0
  for (const k of counts.values()) total += Math.min(maxSector, k * maxWeight)
  return total
}

/**
 * Aplica teto por ativo e por setor redistribuindo o excesso para quem tem folga (proporcional).
 * Se os tetos forem inviáveis (ex.: 29 ativos com teto de 3% somam só 87%), eles são relaxados — proporcionalmente,
 * até a capacidade chegar a 100% — e o resultado indica `relaxed`, sempre com pesos somando 1.
 */
export function applyCapsDetailed(
  weights: number[],
  sectors: string[],
  caps: { maxWeight: number; maxSector: number }
): CapsResult {
  const n = weights.length
  let feasibleAsset = Math.max(caps.maxWeight, 1 / n)
  let feasibleSector = Math.max(caps.maxSector, 1 / new Set(sectors).size)
  let relaxed = feasibleAsset > caps.maxWeight + 1e-12 || feasibleSector > caps.maxSector + 1e-12
  // relaxa em passos pequenos até haver capacidade para somar 100%
  for (let guard = 0; guard < 400 && capacity(sectors, feasibleAsset, feasibleSector) < 1 - 1e-9; guard++) {
    feasibleAsset *= 1.02
    feasibleSector *= 1.02
    relaxed = true
  }
  feasibleAsset = Math.min(1, feasibleAsset)
  feasibleSector = Math.min(1, feasibleSector)

  let w = normalize(weights)
  for (let it = 0; it < 300; it++) {
    let changed = false
    let excess = 0
    w = w.map(x => {
      if (x > feasibleAsset + 1e-12) {
        excess += x - feasibleAsset
        changed = true
        return feasibleAsset
      }
      return x
    })
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
  // resíduo numérico: garante soma 1 sem violar os tetos efetivos
  const total = w.reduce((a, b) => a + b, 0)
  if (Math.abs(total - 1) > 1e-9) w = w.map(x => x / total)
  return { weights: w, relaxed, effectiveMaxWeight: feasibleAsset, effectiveMaxSector: feasibleSector }
}

/** Versão simples de applyCapsDetailed (só os pesos). */
export function applyCaps(weights: number[], sectors: string[], caps: { maxWeight: number; maxSector: number }): number[] {
  return applyCapsDetailed(weights, sectors, caps).weights
}

/** Kelly contínuo f* = (μ − r) / σ², fracionado (¼ por padrão) e limitado. */
export function fractionalKelly(excessReturn: number, variance: number, fraction = 0.25, cap = 0.2): number {
  if (variance <= 0 || excessReturn <= 0) return 0
  return Math.max(0, Math.min(cap, fraction * (excessReturn / variance)))
}

export type ConstructionMethod = 'hrp' | 'erc' | 'ivol' | 'minvar' | 'meanvar' | 'bl'

export interface ConstructionInput {
  tickers: string[]
  /** Retornos diários (T × N), alinhados e sem lacunas. */
  returns: number[][]
  sectors?: string[]
  method: ConstructionMethod
  maxWeight: number
  maxSector: number
  riskAversion?: number
  /** Black-Litterman: pesos de mercado (capitalização) e z-scores de fator por ativo. */
  marketWeights?: number[] | null
  factorScores?: Array<number | null>
  blIc?: number
  blConfidence?: number
  blTau?: number
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
    /** Os tetos pedidos eram inviáveis e foram relaxados (veja os tetos efetivos). */
    capsRelaxed: boolean
    effectiveMaxWeight: number
    effectiveMaxSector: number
  }
  blackLitterman?: {
    tau: number
    riskAversion: number
    ic: number
    confidence: number
    views: number
    marketWeightsSource: 'capitalizacao' | 'igual'
    /** Retorno anualizado de equilíbrio (implícito no mercado) e posterior (com as visões de fator), por ativo. */
    assets: Array<{ ticker: string; equilibriumAnnual: number; posteriorAnnual: number }>
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
  let blInfo: ConstructionResult['blackLitterman']
  switch (method) {
    case 'hrp': w = hierarchicalRiskParity(cov); break
    case 'erc': w = equalRiskContribution(cov); break
    case 'ivol': w = inverseVolatility(cov); break
    case 'minvar': w = minimumVariance(cov, input.maxWeight); break
    case 'meanvar': w = meanVarianceShrunk(mu.shrunk, cov, input.riskAversion ?? 6, input.maxWeight); break
    case 'bl': {
      const weightsSource = input.marketWeights && input.marketWeights.length === n && input.marketWeights.every(x => x >= 0) && input.marketWeights.some(x => x > 0)
      const market = weightsSource ? normalize(input.marketWeights as number[]) : Array.from({ length: n }, () => 1 / n)
      const lambda = input.riskAversion ?? 2.5
      const tau = input.blTau ?? 0.05
      const pi = impliedEquilibriumReturns(cov, market, lambda)
      const views = factorViews(input.factorScores ?? tickers.map(() => null), variances, pi, { ic: input.blIc, confidence: input.blConfidence })
      const posterior = blackLittermanPosterior(cov, market, views, tau, lambda)
      if (!posterior) return null
      w = meanVarianceShrunk(posterior.posteriorMean, posterior.posteriorCov, lambda, input.maxWeight)
      blInfo = {
        tau,
        riskAversion: lambda,
        ic: input.blIc ?? 0.03,
        confidence: input.blConfidence ?? 0.25,
        views: views.length,
        marketWeightsSource: weightsSource ? 'capitalizacao' : 'igual',
        assets: tickers.map((ticker, i) => ({
          ticker,
          equilibriumAnnual: round((posterior.equilibrium[i] as number) * 252, 4),
          posteriorAnnual: round((posterior.posteriorMean[i] as number) * 252, 4),
        })),
      }
      break
    }
  }
  const capped = applyCapsDetailed(w, input.sectors ?? tickers.map(t => t), { maxWeight: input.maxWeight, maxSector: input.maxSector })
  w = capped.weights

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
      capsRelaxed: capped.relaxed,
      effectiveMaxWeight: round(capped.effectiveMaxWeight, 4),
      effectiveMaxSector: round(capped.effectiveMaxSector, 4),
    },
    ...(blInfo ? { blackLitterman: blInfo } : {}),
  }
}
