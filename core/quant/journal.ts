// Diário de decisões com calibração (Tetlock, Kahneman): registrar a probabilidade ANTES do resultado
// e medir, com Brier score e curva de confiabilidade, se a confiança corresponde à frequência de acerto.
//
// Evento previsto: "o ativo supera o benchmark (ou o CDI, sem benchmark) no horizonte?".

import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'

export const journalInputSchema = z.object({
  ticker: z.string().regex(/^[A-Z0-9]{4,6}\.[A-Z]{2}$/),
  action: z.enum(['buy', 'hold', 'sell']),
  /** Probabilidade (0..1) de o ativo superar o benchmark no horizonte. */
  probability: z.number().min(0.01).max(0.99),
  horizonDays: z.number().int().min(5).max(1500),
  entryPrice: z.number().positive(),
  source: z.enum(['score', 'manual', 'llm']).default('manual'),
  thesis: z.string().max(500).optional(),
})

export type JournalInput = z.infer<typeof journalInputSchema>

export interface JournalEntry extends JournalInput {
  id: string
  createdAt: string
  dueAt: string
  status: 'open' | 'resolved'
  resolvedAt?: string
  exitPrice?: number
  returnPct?: number
  referenceReturnPct?: number
  /** 1 = superou a referência. */
  outcome?: 0 | 1
}

export interface ResolutionData {
  /** Preço (ajustado) na data de saída. */
  exitPrice: number
  /** Preço (ajustado) na data de entrada, quando disponível — evita viés de ajuste por proventos. */
  entryPrice?: number
  /** Retorno da referência (benchmark ou CDI) no período, em fração. */
  referenceReturn: number
}

export type PriceLookup = (entry: JournalEntry, now: Date) => Promise<ResolutionData | null>

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 864e5).toISOString()
}

export class Journal {
  private entries: JournalEntry[] = []

  constructor(private readonly file: string | null = null) {
    this.load()
  }

  private load(): void {
    if (!this.file) return
    try {
      if (fs.existsSync(this.file)) this.entries = JSON.parse(fs.readFileSync(this.file, 'utf8')) as JournalEntry[]
    } catch (error) {
      console.error('[journal] erro ao ler diário:', error)
      this.entries = []
    }
  }

  private save(): void {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2))
    fs.renameSync(tmp, this.file)
  }

  list(): JournalEntry[] {
    return [...this.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  add(input: JournalInput, now = new Date()): JournalEntry {
    const createdAt = now.toISOString()
    const entry: JournalEntry = {
      ...input,
      id: `j_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt,
      dueAt: addDays(createdAt, input.horizonDays),
      status: 'open',
    }
    this.entries.push(entry)
    this.save()
    return entry
  }

  remove(id: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length === before) return false
    this.save()
    return true
  }

  /** Resolve entradas vencidas usando `lookup`; devolve as resolvidas. */
  async resolveDue(lookup: PriceLookup, now = new Date()): Promise<JournalEntry[]> {
    const resolved: JournalEntry[] = []
    for (const entry of this.entries) {
      if (entry.status !== 'open' || new Date(entry.dueAt) > now) continue
      const data = await lookup(entry, now)
      if (!data) continue
      const ret = data.exitPrice / (data.entryPrice ?? entry.entryPrice) - 1
      entry.status = 'resolved'
      entry.resolvedAt = now.toISOString()
      entry.exitPrice = data.exitPrice
      entry.returnPct = ret * 100
      entry.referenceReturnPct = data.referenceReturn * 100
      entry.outcome = ret > data.referenceReturn ? 1 : 0
      resolved.push(entry)
    }
    if (resolved.length > 0) this.save()
    return resolved
  }
}

// ---- Calibração ------------------------------------------------------------

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
  /** Brier de referência de quem sempre prevê a taxa-base observada (climatologia). */
  brierBaseline: number | null
  /** > 0: melhor que prever sempre a taxa-base; <= 0: sem habilidade além da taxa-base. */
  brierSkill: number | null
  logLoss: number | null
  baseRate: number | null
  /** Acerto da direção: buy/p>0.5 vs. resultado. */
  directionalHitRate: number | null
  avgExcessReturnPctBuy: number | null
  avgExcessReturnPctSell: number | null
  bins: ReliabilityBin[]
  warnings: string[]
}

export function brierScore(forecasts: number[], outcomes: number[]): number | null {
  if (forecasts.length === 0 || forecasts.length !== outcomes.length) return null
  return forecasts.reduce((a, p, i) => a + (p - (outcomes[i] as number)) ** 2, 0) / forecasts.length
}

export function logLoss(forecasts: number[], outcomes: number[]): number | null {
  if (forecasts.length === 0 || forecasts.length !== outcomes.length) return null
  const eps = 1e-6
  return -forecasts.reduce((a, p, i) => {
    const q = Math.min(1 - eps, Math.max(eps, p))
    return a + ((outcomes[i] as number) === 1 ? Math.log(q) : Math.log(1 - q))
  }, 0) / forecasts.length
}

export function reliabilityBins(forecasts: number[], outcomes: number[], bins = 5): ReliabilityBin[] {
  const out: ReliabilityBin[] = []
  for (let b = 0; b < bins; b++) {
    const from = b / bins
    const to = (b + 1) / bins
    const idx = forecasts.map((p, i) => ({ p, i })).filter(({ p }) => p >= from && (b === bins - 1 ? p <= to : p < to))
    out.push({
      from,
      to,
      count: idx.length,
      meanForecast: idx.length ? idx.reduce((a, { p }) => a + p, 0) / idx.length : null,
      observedFrequency: idx.length ? idx.reduce((a, { i }) => a + (outcomes[i] as number), 0) / idx.length : null,
    })
  }
  return out
}

export function calibrationReport(entries: JournalEntry[]): CalibrationReport {
  const resolved = entries.filter((e): e is JournalEntry & { outcome: 0 | 1 } => e.status === 'resolved' && e.outcome !== undefined)
  const forecasts = resolved.map(e => e.probability)
  const outcomes = resolved.map(e => e.outcome as number)
  const n = resolved.length
  const baseRate = n ? outcomes.reduce((a, b) => a + b, 0) / n : null
  const brier = brierScore(forecasts, outcomes)
  const baseline = baseRate === null ? null : baseRate * (1 - baseRate)
  const skill = brier !== null && baseline !== null && baseline > 0 ? 1 - brier / baseline : null

  const directional = resolved.filter(e => e.action !== 'hold')
  const hits = directional.filter(e => (e.action === 'buy' ? e.outcome === 1 : e.outcome === 0)).length
  const excess = (e: JournalEntry) => (e.returnPct ?? 0) - (e.referenceReturnPct ?? 0)
  const avg = (list: JournalEntry[]) => (list.length ? list.reduce((a, e) => a + excess(e), 0) / list.length : null)

  const warnings: string[] = []
  if (n < 30) warnings.push(`Apenas ${n} previsões resolvidas: com menos de ~30 o Brier score é muito ruidoso.`)
  if (skill !== null && skill <= 0 && n >= 30) warnings.push('Habilidade ≤ 0: suas probabilidades não superam simplesmente prever a taxa-base.')

  return {
    resolved: n,
    open: entries.filter(e => e.status === 'open').length,
    brier,
    brierBaseline: baseline,
    brierSkill: skill,
    logLoss: logLoss(forecasts, outcomes),
    baseRate,
    directionalHitRate: directional.length ? hits / directional.length : null,
    avgExcessReturnPctBuy: avg(resolved.filter(e => e.action === 'buy')),
    avgExcessReturnPctSell: avg(resolved.filter(e => e.action === 'sell')),
    bins: reliabilityBins(forecasts, outcomes),
    warnings,
  }
}
