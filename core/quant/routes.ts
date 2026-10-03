// Rotas HTTP da camada quantitativa (registradas no app Hono principal).

import * as fs from 'fs'
import * as path from 'path'
import type { Hono } from 'hono'
import type { MarketData } from './data.ts'
import { FundamentalsHistory, parseFundamentalsCsv } from './fundamentals.ts'
import { type Ips, ipsSchema, deriveConstraints } from './ips.ts'
import {
  type JournalEntry,
  Journal,
  type PriceLookup,
  calibrationReport,
  journalInputSchema,
} from './journal.ts'
import type { ConstructionMethod } from './portfolio.ts'
import type { QuantService } from './service.ts'
import { SECTOR_BY_TICKER } from './universe.ts'

const TICKER_RE = /^[A-Z0-9]{4,6}\.[A-Z]{2}$/
const METHODS: ConstructionMethod[] = ['hrp', 'erc', 'ivol', 'minvar', 'meanvar']

export class IpsStore {
  private ips: Ips | null = null

  constructor(private readonly file: string | null = null) {
    try {
      if (file && fs.existsSync(file)) {
        const parsed = ipsSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
        if (parsed.success) this.ips = parsed.data
      }
    } catch {
      this.ips = null
    }
  }

  get(): Ips | null {
    return this.ips
  }

  set(ips: Ips): void {
    this.ips = ips
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(ips, null, 2))
  }

  clear(): void {
    this.ips = null
    if (this.file && fs.existsSync(this.file)) fs.unlinkSync(this.file)
  }
}

/** Resolve previsões vencidas com preços ajustados do Yahoo e retorno do benchmark (ou CDI constante). */
export function createJournalLookup(data: MarketData, riskFreeAnnual: number): PriceLookup {
  return async (entry: JournalEntry, now: Date) => {
    const years = Math.max(1, (now.getTime() - new Date(entry.createdAt).getTime()) / (365.25 * 864e5) + 0.2)
    const [series, bench] = await Promise.all([data.priceSeries(entry.ticker, years), data.benchmarkSeries(years)])
    if (!series) return null
    const startDate = entry.createdAt.slice(0, 10)
    const dueDate = entry.dueAt.slice(0, 10)
    const at = (dates: string[], closes: Array<number | null>, date: string, dir: 'on-or-before' | 'on-or-after') => {
      if (dir === 'on-or-before') {
        for (let i = dates.length - 1; i >= 0; i--) if ((dates[i] as string) <= date && typeof closes[i] === 'number') return { i, price: closes[i] as number }
      } else {
        for (let i = 0; i < dates.length; i++) if ((dates[i] as string) >= date && typeof closes[i] === 'number') return { i, price: closes[i] as number }
      }
      return null
    }
    const entryPx = at(series.dates, series.closes, startDate, 'on-or-before')
    const exitPx = at(series.dates, series.closes, dueDate, 'on-or-after')
    if (!entryPx || !exitPx || exitPx.i <= entryPx.i) return null

    let referenceReturn: number
    const b0 = bench ? at(bench.dates, bench.closes, startDate, 'on-or-before') : null
    const b1 = bench ? at(bench.dates, bench.closes, series.dates[exitPx.i] as string, 'on-or-before') : null
    if (b0 && b1 && b1.i > b0.i) referenceReturn = b1.price / b0.price - 1
    else {
      const days = (new Date(series.dates[exitPx.i] as string).getTime() - new Date(series.dates[entryPx.i] as string).getTime()) / 864e5
      referenceReturn = (1 + riskFreeAnnual) ** (days / 365) - 1
    }
    return { exitPrice: exitPx.price, entryPrice: entryPx.price, referenceReturn }
  }
}

/** Carrega o CSV ponto-no-tempo salvo (se existir e for válido). */
export function loadPitFile(file: string): FundamentalsHistory | null {
  try {
    if (!fs.existsSync(file)) return null
    const { rows } = parseFundamentalsCsv(fs.readFileSync(file, 'utf8'))
    return rows.length > 0 ? new FundamentalsHistory(rows) : null
  } catch {
    return null
  }
}

export interface QuantRouteDeps {
  service: QuantService
  data: MarketData
  journal: Journal
  ipsStore: IpsStore
  riskFreeAnnual: number
  dataDir: string
  /** Hook para o serviço usar fundamentos ponto-no-tempo carregados. */
  onPitChange?: (history: FundamentalsHistory | null) => void
  log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = Number(raw)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

export function registerQuantRoutes(app: Hono, deps: QuantRouteDeps): void {
  const { service, journal, ipsStore, log } = deps
  const fail = (c: any, error: any, code: string, status = 500) => {
    log('error', `${code}: ${error?.message ?? error}`)
    return c.json({ error: error?.message ?? String(error), code }, status)
  }

  app.get('/api/factors', async c => {
    try {
      const table = await service.getFactorTable()
      if (!table) return c.json({ error: 'Dados de mercado indisponíveis para calcular fatores', code: 'FACTORS_NO_DATA' }, 503)
      return c.json(table)
    } catch (error) {
      return fail(c, error, 'FACTORS_ERROR')
    }
  })

  app.get('/api/backtest', async c => {
    try {
      const report = await service.runBacktests({
        years: num(c.req.query('years'), 8, 3, 15),
        topN: Math.round(num(c.req.query('topN'), 8, 3, 20)),
        costs: c.req.query('costs') !== '0',
        tax: c.req.query('tax') !== '0',
      })
      if (!report) return c.json({ error: 'Dados insuficientes para o backtest', code: 'BACKTEST_NO_DATA' }, 503)
      return c.json(report)
    } catch (error) {
      return fail(c, error, 'BACKTEST_ERROR')
    }
  })

  app.get('/api/valuation/:ticker', async c => {
    const ticker = c.req.param('ticker').toUpperCase()
    if (!TICKER_RE.test(ticker)) return c.json({ error: 'Invalid ticker format', code: 'INVALID_TICKER' }, 400)
    try {
      const result = await service.valuation(ticker)
      if (!result) return c.json({ error: 'Fundamentos indisponíveis', code: 'VALUATION_NO_DATA' }, 404)
      return c.json({ ...result, generatedAt: new Date().toISOString() })
    } catch (error) {
      return fail(c, error, 'VALUATION_ERROR')
    }
  })

  app.get('/api/portfolio/construct', async c => {
    try {
      const methodParam = (c.req.query('method') ?? '').toLowerCase()
      const ips = ipsStore.get()
      const constraints = ips ? deriveConstraints(ips) : null
      const method = (METHODS as string[]).includes(methodParam) ? (methodParam as ConstructionMethod) : (constraints?.method ?? 'hrp')
      const report = await service.construct({
        method,
        maxWeight: num(c.req.query('maxWeight'), constraints?.maxWeight ?? 0.15, 0.03, 1),
        maxSector: num(c.req.query('maxSector'), constraints?.maxSector ?? 0.35, 0.1, 1),
        lookbackDays: Math.round(num(c.req.query('lookback'), 504, 120, 1008)),
        includeStress: c.req.query('stress') === '1',
        ips,
      })
      if (!report) return c.json({ error: 'Dados insuficientes para construir a carteira', code: 'CONSTRUCT_NO_DATA' }, 503)
      return c.json(report)
    } catch (error) {
      return fail(c, error, 'CONSTRUCT_ERROR')
    }
  })

  // ---- IPS ----
  app.get('/api/ips', c => {
    const ips = ipsStore.get()
    return c.json({ ips, constraints: ips ? deriveConstraints(ips) : null })
  })

  app.put('/api/ips', async c => {
    const parsed = ipsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'IPS inválido', issues: parsed.error.issues, code: 'IPS_INVALID' }, 400)
    ipsStore.set(parsed.data)
    return c.json({ ips: parsed.data, constraints: deriveConstraints(parsed.data) })
  })

  app.delete('/api/ips', c => {
    ipsStore.clear()
    return c.json({ success: true })
  })

  // ---- Diário e calibração ----
  app.get('/api/journal', c => c.json({ entries: journal.list(), calibration: calibrationReport(journal.list()) }))

  app.post('/api/journal', async c => {
    const parsed = journalInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Entrada inválida', issues: parsed.error.issues, code: 'JOURNAL_INVALID' }, 400)
    return c.json(journal.add(parsed.data), 201)
  })

  app.delete('/api/journal/:id', c => {
    return journal.remove(c.req.param('id')) ? c.json({ success: true }) : c.json({ error: 'Not found', code: 'JOURNAL_NOT_FOUND' }, 404)
  })

  app.post('/api/journal/resolve', async c => {
    try {
      const resolved = await journal.resolveDue(createJournalLookup(deps.data, deps.riskFreeAnnual))
      return c.json({ resolved: resolved.length, calibration: calibrationReport(journal.list()) })
    } catch (error) {
      return fail(c, error, 'JOURNAL_RESOLVE_ERROR')
    }
  })

  app.get('/api/journal/calibration', c => c.json(calibrationReport(journal.list())))

  // ---- Fundamentos ponto-no-tempo (CSV do próprio usuário) ----
  const pitFile = path.join(deps.dataDir, 'fundamentals_pit.csv')

  app.put('/api/fundamentals/pit', async c => {
    try {
      const text = await c.req.text()
      const { rows, rejected } = parseFundamentalsCsv(text)
      if (rows.length === 0) return c.json({ error: 'Nenhuma linha válida (exige ticker, asOf e availableAt)', rejected, code: 'PIT_INVALID' }, 400)
      fs.mkdirSync(deps.dataDir, { recursive: true })
      fs.writeFileSync(pitFile, text)
      deps.onPitChange?.(new FundamentalsHistory(rows))
      return c.json({ rows: rows.length, rejected, tickers: new Set(rows.map(r => r.ticker)).size })
    } catch (error: any) {
      return c.json({ error: error.message, code: 'PIT_INVALID' }, 400)
    }
  })

  app.get('/api/fundamentals/pit', c => {
    return c.json({ loaded: fs.existsSync(pitFile), file: fs.existsSync(pitFile) ? path.basename(pitFile) : null })
  })

  app.get('/api/universe', c => c.json({ sectors: SECTOR_BY_TICKER }))
}
