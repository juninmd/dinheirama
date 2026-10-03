// Validação sem vazamento: k-fold com purga + embargo e seleção walk-forward de parâmetros.
// Referência: López de Prado, "Advances in Financial Machine Learning" (caps. 7 e 11-14).

import { mean, stdDev } from './stats.ts'

export interface Split {
  train: number[]
  test: number[]
}

/**
 * K-fold purgado com embargo para séries temporais com rótulos que olham `horizon` pregões à frente.
 * - purga: remove do treino observações cujo rótulo se sobrepõe ao teste;
 * - embargo: remove `embargo` observações logo após o bloco de teste.
 */
export function purgedKFold(n: number, folds: number, horizon: number, embargo: number): Split[] {
  if (folds < 2 || n < folds) throw new Error('purgedKFold: precisa de pelo menos 2 folds e n >= folds')
  const size = Math.floor(n / folds)
  const splits: Split[] = []
  for (let k = 0; k < folds; k++) {
    const start = k * size
    const end = k === folds - 1 ? n : start + size
    const test: number[] = []
    for (let i = start; i < end; i++) test.push(i)
    const train: number[] = []
    for (let i = 0; i < n; i++) {
      if (i >= start && i < end) continue
      // rótulo de i usa [i, i+horizon]; sobrepõe o teste se i+horizon >= start e i < end
      if (i < start && i + horizon >= start) continue
      if (i >= end && i < end + embargo) continue
      train.push(i)
    }
    splits.push({ train, test })
  }
  return splits
}

/** Divisões walk-forward (janela de treino rolante) com embargo entre treino e teste. */
export function walkForwardSplits(n: number, trainSize: number, testSize: number, embargo = 0): Split[] {
  const out: Split[] = []
  for (let start = 0; start + trainSize + embargo + testSize <= n; start += testSize) {
    const train: number[] = []
    for (let i = start; i < start + trainSize; i++) train.push(i)
    const test: number[] = []
    for (let i = start + trainSize + embargo; i < start + trainSize + embargo + testSize; i++) test.push(i)
    out.push({ train, test })
  }
  return out
}

function sharpeOf(returns: number[]): number {
  const s = stdDev(returns)
  return s === 0 ? 0 : (mean(returns) / s) * Math.sqrt(252)
}

export interface WalkForwardSelection {
  folds: number
  /** Parâmetro escolhido em cada fold (melhor Sharpe no treino). */
  chosen: string[]
  /** Retornos fora da amostra concatenados. */
  oosReturns: number[]
  oosSharpe: number
  /** Sharpe médio, no teste, de todas as variantes (quanto "o acaso" rende). */
  meanTrialOosSharpe: number
  /**
   * Fração de folds em que o melhor do treino ficou na metade inferior no teste
   * (aproximação do PBO de Bailey et al.: >0,5 sugere que a seleção é overfitting).
   */
  probabilityOfOverfit: number
}

/**
 * Avalia o PROCESSO de escolher parâmetros: em cada fold escolhe a variante de melhor Sharpe no
 * treino e mede seu desempenho no teste. `variants[name]` = retornos diários da variante no período todo
 * (estratégias só usam dados passados, então a série completa pode ser fatiada).
 */
export function walkForwardSelect(
  variants: Record<string, number[]>,
  trainSize: number,
  testSize: number,
  embargo = 0
): WalkForwardSelection | null {
  const names = Object.keys(variants)
  if (names.length < 2) return null
  const n = Math.min(...names.map(k => (variants[k] as number[]).length))
  const splits = walkForwardSplits(n, trainSize, testSize, embargo)
  if (splits.length === 0) return null

  const chosen: string[] = []
  const oos: number[] = []
  let belowMedian = 0
  const trialMeans: number[] = []

  for (const split of splits) {
    const pick = (name: string, idx: number[]) => idx.map(i => (variants[name] as number[])[i] as number)
    const trainScores = names.map(name => ({ name, sharpe: sharpeOf(pick(name, split.train)) }))
    const best = trainScores.reduce((a, b) => (b.sharpe > a.sharpe ? b : a))
    chosen.push(best.name)
    const testReturns = pick(best.name, split.test)
    oos.push(...testReturns)

    const testSharpes = names.map(name => ({ name, sharpe: sharpeOf(pick(name, split.test)) }))
    trialMeans.push(mean(testSharpes.map(t => t.sharpe)))
    const sorted = [...testSharpes].sort((a, b) => a.sharpe - b.sharpe)
    const rank = sorted.findIndex(t => t.name === best.name)
    if (rank < sorted.length / 2) belowMedian++
  }

  return {
    folds: splits.length,
    chosen,
    oosReturns: oos,
    oosSharpe: sharpeOf(oos),
    meanTrialOosSharpe: mean(trialMeans),
    probabilityOfOverfit: belowMedian / splits.length,
  }
}

// ---- PBO por CSCV (Bailey, Borwein, López de Prado, Zhu) -------------------

export interface PboResult {
  partitions: number
  combinations: number
  variants: number
  /** Probabilidade de overfitting: fração das combinações em que o melhor da amostra fica na metade inferior fora dela. */
  pbo: number
  /** Mediana do logit do posto relativo OOS do melhor IS (logit < 0 => abaixo da mediana). */
  medianLogit: number
  /** Fração das combinações em que o melhor IS teve Sharpe OOS negativo. */
  probOosLoss: number
  /** Média do Sharpe (por período) do melhor IS, dentro e fora da amostra: a queda mede a degradação. */
  meanIsSharpe: number
  meanOosSharpe: number
  /** Quantas vezes cada variante foi a melhor na amostra. */
  selectionShare: Record<string, number>
}

interface BlockStats {
  n: number
  sum: number
  sumSq: number
}

function sharpeFromBlocks(blocks: BlockStats[], chosen: number[]): number {
  let n = 0
  let sum = 0
  let sumSq = 0
  for (const i of chosen) {
    const b = blocks[i] as BlockStats
    n += b.n
    sum += b.sum
    sumSq += b.sumSq
  }
  if (n < 2) return 0
  const m = sum / n
  const variance = (sumSq - n * m * m) / (n - 1)
  return variance > 1e-18 ? m / Math.sqrt(variance) : 0
}

function combinations(total: number, pick: number, limit: number): number[][] {
  const out: number[][] = []
  const current: number[] = []
  const walk = (start: number) => {
    if (out.length >= limit) return
    if (current.length === pick) {
      out.push([...current])
      return
    }
    for (let i = start; i < total; i++) {
      current.push(i)
      walk(i + 1)
      current.pop()
      if (out.length >= limit) return
    }
  }
  walk(0)
  return out
}

/**
 * Combinatorially Symmetric Cross-Validation: divide o período em S blocos contíguos, e para cada uma das
 * C(S, S/2) divisões treino/teste escolhe a melhor variante no treino e mede seu posto fora da amostra.
 * PBO alto (> ~0,5) indica que escolher "a melhor" variante do backtest tende a não generalizar.
 */
export function probabilityOfBacktestOverfitting(
  variants: Record<string, number[]>,
  partitions = 16,
  maxCombinations = 20000
): PboResult | null {
  const names = Object.keys(variants)
  if (names.length < 2) return null
  const S = partitions % 2 === 0 ? partitions : partitions + 1
  const T = Math.min(...names.map(k => (variants[k] as number[]).length))
  const size = Math.floor(T / S)
  if (size < 5) return null

  const stats: BlockStats[][] = names.map(name => {
    const r = variants[name] as number[]
    return Array.from({ length: S }, (_, b) => {
      let sum = 0
      let sumSq = 0
      for (let i = b * size; i < (b + 1) * size; i++) {
        const x = r[i] as number
        sum += x
        sumSq += x * x
      }
      return { n: size, sum, sumSq }
    })
  })

  const combos = combinations(S, S / 2, maxCombinations)
  const logits: number[] = []
  const selection = new Map<string, number>()
  let oosLoss = 0
  let isSum = 0
  let oosSum = 0

  for (const inSample of combos) {
    const inSet = new Set(inSample)
    const outSample = Array.from({ length: S }, (_, i) => i).filter(i => !inSet.has(i))
    const isSharpes = stats.map(s => sharpeFromBlocks(s, inSample))
    const oosSharpes = stats.map(s => sharpeFromBlocks(s, outSample))
    let best = 0
    for (let i = 1; i < names.length; i++) if ((isSharpes[i] as number) > (isSharpes[best] as number)) best = i

    const bestOos = oosSharpes[best] as number
    // posto relativo OOS do melhor IS (1 = pior ... N = melhor), empates pela metade
    let below = 0
    let ties = 0
    for (let i = 0; i < names.length; i++) {
      if (i === best) continue
      if ((oosSharpes[i] as number) < bestOos) below++
      else if ((oosSharpes[i] as number) === bestOos) ties++
    }
    const rank = below + ties / 2 + 1
    const omega = rank / (names.length + 1)
    logits.push(Math.log(omega / (1 - omega)))

    selection.set(names[best] as string, (selection.get(names[best] as string) ?? 0) + 1)
    if (bestOos < 0) oosLoss++
    isSum += isSharpes[best] as number
    oosSum += bestOos
  }

  const sortedLogits = [...logits].sort((a, b) => a - b)
  const mid = Math.floor(sortedLogits.length / 2)
  const median = sortedLogits.length % 2 ? (sortedLogits[mid] as number) : ((sortedLogits[mid - 1] as number) + (sortedLogits[mid] as number)) / 2
  return {
    partitions: S,
    combinations: combos.length,
    variants: names.length,
    pbo: logits.filter(l => l <= 0).length / logits.length,
    medianLogit: median,
    probOosLoss: oosLoss / combos.length,
    meanIsSharpe: isSum / combos.length,
    meanOosSharpe: oosSum / combos.length,
    selectionShare: Object.fromEntries(names.map(n => [n, (selection.get(n) ?? 0) / combos.length])),
  }
}
