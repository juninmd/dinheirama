// Estatística básica compartilhada pelos módulos quantitativos (sem dependências).

export const TRADING_DAYS_YEAR = 252

export function mean(values: ArrayLike<number>): number {
  const n = values.length
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += values[i] as number
  return sum / n
}

/** Desvio-padrão amostral (n-1). */
export function stdDev(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 2) return 0
  const m = mean(values)
  let sum = 0
  for (let i = 0; i < n; i++) sum += ((values[i] as number) - m) ** 2
  return Math.sqrt(sum / (n - 1))
}

export function covariance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  const ma = mean(Array.from(a).slice(0, n))
  const mb = mean(Array.from(b).slice(0, n))
  let sum = 0
  for (let i = 0; i < n; i++) sum += ((a[i] as number) - ma) * ((b[i] as number) - mb)
  return sum / (n - 1)
}

export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const sa = stdDev(a)
  const sb = stdDev(b)
  if (sa === 0 || sb === 0) return 0
  return covariance(a, b) / (sa * sb)
}

/** Percentil com interpolação linear sobre vetor já ordenado. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const pos = Math.min(1, Math.max(0, q)) * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (pos - lo)
}

export function quantile(values: ArrayLike<number>, q: number): number {
  return quantileSorted(Float64Array.from(values as ArrayLike<number>).sort(), q)
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5)
}

/** Assimetria (skewness) amostral. */
export function skewness(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 3) return 0
  const m = mean(values)
  let m2 = 0
  let m3 = 0
  for (let i = 0; i < n; i++) {
    const d = (values[i] as number) - m
    m2 += d * d
    m3 += d * d * d
  }
  m2 /= n
  m3 /= n
  return m2 === 0 ? 0 : m3 / Math.pow(m2, 1.5)
}

/** Curtose em excesso (normal = 0). */
export function excessKurtosis(values: ArrayLike<number>): number {
  const n = values.length
  if (n < 4) return 0
  const m = mean(values)
  let m2 = 0
  let m4 = 0
  for (let i = 0; i < n; i++) {
    const d = (values[i] as number) - m
    m2 += d * d
    m4 += d ** 4
  }
  m2 /= n
  m4 /= n
  return m2 === 0 ? 0 : m4 / (m2 * m2) - 3
}

/** CDF da normal padrão (Abramowitz-Stegun 7.1.26 via erf). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592
  const erf = 1 - poly * t * Math.exp(-(x * x) / 2)
  return 0.5 * (1 + (x >= 0 ? erf : -erf))
}

/** Inversa da CDF normal (Acklam, erro relativo < 1.2e-9). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  const high = 1 - low
  let q: number
  let r: number
  if (p < low) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > high) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/** Retornos simples a partir de preços. */
export function simpleReturns(prices: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] as number
    out.push(prev > 0 ? (prices[i] as number) / prev - 1 : 0)
  }
  return out
}

/** Retornos logarítmicos a partir de preços. */
export function logReturns(prices: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] as number
    const cur = prices[i] as number
    out.push(prev > 0 && cur > 0 ? Math.log(cur / prev) : 0)
  }
  return out
}

/** Winsoriza nos percentis [lo, hi] para domar outliers antes do z-score. */
export function winsorize(values: number[], lo = 0.05, hi = 0.95): number[] {
  if (values.length === 0) return []
  const sorted = Float64Array.from(values).sort()
  const a = quantileSorted(sorted, lo)
  const b = quantileSorted(sorted, hi)
  return values.map(v => Math.min(b, Math.max(a, v)))
}

/**
 * Z-score robusto cross-sectional: winsoriza, depois padroniza.
 * Entradas null/NaN permanecem null (dado ausente não vira zero).
 */
export function zScores(values: Array<number | null | undefined>, winsor = 0.05): Array<number | null> {
  const valid: number[] = []
  const idx: number[] = []
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      valid.push(v)
      idx.push(i)
    }
  })
  const out: Array<number | null> = values.map(() => null)
  if (valid.length < 3) return out
  const clipped = winsorize(valid, winsor, 1 - winsor)
  const m = mean(clipped)
  const s = stdDev(clipped)
  if (s === 0) {
    idx.forEach(i => { out[i] = 0 })
    return out
  }
  clipped.forEach((v, k) => { out[idx[k] as number] = (v - m) / s })
  return out
}

/** Posto percentual 0..100 (maior valor => 100). Empates recebem posto médio. */
export function percentileRanks(values: Array<number | null | undefined>): Array<number | null> {
  const entries = values
    .map((v, i) => ({ v, i }))
    .filter((e): e is { v: number; i: number } => typeof e.v === 'number' && Number.isFinite(e.v))
  const out: Array<number | null> = values.map(() => null)
  if (entries.length === 0) return out
  if (entries.length === 1) {
    out[entries[0]!.i] = 50
    return out
  }
  entries.sort((a, b) => a.v - b.v)
  let k = 0
  while (k < entries.length) {
    let j = k
    while (j + 1 < entries.length && entries[j + 1]!.v === entries[k]!.v) j++
    const avgRank = (k + j) / 2
    for (let m = k; m <= j; m++) out[entries[m]!.i] = (avgRank / (entries.length - 1)) * 100
    k = j + 1
  }
  return out
}

export interface OlsResult {
  alpha: number
  beta: number
  r2: number
}

/** Regressão linear simples y = alpha + beta * x. */
export function ols(y: ArrayLike<number>, x: ArrayLike<number>): OlsResult {
  const n = Math.min(x.length, y.length)
  if (n < 3) return { alpha: 0, beta: 0, r2: 0 }
  const xs = Array.from(x).slice(0, n)
  const ys = Array.from(y).slice(0, n)
  const vx = covariance(xs, xs)
  if (vx === 0) return { alpha: mean(ys), beta: 0, r2: 0 }
  const beta = covariance(ys, xs) / vx
  const alpha = mean(ys) - beta * mean(xs)
  const corr = correlation(xs, ys)
  return { alpha, beta, r2: corr * corr }
}

/** Matriz de covariância amostral de colunas (linhas = observações). */
export function covarianceMatrix(rows: number[][]): number[][] {
  const t = rows.length
  const n = t > 0 ? (rows[0] as number[]).length : 0
  const means = Array.from({ length: n }, () => 0)
  for (const row of rows) for (let j = 0; j < n; j++) means[j] = (means[j] as number) + (row[j] as number) / t
  const cov = Array.from({ length: n }, () => Array.from({ length: n }, () => 0))
  for (const row of rows) {
    for (let i = 0; i < n; i++) {
      const di = (row[i] as number) - (means[i] as number)
      for (let j = i; j < n; j++) {
        const dj = (row[j] as number) - (means[j] as number)
        ;(cov[i] as number[])[j] = ((cov[i] as number[])[j] as number) + di * dj
      }
    }
  }
  const denom = Math.max(1, t - 1)
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const v = ((cov[i] as number[])[j] as number) / denom
      ;(cov[i] as number[])[j] = v
      ;(cov[j] as number[])[i] = v
    }
  }
  return cov
}

export function correlationFromCovariance(cov: number[][]): number[][] {
  const n = cov.length
  const sd = cov.map((row, i) => Math.sqrt(Math.max(0, row[i] as number)))
  return cov.map((row, i) => row.map((v, j) => {
    const d = (sd[i] as number) * (sd[j] as number)
    return d === 0 ? (i === j ? 1 : 0) : v / d
  }))
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}
