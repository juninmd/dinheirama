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
