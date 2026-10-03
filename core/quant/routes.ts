// Rotas HTTP da camada quantitativa (registradas no app Hono principal).

import * as fs from 'fs'
import * as path from 'path'
import type { Context, Hono, Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { syncCvmFundamentals, type CvmSyncOptions, type CvmSyncResult } from './cvm.ts'
import type { MarketData } from './data.ts'
import {
  FundamentalsHistory,
  deserializeFundamentals,
  parseFundamentalsCsv,
  serializeFundamentals,
} from './fundamentals.ts'
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
import { DEFAULT_DIVIDEND_RULES, DEFAULT_TAX_RULES, computeTaxReport, dividendNet, jcpNet } from './tax.ts'
import { SECTOR_BY_TICKER, UniverseHistory, parseUniverseHistoryCsv, normalizeTicker } from './universe.ts'
import { z } from 'zod'

const TICKER_RE = /^[A-Z0-9]{4,6}\.[A-Z]{2}$/
const METHODS: ConstructionMethod[] = ['hrp', 'erc', 'ivol', 'minvar', 'meanvar', 'bl']

/** Escrita atômica: grava em arquivo temporário e renomeia (nunca deixa o arquivo pela metade). */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

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
    if (this.file) writeFileAtomic(this.file, JSON.stringify(ips, null, 2))
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

export type PitSource = 'cvm' | 'csv'

/** Carrega os fundamentos PIT salvos: JSON (CVM) tem prioridade sobre o CSV enviado pelo usuário. */
export function loadPit(dir: string): { history: FundamentalsHistory | null; source: PitSource | null } {
  try {
    const jsonFile = path.join(dir, 'fundamentals_pit.json')
    if (fs.existsSync(jsonFile)) {
      const rows = deserializeFundamentals(fs.readFileSync(jsonFile, 'utf8'))
      if (rows.length > 0) return { history: new FundamentalsHistory(rows), source: 'cvm' }
    }
    const csvFile = path.join(dir, 'fundamentals_pit.csv')
    if (fs.existsSync(csvFile)) {
      const { rows } = parseFundamentalsCsv(fs.readFileSync(csvFile, 'utf8'))
      if (rows.length > 0) return { history: new FundamentalsHistory(rows), source: 'csv' }
    }
  } catch {
    // arquivo ilegível: segue sem PIT (o backtest avisa que valor/qualidade não entram)
  }
  return { history: null, source: null }
}

export function loadUniverseHistory(dir: string): UniverseHistory | null {
  try {
    const file = path.join(dir, 'universe_history.csv')
    if (!fs.existsSync(file)) return null
    const { ranges } = parseUniverseHistoryCsv(fs.readFileSync(file, 'utf8'))
    return ranges.length > 0 ? new UniverseHistory(ranges) : null
  } catch {
    return null
  }
}

/** Compatível com a versão anterior: só o histórico (sem a origem). */
export function loadPitFile(file: string): FundamentalsHistory | null {
  return loadPit(path.dirname(file)).history
}

export interface QuantRouteDeps {
  service: QuantService
  data: MarketData
  journal: Journal
  ipsStore: IpsStore
  riskFreeAnnual: number
  dataDir: string
  /** Tickers do universo (para a sincronização com a CVM). */
  cvmTickers?: Array<{ ticker: string; isFinancial?: boolean }>
  /** Injetável para testes (default: download real dos dados abertos da CVM). */
  cvmSync?: (options: CvmSyncOptions) => Promise<CvmSyncResult>
  /** Hook para o serviço usar fundamentos ponto-no-tempo carregados. */
  onPitChange?: (history: FundamentalsHistory | null) => void
  onUniverseHistoryChange?: (history: UniverseHistory | null) => void
  /** Origens extras aceitas em escritas (além de mesma origem). */
  allowedOrigins?: string[]
  log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = Number(raw)
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

/**
 * Defesa contra CSRF nas rotas que gravam estado: o CORS do app é aberto (`*`), então um site qualquer poderia
 * enviar PUT/POST/DELETE com o navegador do usuário. Navegadores informam `Sec-Fetch-Site`; sem ele, comparamos
 * `Origin` com `Host`. Clientes sem navegador (curl, bot do Telegram) não enviam nenhum dos dois e passam.
 */
export function crossSiteWriteGuard(allowedOrigins: string[] = []) {
  return async (c: Context, next: Next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')
    let blocked = false
    if (site) {
      blocked = site !== 'same-origin' && site !== 'none'
      if (blocked && origin && allowedOrigins.includes(origin)) blocked = false
    } else if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = origin
      }
      blocked = originHost !== c.req.header('host') && !allowedOrigins.includes(origin)
    }
    if (blocked) return c.json({ error: 'Escritas de outra origem não são permitidas', code: 'CROSS_SITE_BLOCKED' }, 403)
    return next()
  }
}

const tradeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ticker: z.string().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  qty: z.number().positive(),
  price: z.number().positive(),
  fees: z.number().min(0).optional(),
  kind: z.enum(['acao', 'etf', 'fii']).optional(),
})
const taxRequestSchema = z.object({ trades: z.array(tradeSchema).min(1).max(20000) })

export function registerQuantRoutes(app: Hono, deps: QuantRouteDeps): void {
  const { service, journal, ipsStore, log } = deps
  const fail = (c: any, error: any, code: string, status = 500) => {
    log('error', `${code}: ${error?.message ?? error}`)
    return c.json({ error: error?.message ?? String(error), code }, status)
  }
  const tooLarge = (c: Context) => c.json({ error: 'Payload grande demais', code: 'PAYLOAD_TOO_LARGE' }, 413)

  const guard = crossSiteWriteGuard(deps.allowedOrigins)
  for (const prefix of ['/api/ips', '/api/journal', '/api/fundamentals', '/api/universe', '/api/tax']) {
    app.use(prefix, guard)
    app.use(`${prefix}/*`, guard)
  }
  app.use('/api/ips', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }))
  app.use('/api/journal', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }))
  app.use('/api/fundamentals/*', bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge }))
  app.use('/api/universe/*', bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }))
  app.use('/api/tax/*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooLarge }))

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

  // ---- Fundamentos ponto-no-tempo: CSV próprio ou sincronização com a CVM ----
  const csvFile = path.join(deps.dataDir, 'fundamentals_pit.csv')
  const jsonFile = path.join(deps.dataDir, 'fundamentals_pit.json')
  let cvmSyncing = false

  app.put('/api/fundamentals/pit', async c => {
    try {
      const text = await c.req.text()
      const { rows, rejected } = parseFundamentalsCsv(text)
      if (rows.length === 0) return c.json({ error: 'Nenhuma linha válida (exige ticker, asOf e availableAt, com availableAt >= asOf)', rejected, code: 'PIT_INVALID' }, 400)
      writeFileAtomic(csvFile, text)
      if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile) // uma única fonte ativa: o CSV enviado substitui a da CVM
      deps.onPitChange?.(new FundamentalsHistory(rows))
      return c.json({ rows: rows.length, rejected, tickers: new Set(rows.map(r => r.ticker)).size, source: 'csv' })
    } catch (error: any) {
      return c.json({ error: error.message, code: 'PIT_INVALID' }, 400)
    }
  })

  app.post('/api/fundamentals/cvm/sync', async c => {
    if (!deps.cvmTickers) return c.json({ error: 'Universo não configurado para a CVM', code: 'CVM_NOT_CONFIGURED' }, 501)
    if (cvmSyncing) return c.json({ error: 'Sincronização já em andamento', code: 'CVM_BUSY' }, 409)
    const body = (await c.req.json().catch(() => ({}))) as { from?: number; to?: number }
    const thisYear = new Date().getFullYear()
    const to = Math.min(thisYear, Math.max(2010, Math.round(Number(body.to ?? thisYear))))
    const from = Math.min(to, Math.max(2010, Math.round(Number(body.from ?? to - 7))))
    cvmSyncing = true
    try {
      const years = Array.from({ length: to - from + 1 }, (_, i) => from + i)
      const result = await (deps.cvmSync ?? syncCvmFundamentals)({
        years,
        tickers: deps.cvmTickers,
        log: (message, data) => log('info', message, data),
      })
      if (result.rows.length === 0) {
        return c.json({ error: 'Nenhum dado utilizável da CVM (rede indisponível ou formato inesperado)', failedYears: result.failedYears, unmapped: result.unmapped, code: 'CVM_NO_DATA' }, 502)
      }
      writeFileAtomic(jsonFile, serializeFundamentals(result.rows))
      if (fs.existsSync(csvFile)) fs.unlinkSync(csvFile) // a fonte da CVM substitui o CSV anterior
      deps.onPitChange?.(new FundamentalsHistory(result.rows))
      return c.json({
        source: 'cvm',
        rows: result.rows.length,
        docs: result.docsUsed,
        tickers: new Set(result.rows.map(r => r.ticker)).size,
        years,
        failedYears: result.failedYears,
        unmapped: result.unmapped,
        note: 'Só demonstrações anuais (DFP); formato não validado contra o download real neste ambiente — confira algumas empresas.',
      })
    } catch (error) {
      return fail(c, error, 'CVM_SYNC_ERROR', 502)
    } finally {
      cvmSyncing = false
    }
  })

  app.get('/api/fundamentals/pit', c => {
    const { history, source } = loadPit(deps.dataDir)
    return c.json({
      loaded: history !== null,
      source,
      rows: history?.rowCount() ?? 0,
      tickers: history?.tickers().length ?? 0,
      syncing: cvmSyncing,
    })
  })

  // ---- Universo histórico (entradas/saídas) ----
  const universeFile = path.join(deps.dataDir, 'universe_history.csv')

  app.put('/api/universe/history', async c => {
    try {
      const text = await c.req.text()
      const { ranges, rejected } = parseUniverseHistoryCsv(text)
      if (ranges.length === 0) return c.json({ error: 'Nenhum intervalo válido (colunas ticker,from,to)', rejected, code: 'UNIVERSE_INVALID' }, 400)
      writeFileAtomic(universeFile, text)
      const history = new UniverseHistory(ranges)
      deps.onUniverseHistoryChange?.(history)
      return c.json({ ranges: ranges.length, rejected, tickers: history.tickers().map(normalizeTicker) })
    } catch (error: any) {
      return c.json({ error: error.message, code: 'UNIVERSE_INVALID' }, 400)
    }
  })

  app.get('/api/universe/history', c => {
    const history = loadUniverseHistory(deps.dataDir)
    return c.json({ loaded: history !== null, tickers: history?.tickers() ?? [] })
  })

  app.delete('/api/universe/history', c => {
    if (fs.existsSync(universeFile)) fs.unlinkSync(universeFile)
    deps.onUniverseHistoryChange?.(null)
    return c.json({ success: true })
  })

  app.get('/api/universe', c => c.json({ sectors: SECTOR_BY_TICKER }))

  // ---- IR sobre operações reais (calculadora; não é orientação fiscal) ----
  app.post('/api/tax/report', async c => {
    const parsed = taxRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Operações inválidas', issues: parsed.error.issues.slice(0, 5), code: 'TAX_INVALID' }, 400)
    const report = computeTaxReport(parsed.data.trades.map(t => ({ ...t, ticker: t.ticker.toUpperCase() })))
    return c.json({
      ...report,
      disclaimer: 'Calculadora educacional baseada em regras simplificadas e configuráveis; confira com a Receita Federal ou um contador.',
    })
  })

  app.get('/api/tax/rules', c => c.json({ trading: DEFAULT_TAX_RULES, proventos: DEFAULT_DIVIDEND_RULES }))

  app.get('/api/tax/proventos', c => {
    const jcp = num(c.req.query('jcp'), 0, 0, 1e12)
    const dividendos = num(c.req.query('dividendos'), 0, 0, 1e12)
    return c.json({ jcp: jcpNet(jcp), dividendos: dividendNet(dividendos) })
  })
}
