import * as fs from 'fs'
import * as path from 'path'

export interface FeatureVector {
  rsi: number | null
  historyChange30d: number
  dayChange: number | null
  volumeRatio: number | null
  priceToSma20: number | null
  priceToSma50: number | null
  atr: number | null
  newsImpactScore: number
  signalCount: number
  marketCap: number | null
  peRatio: number | null
  dividendYield: number | null
}

export interface ModelPrediction {
  action: 'buy' | 'hold' | 'sell'
  confidence: number
  probabilities: { buy: number; hold: number; sell: number }
  modelVersion: string | null
  source: 'ml' | 'fallback'
}

interface ModelData {
  weights: {
    feature: string
    importance: number
    direction: number
  }[]
  scaler: {
    mean: Record<string, number>
    std: Record<string, number>
  }
  threshold: number
  version: string
}

let _model: ModelData | null = null
let _modelPath: string | null = null

function getFeatureValue(features: FeatureVector, name: string): number {
  const map: Record<string, number | null> = {
    rsi: features.rsi,
    historyChange30d: features.historyChange30d,
    dayChange: features.dayChange,
    volumeRatio: features.volumeRatio,
    priceToSma20: features.priceToSma20,
    priceToSma50: features.priceToSma50,
    atr: features.atr,
    newsImpactScore: features.newsImpactScore,
    signalCount: features.signalCount,
    marketCap: features.marketCap,
    peRatio: features.peRatio,
    dividendYield: features.dividendYield,
  }
  const val = map[name]
  if (val === null || val === undefined || !isFinite(val)) return 0
  return val
}

function loadModel(modelDir?: string): ModelData | null {
  const dir = modelDir || process.env.MODEL_DIR || '/data/models'
  try {
    const metaPath = path.join(dir, 'model_metadata.json')
    if (!fs.existsSync(metaPath)) return null

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))

    const tsPattern = `model_horizon_${meta.horizon || 5}d.ts`
    const tsPath = path.join(dir, tsPattern)

    if (!fs.existsSync(tsPath)) return null

    const content = fs.readFileSync(tsPath, 'utf-8')

    const thresholdMatch = content.match(/xgbThreshold:\s*([\d.]+)/)
    if (!thresholdMatch) return null

    const scalerMeanMatch = content.match(/scalerMean:\s*({[\s\S]*?})/)
    const scalerStdMatch = content.match(/scalerStd:\s*({[\s\S]*?})/)

    if (!scalerMeanMatch || !scalerStdMatch) return null

    const mean = JSON.parse(scalerMeanMatch[1])
    const std = JSON.parse(scalerStdMatch[1])

    const features = Object.keys(mean)
    const weights = features.map((f, i) => ({
      feature: f,
      importance: 1 / features.length,
      direction: mean[f] > 0 ? 1 : -1,
    }))

    _model = {
      weights,
      scaler: { mean, std },
      threshold: parseFloat(thresholdMatch[1]),
      version: meta.horizon ? `xgb_horizon_${meta.horizon}d_v1` : 'unknown',
    }

    console.log(`[serve] Model loaded from ${tsPath} v${_model.version}`)
    return _model
  } catch (error: any) {
    console.warn(`[serve] Failed to load ML model: ${error.message}`)
    return null
  }
}

function standardize(features: FeatureVector, mean: Record<string, number>, std: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const key of Object.keys(mean)) {
    const raw = getFeatureValue(features, key)
    const m = mean[key] || 0
    const s = std[key] || 1
    result[key] = s > 0 ? (raw - m) / s : 0
  }
  return result
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function predictBuyScore(features: FeatureVector, model: ModelData): number {
  const scaled = standardize(features, model.scaler.mean, model.scaler.std)
  let score = 0

  for (const w of model.weights) {
    const val = scaled[w.feature] ?? 0
    score += val * w.importance * w.direction
  }

  return sigmoid(score)
}

const FEATURE_BASED_WEIGHTS = {
  rsi: { sellThreshold: 75, buyThreshold: 30 },
  historyChange30d: 0.20,
  dayChange: 0.05,
  volumeRatio: 0.05,
  priceToSma20: 0.15,
  priceToSma50: 0.10,
  atr: 0.05,
  newsImpactScore: 0.10,
  signalCount: 0.05,
  marketCap: 0.05,
  peRatio: 0.05,
  dividendYield: 0.05,
}

function fallbackPredict(features: FeatureVector): ModelPrediction {
  let buySignal = 0
  let totalWeight = 0

  const score = (condition: boolean, weight: number) => {
    if (condition) buySignal += weight
    totalWeight += weight
  }

  if (features.rsi !== null) {
    score(features.rsi < 30, 0.15)
    score(features.rsi > 75, -0.15)
  }
  score(features.historyChange30d > 8, 0.10)
  score(features.historyChange30d < -8, -0.10)
  score(features.dayChange !== null && features.dayChange > 3, 0.05)
  score(features.dayChange !== null && features.dayChange < -3, -0.05)
  score(features.priceToSma20 !== null && features.priceToSma20 < 0.95, 0.08)
  score(features.priceToSma50 !== null && features.priceToSma50 < 0.90, 0.10)
  score(features.volumeRatio !== null && features.volumeRatio > 1.5, 0.05)
  score(features.newsImpactScore > 2, 0.08)
  score(features.newsImpactScore < -2, -0.08)
  score(features.signalCount > 3, 0.03)
  score(features.dividendYield !== null && features.dividendYield > 0.05, 0.05)

  const normalizedScore = totalWeight > 0 ? (buySignal / totalWeight + 1) / 2 : 0.5
  const confidence = Math.abs(normalizedScore - 0.5) * 2

  let action: 'buy' | 'hold' | 'sell'
  if (normalizedScore > 0.6) action = 'buy'
  else if (normalizedScore < 0.4) action = 'sell'
  else action = 'hold'

  const sellProb = Math.max(0, Math.min(1, (1 - normalizedScore) * (1 - confidence / 2)))
  const holdProb = Math.max(0, 1 - Math.abs(normalizedScore - 0.5) * 2)
  const buyProb = Math.max(0, Math.min(1, normalizedScore * (1 - confidence / 2)))
  const total = sellProb + holdProb + buyProb

  return {
    action,
    confidence: Math.round(confidence * 100) / 100,
    probabilities: {
      buy: Math.round((buyProb / total) * 100) / 100,
      hold: Math.round((holdProb / total) * 100) / 100,
      sell: Math.round((sellProb / total) * 100) / 100,
    },
    modelVersion: null,
    source: 'fallback',
  }
}

export function initModel(modelDir?: string): boolean {
  const dir = modelDir || process.env.MODEL_DIR || '/data/models'
  _modelPath = dir

  try {
    if (fs.existsSync(dir)) {
      _model = loadModel(dir)
      if (_model) {
        console.log(`[serve] ML model initialized from ${dir} v${_model.version}`)
        return true
      }
    }
  } catch (error: any) {
    console.warn(`[serve] Could not initialize ML model: ${error.message}`)
  }

  _model = null
  console.log('[serve] No ML model found, using fallback predictor')
  return false
}

export function predict(features: FeatureVector): ModelPrediction {
  if (_model) {
    const buyScore = predictBuyScore(features, _model)
    const confidence = Math.abs(buyScore - 0.5) * 2

    let action: 'buy' | 'hold' | 'sell'
    if (buyScore > 0.5 + _model.threshold / 2) action = 'buy'
    else if (buyScore < 0.5 - _model.threshold / 2) action = 'sell'
    else action = 'hold'

    const sellProb = Math.max(0, Math.min(1, (1 - buyScore) * (1 - confidence / 2)))
    const holdProb = Math.max(0, 1 - Math.abs(buyScore - 0.5) * 2)
    const buyProb = Math.max(0, Math.min(1, buyScore * (1 - confidence / 2)))
    const total = sellProb + holdProb + buyProb

    return {
      action,
      confidence: Math.round(confidence * 100) / 100,
      probabilities: {
        buy: Math.round((buyProb / total) * 100) / 100,
        hold: Math.round((holdProb / total) * 100) / 100,
        sell: Math.round((sellProb / total) * 100) / 100,
      },
      modelVersion: _model.version,
      source: 'ml',
    }
  }

  return fallbackPredict(features)
}

export function reloadModel(): boolean {
  _model = null
  return initModel(_modelPath ?? undefined)
}

export function isModelLoaded(): boolean {
  return _model !== null
}
