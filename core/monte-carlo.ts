// Monte Carlo para ações da B3.
// Simula caminhos de preço a partir do histórico e ranqueia alocações por
// distribuição de resultado (retorno, VaR/CVaR, prob. de lucro, Sharpe, Kelly).
// PRNG com semente fixa: mesma entrada => mesma saída (reprodutível e testável).
//
// Cuidado metodológico: o retorno médio amostral é uma estimativa muito ruidosa (Merton, 1980).
// A otimização de carteira encolhe as médias (James-Stein) para não "premiar" o acaso do passado, e o
// Kelly sugerido é fracionado (¼) e limitado, pois o Kelly pleno é extremamente sensível a erro de estimação.
import { fractionalKelly, shrinkMeans } from './quant/portfolio.ts'

export type McEngine = 'bootstrap' | 'gbm'

export interface AssetSeries {
  ticker: string
  closes: number[]
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

export interface McAssetResult {
  ticker: string
  engine: McEngine
  days: number
  sims: number
  samples: number
  lastPrice: number
  drift: { daily: number; annualized: number }
  volatility: { daily: number; annualized: number }
  distribution: McDistribution
  priceTargets: { p5: number; p50: number; p95: number }
  maxDrawdownP50Pct: number
  /** Kelly pleno (f* = μ/σ²), limitado a [0,1]. Apenas informativo: não use como tamanho de posição. */
  kellyFraction: number
  /** Kelly fracionado (¼) sobre o retorno em excesso ao CDI, limitado a 20% do patrimônio. */
  kellySuggested: number
  verdict: 'buy' | 'hold' | 'sell'
  confidence: number
}

export interface McAllocation {
  ticker: string
  weight: number
}

export interface McCandidate {
  label: string
  weights: McAllocation[]
  distribution: McDistribution
  maxDrawdownP50Pct: number
}

export interface McPortfolioResult {
  engine: McEngine
  days: number
  sims: number
  candidates: number
  seed: number
  samples: number
  /** Intensidade do encolhimento das médias de retorno (0 = sem encolhimento). */
  driftShrinkage: number
  assets: string[]
  best: {
    sharpe: McCandidate
    aggressive: McCandidate
    defensive: McCandidate
  }
  frontier: Array<{ riskPct: number; returnPct: number; sharpe: number }>
  perAsset: McAssetResult[]
}

export interface McConfig {
  days: number
  sims: number
  seed: number
  engine: McEngine
  /** Taxa livre de risco anual (ex.: 0.105 = Selic 10,5%). */
  riskFreeRate: number
}

export const DEFAULT_MC_CONFIG: McConfig = {
  days: 21,
  sims: 5000,
  seed: 20240101,
  engine: 'bootstrap',
  riskFreeRate: Number(process.env.MC_RISK_FREE_RATE ?? 0.105),
}

const TRADING_DAYS_YEAR = 252
const MIN_SAMPLES = 30

/** PRNG determinístico (mulberry32). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Normal padrão via Box-Muller. */
function gaussian(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function toLogReturns(closes: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]
    const curr = closes[i]
    if (prev == null || curr == null || prev <= 0 || curr <= 0) continue
    returns.push(Math.log(curr / prev))
  }
  return returns
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  let acc = 0
  for (const value of values) acc += (value - avg) ** 2
  return Math.sqrt(acc / (values.length - 1))
}

/** Percentil com interpolação linear. `sorted` precisa estar ordenado asc. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0] as number
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1)
  const low = Math.floor(pos)
  const high = Math.ceil(pos)
  const lowValue = sorted[low] as number
  if (low === high) return lowValue
  const highValue = sorted[high] as number
  return lowValue + (highValue - lowValue) * (pos - low)
}

/** Média e desvio amostral (n-1), com a mesma ordem de soma de `mean`/`stdDev`. */
function sampleMoments(values: Float64Array): { avg: number; sd: number } {
  const n = values.length
  if (n === 0) return { avg: 0, sd: 0 }
  let sum = 0
  for (let i = 0; i < n; i++) sum += values[i] as number
  const avg = sum / n
  if (n < 2) return { avg, sd: 0 }
  let acc = 0
  for (let i = 0; i < n; i++) acc += ((values[i] as number) - avg) ** 2
  return { avg, sd: Math.sqrt(acc / (n - 1)) }
}

/** Quickselect in-place: ao fim, a[k] é o k-ésimo menor e todo a[i > k] >= a[k]. Não use com NaN. */
function quickselect(a: Float64Array, k: number): void {
  let lo = 0
  let hi = a.length - 1
  while (hi > lo) {
    const mid = (lo + hi) >>> 1
    const x = a[lo] as number
    const y = a[mid] as number
    const z = a[hi] as number
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : (x < z ? x : y < z ? z : y)
    let i = lo
    let j = hi
    while (i <= j) {
      while ((a[i] as number) < pivot) i++
      while ((a[j] as number) > pivot) j--
      if (i <= j) {
        const tmp = a[i] as number
        a[i] = a[j] as number
        a[j] = tmp
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else return
  }
}

/** Mesmo valor de `percentile(sorted, q)`, sem ordenar: reordena `buf` parcialmente. */
function percentileSelect(buf: Float64Array, q: number): number {
  const n = buf.length
  if (n === 0) return 0
  if (n === 1) return buf[0] as number
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1)
  const low = Math.floor(pos)
  const high = Math.ceil(pos)
  quickselect(buf, low)
  const lowValue = buf[low] as number
  if (low === high) return lowValue
  let highValue = buf[high] as number
  for (let i = high + 1; i < n; i++) if ((buf[i] as number) < highValue) highValue = buf[i] as number
  return lowValue + (highValue - lowValue) * (pos - low)
}

const toPct = (value: number) => Math.round(value * 10000) / 100

/** Métricas usadas para ranquear candidatas (sem ordenação completa nem alocação por chamada). */
interface McScore {
  meanPct: number
  stdPct: number
  sharpe: number
  cvar95Pct: number
}

function scoreReturns(terminalReturns: Float64Array, scratch: Float64Array, days: number, riskFreeRate: number): McScore {
  const { avg, sd } = sampleMoments(terminalReturns)
  scratch.set(terminalReturns)
  const var95 = percentileSelect(scratch, 0.05)
  let tailSum = 0
  let tailCount = 0
  for (let i = 0; i < terminalReturns.length; i++) {
    const value = terminalReturns[i] as number
    if (value <= var95) {
      tailSum += value
      tailCount++
    }
  }
  const cvar95 = tailCount > 0 ? tailSum / tailCount : var95
  const horizonRiskFree = riskFreeRate * (days / TRADING_DAYS_YEAR)
  const sharpe = sd > 0 ? ((avg - horizonRiskFree) / sd) * Math.sqrt(TRADING_DAYS_YEAR / days) : 0
  return {
    meanPct: toPct(avg),
    stdPct: toPct(sd),
    sharpe: Math.round(sharpe * 100) / 100,
    cvar95Pct: toPct(cvar95),
  }
}

function summarize(terminalReturns: Float64Array, days: number, riskFreeRate: number): McDistribution {
  const sorted = terminalReturns.slice().sort()
  const { avg, sd } = sampleMoments(terminalReturns)
  const count = terminalReturns.length

  let profits = 0
  let gains10 = 0
  let losses10 = 0
  for (let i = 0; i < count; i++) {
    const value = terminalReturns[i] as number
    if (value > 0) profits++
    if (value >= 0.1) gains10++
    if (value <= -0.1) losses10++
  }

  const var95 = percentile(sorted, 0.05)
  let tailSum = 0
  let tailCount = 0
  for (let i = 0; i < count; i++) {
    const value = terminalReturns[i] as number
    if (value <= var95) {
      tailSum += value
      tailCount++
    }
  }
  const cvar95 = tailCount > 0 ? tailSum / tailCount : var95

  const horizonRiskFree = riskFreeRate * (days / TRADING_DAYS_YEAR)
  const sharpe = sd > 0 ? ((avg - horizonRiskFree) / sd) * Math.sqrt(TRADING_DAYS_YEAR / days) : 0

  return {
    meanPct: toPct(avg),
    medianPct: toPct(percentile(sorted, 0.5)),
    stdPct: toPct(sd),
    percentiles: {
      p5: toPct(percentile(sorted, 0.05)),
      p25: toPct(percentile(sorted, 0.25)),
      p50: toPct(percentile(sorted, 0.5)),
      p75: toPct(percentile(sorted, 0.75)),
      p95: toPct(percentile(sorted, 0.95)),
    },
    probProfit: Math.round((profits / count) * 1000) / 1000,
    probGain10: Math.round((gains10 / count) * 1000) / 1000,
    probLoss10: Math.round((losses10 / count) * 1000) / 1000,
    var95Pct: toPct(var95),
    cvar95Pct: toPct(cvar95),
    sharpe: Math.round(sharpe * 100) / 100,
  }
}

/**
 * Simula um ativo isolado.
 * `bootstrap` reamostra retornos históricos (mantém caudas gordas reais).
 * `gbm` usa movimento browniano geométrico com drift/vol estimados.
 */
export function simulateAsset(
  series: AssetSeries,
  config: Partial<McConfig> = {}
): McAssetResult | null {
  const { days, sims, seed, engine, riskFreeRate } = { ...DEFAULT_MC_CONFIG, ...config }
  const logReturns = toLogReturns(series.closes)
  if (logReturns.length < MIN_SAMPLES) return null

  const lastPrice = series.closes[series.closes.length - 1] as number
  const mu = mean(logReturns)
  const sigma = stdDev(logReturns)
  const rand = createRandom(seed)

  const terminal = new Float64Array(sims)
  const drawdowns = new Float64Array(sims)

  for (let s = 0; s < sims; s++) {
    let cumulative = 0
    let peak = 0
    let worstDrawdown = 0

    for (let d = 0; d < days; d++) {
      const step = engine === 'gbm'
        ? mu - 0.5 * sigma * sigma + sigma * gaussian(rand)
        : (logReturns[Math.floor(rand() * logReturns.length)] as number)
      cumulative += step
      if (cumulative > peak) peak = cumulative
      const drawdown = Math.expm1(cumulative - peak)
      if (drawdown < worstDrawdown) worstDrawdown = drawdown
    }

    terminal[s] = Math.expm1(cumulative)
    drawdowns[s] = worstDrawdown
  }

  const distribution = summarize(terminal, days, riskFreeRate)
  const sortedDrawdowns = drawdowns.slice().sort()

  // Kelly contínuo: f* = mu/sigma^2, limitado a [0, 1] para evitar alavancagem sugerida.
  const kelly = sigma > 0 ? Math.max(0, Math.min(1, mu / (sigma * sigma))) : 0
  const dailyRiskFree = riskFreeRate / TRADING_DAYS_YEAR
  const kellySuggested = fractionalKelly(mu - dailyRiskFree, sigma * sigma, 0.25, 0.2)

  const edge = distribution.probProfit - 0.5
  let verdict: McAssetResult['verdict'] = 'hold'
  if (distribution.meanPct > 1 && distribution.probProfit >= 0.55 && distribution.cvar95Pct > -25) verdict = 'buy'
  else if (distribution.meanPct < -1 && distribution.probProfit <= 0.45) verdict = 'sell'

  return {
    ticker: series.ticker,
    engine,
    days,
    sims,
    samples: logReturns.length,
    lastPrice,
    drift: {
      daily: Math.round(mu * 1e6) / 1e6,
      annualized: Math.round(mu * TRADING_DAYS_YEAR * 10000) / 100,
    },
    volatility: {
      daily: Math.round(sigma * 1e6) / 1e6,
      annualized: Math.round(sigma * Math.sqrt(TRADING_DAYS_YEAR) * 10000) / 100,
    },
    distribution,
    priceTargets: {
      p5: Math.round(lastPrice * (1 + distribution.percentiles.p5 / 100) * 100) / 100,
      p50: Math.round(lastPrice * (1 + distribution.percentiles.p50 / 100) * 100) / 100,
      p95: Math.round(lastPrice * (1 + distribution.percentiles.p95 / 100) * 100) / 100,
    },
    maxDrawdownP50Pct: Math.round(percentile(sortedDrawdowns, 0.5) * 10000) / 100,
    kellyFraction: Math.round(kelly * 1000) / 1000,
    kellySuggested: Math.round(kellySuggested * 1000) / 1000,
    verdict,
    confidence: Math.round(Math.min(1, Math.abs(edge) * 2) * 100) / 100,
  }
}

/** Alinha as séries pelo trecho final comum (mesmo número de observações). */
function buildReturnMatrix(assets: AssetSeries[]): { tickers: string[]; matrix: number[][] } | null {
  const usable = assets
    .map(asset => ({ ticker: asset.ticker, returns: toLogReturns(asset.closes) }))
    .filter(asset => asset.returns.length >= MIN_SAMPLES)

  if (usable.length < 2) return null

  const size = Math.min(...usable.map(asset => asset.returns.length))
  return {
    tickers: usable.map(asset => asset.ticker),
    // matrix[t][i]: retorno log do ativo i no dia t (mesma janela para todos).
    matrix: Array.from({ length: size }, (_, t) =>
      usable.map(asset => asset.returns[asset.returns.length - size + t] as number)
    ),
  }
}

function normalizeWeights(raw: number[], maxWeight: number): number[] {
  const n = raw.length
  const floor = 1 / n <= maxWeight ? maxWeight : 1
  let weights = raw.slice()

  for (let pass = 0; pass < 8; pass++) {
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (total <= 0) return Array.from({ length: n }, () => 1 / n)
    weights = weights.map(weight => weight / total)
    const excess = weights.filter(weight => weight > floor)
    if (excess.length === 0) break
    const capped = weights.map(weight => Math.min(weight, floor))
    const deficit = 1 - capped.reduce((sum, weight) => sum + weight, 0)
    const openIndexes = capped.map((weight, i) => (weight < floor ? i : -1)).filter(i => i >= 0)
    if (openIndexes.length === 0 || deficit <= 0) return capped
    for (const i of openIndexes) capped[i] = (capped[i] as number) + deficit / openIndexes.length
    weights = capped
  }
  return weights
}

function portfolioTerminalReturns(
  terminalByAsset: Float64Array,
  sims: number,
  n: number,
  weights: number[],
  out: Float64Array = new Float64Array(sims)
): Float64Array {
  // Carteiras são esparsas: pesos zero não alteram a soma, então só percorremos os ativos escolhidos.
  const active: number[] = []
  for (let i = 0; i < n; i++) if ((weights[i] as number) !== 0) active.push(i)
  const m = active.length
  for (let s = 0; s < sims; s++) {
    let acc = 0
    const base = s * n
    for (let k = 0; k < m; k++) {
      const i = active[k] as number
      acc += (weights[i] as number) * (terminalByAsset[base + i] as number)
    }
    out[s] = acc
  }
  return out
}

function portfolioDrawdownP50(
  matrix: number[][],
  pathIndexes: Int32Array,
  sims: number,
  days: number,
  weights: number[]
): number {
  const drawdowns = new Float64Array(sims)
  const active: number[] = []
  for (let i = 0; i < weights.length; i++) if ((weights[i] as number) !== 0) active.push(i)
  const m = active.length
  const cumulative = new Float64Array(weights.length)

  for (let s = 0; s < sims; s++) {
    cumulative.fill(0)
    let peak = 0
    let worst = 0

    for (let d = 0; d < days; d++) {
      const row = matrix[pathIndexes[s * days + d] as number] as number[]
      let value = 0
      for (let k = 0; k < m; k++) {
        const i = active[k] as number
        cumulative[i] = (cumulative[i] as number) + (row[i] as number)
        value += (weights[i] as number) * Math.expm1(cumulative[i] as number)
      }
      if (value > peak) peak = value
      const drawdown = (1 + value) / (1 + peak) - 1
      if (drawdown < worst) worst = drawdown
    }
    drawdowns[s] = worst
  }

  return Math.round(percentile(drawdowns.slice().sort(), 0.5) * 10000) / 100
}

/** Desloca cada coluna para a média encolhida (James-Stein), preservando a variância e a correlação. */
function shrinkMatrixDrift(matrix: number[][]): number {
  const n = (matrix[0] as number[]).length
  const t = matrix.length
  const means = Array.from({ length: n }, (_, i) => mean(matrix.map(row => row[i] as number)))
  const variances = Array.from({ length: n }, (_, i) => stdDev(matrix.map(row => row[i] as number)) ** 2)
  const { shrunk, intensity } = shrinkMeans(means, variances, t)
  for (const row of matrix) for (let i = 0; i < n; i++) row[i] = (row[i] as number) + ((shrunk[i] as number) - (means[i] as number))
  return intensity
}

export interface McOptimizeConfig extends McConfig {
  /** Encolhe as médias históricas antes de simular (recomendado). */
  shrinkDrift: boolean
  /** Número de vetores de peso avaliados. */
  candidates: number
  /** Peso máximo por ativo (concentração). */
  maxWeight: number
  /** Piso de CVaR 95% aceito pela carteira agressiva (ex.: -0.25 = -25%). */
  cvarFloor: number
}

export const DEFAULT_OPTIMIZE_CONFIG: McOptimizeConfig = {
  ...DEFAULT_MC_CONFIG,
  sims: 4000,
  candidates: 3000,
  maxWeight: 0.35,
  cvarFloor: -0.25,
  shrinkDrift: true,
}

/**
 * Otimização por Monte Carlo: reamostra dias históricos inteiros (preserva a
 * correlação entre ativos) e testa milhares de alocações buy-and-hold.
 */
export function optimizePortfolio(
  assets: AssetSeries[],
  config: Partial<McOptimizeConfig> = {}
): McPortfolioResult | null {
  const merged = { ...DEFAULT_OPTIMIZE_CONFIG, ...config }
  const { days, sims, seed, engine, riskFreeRate, candidates, maxWeight, cvarFloor } = merged

  const built = buildReturnMatrix(assets)
  if (!built) return null
  const { tickers, matrix } = built
  const n = tickers.length
  const driftShrinkage = merged.shrinkDrift ? shrinkMatrixDrift(matrix) : 0
  const rand = createRandom(seed)

  // Caminhos conjuntos: cada passo sorteia um dia histórico completo.
  const pathIndexes = new Int32Array(sims * days)
  for (let i = 0; i < pathIndexes.length; i++) {
    pathIndexes[i] = Math.floor(rand() * matrix.length)
  }

  // Retorno simples terminal de cada ativo em cada simulação.
  const terminalByAsset = new Float64Array(sims * n)
  for (let s = 0; s < sims; s++) {
    const cumulative = new Float64Array(n)
    for (let d = 0; d < days; d++) {
      const row = matrix[pathIndexes[s * days + d] as number] as number[]
      for (let i = 0; i < n; i++) cumulative[i] = (cumulative[i] as number) + (row[i] as number)
    }
    for (let i = 0; i < n; i++) terminalByAsset[s * n + i] = Math.expm1(cumulative[i] as number)
  }

  const returnsBuffer = new Float64Array(sims)
  const scratch = new Float64Array(sims)
  const evaluate = (weights: number[]) => ({
    weights,
    score: scoreReturns(portfolioTerminalReturns(terminalByAsset, sims, n, weights, returnsBuffer), scratch, days, riskFreeRate),
  })

  const equalWeight = Array.from({ length: n }, () => 1 / n)
  const pool = [evaluate(equalWeight)]

  for (let c = 0; c < candidates; c++) {
    // Carteiras esparsas (3..8 ativos) geram alocações concentradas, não só a média.
    const picks = 3 + Math.floor(rand() * Math.min(6, Math.max(1, n - 2)))
    const raw = Array.from({ length: n }, () => 0)
    const available = Array.from({ length: n }, (_, i) => i)
    for (let p = 0; p < Math.min(picks, n); p++) {
      const idx = Math.floor(rand() * available.length)
      const asset = available.splice(idx, 1)[0] as number
      raw[asset] = -Math.log(1 - rand()) // Exp(1) => Dirichlet após normalizar
    }
    pool.push(evaluate(normalizeWeights(raw, maxWeight)))
  }

  const pickBest = (score: (item: (typeof pool)[number]) => number) => {
    let best = pool[0] as (typeof pool)[number]
    let bestScore = score(best)
    for (let i = 1; i < pool.length; i++) {
      const item = pool[i] as (typeof pool)[number]
      const value = score(item)
      if (value > bestScore) {
        best = item
        bestScore = value
      }
    }
    return best
  }

  const bySharpe = pickBest(item => item.score.sharpe)
  const byDefensive = pickBest(item => item.score.cvar95Pct + item.score.meanPct * 0.25)
  const aggressiveScore = (item: (typeof pool)[number]) =>
    item.score.cvar95Pct / 100 < cvarFloor ? -Infinity : item.score.meanPct
  const aggressivePick = pickBest(aggressiveScore)
  const byAggressive = aggressiveScore(aggressivePick) === -Infinity ? bySharpe : aggressivePick

  const toCandidate = (label: string, item: (typeof pool)[number]): McCandidate => ({
    label,
    weights: item.weights
      .map((weight, i) => ({ ticker: tickers[i] as string, weight: Math.round(weight * 1000) / 1000 }))
      .filter(allocation => allocation.weight >= 0.01)
      .sort((a, b) => b.weight - a.weight),
    distribution: summarize(portfolioTerminalReturns(terminalByAsset, sims, n, item.weights), days, riskFreeRate),
    maxDrawdownP50Pct: portfolioDrawdownP50(matrix, pathIndexes, sims, days, item.weights),
  })

  const frontier = pool
    .map(item => ({
      riskPct: item.score.stdPct,
      returnPct: item.score.meanPct,
      sharpe: item.score.sharpe,
    }))
    .sort((a, b) => a.riskPct - b.riskPct)
    .filter((_, index, all) => index % Math.max(1, Math.floor(all.length / 40)) === 0)
    .slice(0, 40)

  const perAsset = assets
    .map(asset => simulateAsset(asset, { days, sims: Math.min(sims, 2000), seed, engine, riskFreeRate }))
    .filter((result): result is McAssetResult => result !== null)
    .sort((a, b) => b.distribution.sharpe - a.distribution.sharpe)

  return {
    engine,
    days,
    sims,
    candidates,
    seed,
    samples: matrix.length,
    driftShrinkage: Math.round(driftShrinkage * 1000) / 1000,
    assets: tickers,
    best: {
      sharpe: toCandidate('sharpe', bySharpe),
      aggressive: toCandidate('aggressive', byAggressive),
      defensive: toCandidate('defensive', byDefensive),
    },
    frontier,
    perAsset,
  }
}
