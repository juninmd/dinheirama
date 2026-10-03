// Fundamentos: modelo de dados, parsers defensivos, Graham, Piotroski e Magic Formula.
// Referências: Graham (O Investidor Inteligente), Piotroski (2000), Greenblatt (A Fórmula Mágica).
//
// ATENÇÃO (look-ahead): o snapshot do Yahoo reflete o presente, não o que era público em datas
// passadas. Para backtest de fatores fundamentalistas use `FundamentalsHistory` com dados
// ponto-no-tempo (coluna `availableAt` = data de divulgação).

export interface StatementYear {
  endDate?: string
  revenue: number | null
  grossProfit: number | null
  netIncome: number | null
  ebit: number | null
  totalAssets: number | null
  currentAssets: number | null
  currentLiabilities: number | null
  longTermDebt: number | null
  sharesOutstanding: number | null
  operatingCashFlow: number | null
  capex: number | null
  equity: number | null
  /** Campos opcionais (presentes quando a fonte os fornece, ex.: CVM). */
  cash?: number | null
  shortTermDebt?: number | null
  dividendsPaid?: number | null
  depreciation?: number | null
}

export interface Fundamentals {
  ticker: string
  /** Data de referência do dado. */
  asOf: string
  /** Data em que o dado se tornou público (ponto-no-tempo). Ausente em snapshots atuais. */
  availableAt?: string
  isFinancial?: boolean
  price: number | null
  marketCap: number | null
  enterpriseValue: number | null
  trailingPE: number | null
  priceToBook: number | null
  eps: number | null
  bookValuePerShare: number | null
  /** Fração (0.06 = 6%). */
  dividendYield: number | null
  payoutRatio: number | null
  roe: number | null
  ebit: number | null
  ebitda: number | null
  netDebt: number | null
  currentRatio: number | null
  debtToEquity: number | null
  freeCashFlow: number | null
  operatingMargin: number | null
  grossMargin: number | null
  revenueGrowth: number | null
  earningsGrowth: number | null
  beta: number | null
  /** Ações em circulação (sem tesouraria). Se presente, os múltiplos podem ser recalculados a qualquer preço (`repriceFundamentals`). */
  shares?: number | null
  /** Demonstrações anuais, mais recente primeiro. */
  statements: StatementYear[]
}

export const EMPTY_STATEMENT: StatementYear = {
  revenue: null, grossProfit: null, netIncome: null, ebit: null, totalAssets: null, currentAssets: null,
  currentLiabilities: null, longTermDebt: null, sharesOutstanding: null, operatingCashFlow: null, capex: null, equity: null,
}

type Loose = Record<string, any> | null | undefined

/** Número ou null; aceita {raw: n} (formato Yahoo) e descarta NaN/Infinity. */
export function num(value: unknown): number | null {
  if (value && typeof value === 'object' && 'raw' in (value as object)) return num((value as { raw: unknown }).raw)
  if (typeof value === 'string' && value.trim() !== '') value = Number(value)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Primeiro campo presente entre variantes de nome (com/sem prefixo `annual`/`trailing`). */
function pick(row: Loose, ...names: string[]): number | null {
  if (!row) return null
  for (const name of names) {
    for (const key of [name, `annual${name[0]!.toUpperCase()}${name.slice(1)}`, `trailing${name[0]!.toUpperCase()}${name.slice(1)}`]) {
      const v = num(row[key])
      if (v !== null) return v
    }
  }
  return null
}

function dateOf(row: Loose): string | undefined {
  const d = row?.date ?? row?.endDate
  if (!d) return undefined
  // Yahoo sem validação devolve segundos Unix (número ou {raw}); com validação, Date
  const fromSeconds = (n: number) => new Date(n * 1000)
  const date =
    d instanceof Date ? d
    : typeof d === 'number' ? (d < 1e11 ? fromSeconds(d) : new Date(d))
    : typeof d === 'object' && 'raw' in d ? fromSeconds(Number(d.raw))
    : new Date(d)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}

/** Converte uma linha de fundamentalsTimeSeries (anual) em StatementYear. */
export function parseStatementRow(row: Loose): StatementYear {
  const capex = pick(row, 'capitalExpenditure', 'capitalExpenditures')
  return {
    endDate: dateOf(row),
    revenue: pick(row, 'totalRevenue', 'operatingRevenue'),
    grossProfit: pick(row, 'grossProfit'),
    netIncome: pick(row, 'netIncome', 'netIncomeCommonStockholders'),
    ebit: pick(row, 'EBIT', 'ebit', 'operatingIncome'),
    totalAssets: pick(row, 'totalAssets'),
    currentAssets: pick(row, 'currentAssets', 'totalCurrentAssets'),
    currentLiabilities: pick(row, 'currentLiabilities', 'totalCurrentLiabilities'),
    longTermDebt: pick(row, 'longTermDebt', 'longTermDebtAndCapitalLeaseObligation'),
    sharesOutstanding: pick(row, 'ordinarySharesNumber', 'shareIssued', 'sharesOutstanding'),
    operatingCashFlow: pick(row, 'operatingCashFlow', 'totalCashFromOperatingActivities'),
    capex: capex === null ? null : Math.abs(capex),
    equity: pick(row, 'stockholdersEquity', 'totalStockholderEquity', 'commonStockEquity'),
  }
}

/**
 * Monta Fundamentals a partir de respostas do Yahoo (quoteSummary + fundamentalsTimeSeries).
 * Defensivo: campos ausentes viram null; nunca lança por formato inesperado.
 */
export function parseYahooFundamentals(
  ticker: string,
  summary: Loose,
  timeSeries: Loose[] | null | undefined,
  opts: { isFinancial?: boolean; asOf?: string } = {}
): Fundamentals {
  const fd = summary?.financialData as Loose
  const ks = summary?.defaultKeyStatistics as Loose
  const sd = summary?.summaryDetail as Loose
  const pr = summary?.price as Loose

  const statements = (timeSeries ?? [])
    .map(parseStatementRow)
    .filter(s => s.endDate)
    .sort((a, b) => (b.endDate as string).localeCompare(a.endDate as string))

  const price = num(fd?.currentPrice) ?? num(pr?.regularMarketPrice)
  const marketCap = num(sd?.marketCap) ?? num(pr?.marketCap)
  const totalDebt = num(fd?.totalDebt)
  const totalCash = num(fd?.totalCash)
  const netDebt = totalDebt !== null && totalCash !== null ? totalDebt - totalCash : null
  const ebitda = num(fd?.ebitda)
  const latest = statements[0]

  return {
    ticker,
    asOf: opts.asOf ?? new Date().toISOString().slice(0, 10),
    isFinancial: opts.isFinancial,
    price,
    marketCap,
    enterpriseValue: num(ks?.enterpriseValue) ?? (marketCap !== null && netDebt !== null ? marketCap + netDebt : null),
    trailingPE: num(sd?.trailingPE),
    priceToBook: num(ks?.priceToBook),
    eps: num(ks?.trailingEps),
    bookValuePerShare: num(ks?.bookValue),
    dividendYield: num(sd?.dividendYield) ?? num(sd?.trailingAnnualDividendYield),
    payoutRatio: num(sd?.payoutRatio),
    roe: num(fd?.returnOnEquity),
    ebit: latest?.ebit ?? null,
    ebitda,
    netDebt,
    currentRatio: num(fd?.currentRatio),
    // Yahoo reporta dívida/patrimônio em % (ex.: 85 = 0,85x).
    debtToEquity: num(fd?.debtToEquity) !== null ? (num(fd?.debtToEquity) as number) / 100 : null,
    freeCashFlow: num(fd?.freeCashflow),
    operatingMargin: num(fd?.operatingMargins),
    grossMargin: num(fd?.grossMargins),
    revenueGrowth: num(fd?.revenueGrowth),
    earningsGrowth: num(fd?.earningsGrowth),
    beta: num(sd?.beta) ?? num(ks?.beta),
    statements,
  }
}

// ---- Métricas derivadas ---------------------------------------------------

export interface DerivedMetrics {
  earningsYield: number | null
  bookToPrice: number | null
  fcfYield: number | null
  dividendYield: number | null
  roe: number | null
  roic: number | null
  operatingMargin: number | null
  netDebtToEbitda: number | null
  piotroski: PiotroskiResult | null
}

const BR_TAX_RATE = 0.34

/** ROIC aproximado = EBIT*(1-34%) / (patrimônio + dívida líquida). Aproximação declarada. */
export function approxRoic(f: Fundamentals): number | null {
  const equity = f.statements[0]?.equity ?? (f.bookValuePerShare !== null && f.marketCap !== null && f.price ? (f.bookValuePerShare * f.marketCap) / f.price : null)
  if (f.ebit === null || equity === null || f.netDebt === null) return null
  const invested = equity + f.netDebt
  return invested > 0 ? (f.ebit * (1 - BR_TAX_RATE)) / invested : null
}

export function deriveMetrics(f: Fundamentals): DerivedMetrics {
  const financial = f.isFinancial === true
  const earningsYield = !financial && f.ebit !== null && f.enterpriseValue && f.enterpriseValue > 0
    ? f.ebit / f.enterpriseValue
    : f.trailingPE && f.trailingPE > 0 ? 1 / f.trailingPE : null
  return {
    earningsYield,
    bookToPrice: f.priceToBook && f.priceToBook > 0 ? 1 / f.priceToBook : null,
    fcfYield: !financial && f.freeCashFlow !== null && f.marketCap && f.marketCap > 0 ? f.freeCashFlow / f.marketCap : null,
    dividendYield: f.dividendYield,
    roe: f.roe,
    roic: financial ? null : approxRoic(f),
    operatingMargin: financial ? null : f.operatingMargin,
    netDebtToEbitda: !financial && f.netDebt !== null && f.ebitda && f.ebitda > 0 ? f.netDebt / f.ebitda : null,
    piotroski: piotroskiFScore(f),
  }
}

// ---- Graham ----------------------------------------------------------------

/** Número de Graham = sqrt(22,5 × LPA × VPA). */
export function grahamNumber(eps: number | null, bvps: number | null): number | null {
  if (eps === null || bvps === null || eps <= 0 || bvps <= 0) return null
  return Math.sqrt(22.5 * eps * bvps)
}

/** Margem de segurança sobre o número de Graham: (valor - preço) / valor. */
export function grahamMarginOfSafety(f: Fundamentals): number | null {
  const gn = grahamNumber(f.eps, f.bookValuePerShare)
  if (gn === null || f.price === null || f.price <= 0) return null
  return (gn - f.price) / gn
}

export interface GrahamCriterion {
  name: string
  passed: boolean | null
  detail: string
}

export interface GrahamDefensiveResult {
  passed: number
  evaluated: number
  total: number
  criteria: GrahamCriterion[]
}

/** Critérios do investidor defensivo (adaptados ao que há de dado). Critérios sem dado ficam fora da contagem. */
export function grahamDefensive(f: Fundamentals): GrahamDefensiveResult {
  const criteria: GrahamCriterion[] = []
  const add = (name: string, passed: boolean | null, detail: string) => criteria.push({ name, passed, detail })
  const fmt = (v: number | null, d = 2) => (v === null ? 'n/d' : v.toFixed(d))

  add('Liquidez corrente ≥ 2', f.currentRatio === null ? null : f.currentRatio >= 2, `liquidez corrente ${fmt(f.currentRatio)}`)

  const incomes = f.statements.map(s => s.netIncome).filter((v): v is number => v !== null)
  add(
    'Lucro positivo em todos os anos disponíveis',
    incomes.length >= 3 ? incomes.every(v => v > 0) : null,
    incomes.length >= 3 ? `${incomes.length} anos` : 'histórico insuficiente (<3 anos)'
  )

  add('Pagou dividendos', f.dividendYield === null ? null : f.dividendYield > 0, `DY ${f.dividendYield === null ? 'n/d' : (f.dividendYield * 100).toFixed(1) + '%'}`)

  const s0 = f.statements[0]
  const wc = s0?.currentAssets != null && s0?.currentLiabilities != null ? s0.currentAssets - s0.currentLiabilities : null
  add(
    'Dívida de longo prazo ≤ capital circulante líquido',
    wc !== null && s0?.longTermDebt != null ? s0.longTermDebt <= wc : null,
    wc !== null ? `CCL ${fmt(wc, 0)}` : 'n/d'
  )

  add('P/L ≤ 15', f.trailingPE === null || f.trailingPE <= 0 ? null : f.trailingPE <= 15, `P/L ${fmt(f.trailingPE, 1)}`)

  const pePb = f.trailingPE && f.priceToBook && f.trailingPE > 0 && f.priceToBook > 0 ? f.trailingPE * f.priceToBook : null
  add('P/L × P/VPA ≤ 22,5', pePb === null ? null : pePb <= 22.5, `P/L×P/VPA ${fmt(pePb, 1)}`)

  const evaluated = criteria.filter(c => c.passed !== null)
  return { passed: evaluated.filter(c => c.passed).length, evaluated: evaluated.length, total: criteria.length, criteria }
}

// ---- Piotroski F-Score -----------------------------------------------------

export interface PiotroskiResult {
  score: number
  available: number
  /** score normalizado para 0..9 considerando só critérios avaliáveis. */
  scaled: number
  details: Array<{ name: string; passed: boolean | null }>
}

/** Piotroski (2000): 9 sinais binários de rentabilidade, alavancagem/liquidez e eficiência. */
export function piotroskiFScore(f: Fundamentals): PiotroskiResult | null {
  const cur = f.statements[0]
  const prev = f.statements[1]
  if (!cur) return null

  const div = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? a / b : null)
  const roa = div(cur.netIncome, cur.totalAssets)
  const roaPrev = prev ? div(prev.netIncome, prev.totalAssets) : null
  const cfoOverAssets = div(cur.operatingCashFlow, cur.totalAssets)
  const levCur = div(cur.longTermDebt, cur.totalAssets)
  const levPrev = prev ? div(prev.longTermDebt, prev.totalAssets) : null
  const crCur = div(cur.currentAssets, cur.currentLiabilities)
  const crPrev = prev ? div(prev.currentAssets, prev.currentLiabilities) : null
  const gmCur = div(cur.grossProfit, cur.revenue)
  const gmPrev = prev ? div(prev.grossProfit, prev.revenue) : null
  const atCur = div(cur.revenue, cur.totalAssets)
  const atPrev = prev ? div(prev.revenue, prev.totalAssets) : null

  const cmp = (a: number | null, b: number | null, op: (x: number, y: number) => boolean): boolean | null =>
    a !== null && b !== null ? op(a, b) : null

  const details: PiotroskiResult['details'] = [
    { name: 'ROA > 0', passed: roa === null ? null : roa > 0 },
    { name: 'Fluxo de caixa operacional > 0', passed: cur.operatingCashFlow === null ? null : cur.operatingCashFlow > 0 },
    { name: 'ROA crescente', passed: cmp(roa, roaPrev, (x, y) => x > y) },
    { name: 'Caixa operacional/ativos > ROA (qualidade dos lucros)', passed: cmp(cfoOverAssets, roa, (x, y) => x > y) },
    { name: 'Alavancagem de longo prazo menor', passed: cmp(levCur, levPrev, (x, y) => x < y) },
    { name: 'Liquidez corrente maior', passed: cmp(crCur, crPrev, (x, y) => x > y) },
    { name: 'Sem diluição (ações não aumentaram)', passed: prev ? cmp(cur.sharesOutstanding, prev.sharesOutstanding, (x, y) => x <= y * 1.001) : null },
    { name: 'Margem bruta maior', passed: cmp(gmCur, gmPrev, (x, y) => x > y) },
    { name: 'Giro do ativo maior', passed: cmp(atCur, atPrev, (x, y) => x > y) },
  ]
  const evaluated = details.filter(d => d.passed !== null)
  if (evaluated.length < 4) return null
  const score = evaluated.filter(d => d.passed).length
  return { score, available: evaluated.length, scaled: (score / evaluated.length) * 9, details }
}


// ---- Recomposição a partir de demonstrações (CVM) e re-precificação -------------------------------

export interface StatementsBase {
  ticker: string
  asOf: string
  availableAt?: string
  isFinancial?: boolean
}

const growth = (cur: number | null | undefined, prev: number | null | undefined) =>
  cur != null && prev != null && prev > 0 ? cur / prev - 1 : null

/**
 * Monta Fundamentals a partir de demonstrações anuais (mais recente primeiro) e do nº de ações.
 * Campos que dependem do preço ficam nulos até `repriceFundamentals`.
 */
export function buildFundamentalsFromStatements(base: StatementsBase, statements: StatementYear[], shares: number | null): Fundamentals {
  const cur = statements[0]
  const prev = statements[1]
  const debt = (cur?.shortTermDebt ?? 0) + (cur?.longTermDebt ?? 0)
  const hasDebt = cur?.shortTermDebt != null || cur?.longTermDebt != null
  const netDebt = hasDebt && cur?.cash != null ? debt - cur.cash : null
  const ebitda = cur?.ebit != null && cur?.depreciation != null ? cur.ebit + Math.abs(cur.depreciation) : null
  const fcf = cur?.operatingCashFlow != null && cur?.capex != null ? cur.operatingCashFlow - cur.capex : null
  const positiveShares = shares && shares > 0 ? shares : null
  return {
    ticker: base.ticker,
    asOf: base.asOf,
    availableAt: base.availableAt,
    isFinancial: base.isFinancial,
    price: null,
    marketCap: null,
    enterpriseValue: null,
    trailingPE: null,
    priceToBook: null,
    eps: positiveShares && cur?.netIncome != null ? cur.netIncome / positiveShares : null,
    bookValuePerShare: positiveShares && cur?.equity != null ? cur.equity / positiveShares : null,
    dividendYield: null,
    payoutRatio: cur?.dividendsPaid != null && cur?.netIncome ? Math.abs(cur.dividendsPaid) / cur.netIncome : null,
    roe: cur?.netIncome != null && cur?.equity ? cur.netIncome / cur.equity : null,
    ebit: cur?.ebit ?? null,
    ebitda,
    netDebt,
    currentRatio: cur?.currentAssets != null && cur?.currentLiabilities ? cur.currentAssets / cur.currentLiabilities : null,
    debtToEquity: hasDebt && cur?.equity ? debt / cur.equity : null,
    freeCashFlow: fcf,
    operatingMargin: cur?.ebit != null && cur?.revenue ? cur.ebit / cur.revenue : null,
    grossMargin: cur?.grossProfit != null && cur?.revenue ? cur.grossProfit / cur.revenue : null,
    revenueGrowth: growth(cur?.revenue, prev?.revenue),
    earningsGrowth: growth(cur?.netIncome, prev?.netIncome),
    beta: null,
    shares: positiveShares,
    statements,
  }
}

/** Recalcula os múltiplos que dependem do preço. Não altera a linha original. */
export function repriceFundamentals(f: Fundamentals, price: number): Fundamentals {
  const shares = f.shares ?? null
  if (!shares || !(price > 0)) return f
  const marketCap = price * shares
  const dividends = f.statements[0]?.dividendsPaid
  return {
    ...f,
    price,
    marketCap,
    enterpriseValue: f.netDebt !== null ? marketCap + f.netDebt : null,
    trailingPE: f.eps !== null && f.eps > 0 ? price / f.eps : null,
    priceToBook: f.bookValuePerShare !== null && f.bookValuePerShare > 0 ? price / f.bookValuePerShare : null,
    dividendYield: dividends != null ? Math.abs(dividends) / shares / price : f.dividendYield,
  }
}

/** Serialização para persistência em JSON (preserva demonstrações). */
export function serializeFundamentals(rows: Fundamentals[]): string {
  return JSON.stringify(rows)
}

export function deserializeFundamentals(text: string): Fundamentals[] {
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('JSON de fundamentos deve ser uma lista')
  return parsed.filter((r): r is Fundamentals => typeof r?.ticker === 'string' && typeof r?.availableAt === 'string' && Array.isArray(r?.statements))
}

// ---- Ponto-no-tempo --------------------------------------------------------

/** Fundamentos ponto-no-tempo: só devolve dados já divulgados (availableAt <= data). */
let historyCounter = 0

export class FundamentalsHistory {
  private readonly byTicker = new Map<string, Fundamentals[]>()
  /** Identifica a versão carregada (entra na chave de cache dos backtests). */
  readonly version: string

  constructor(rows: Fundamentals[]) {
    this.version = `f${++historyCounter}:${rows.length}`
    for (const row of rows) {
      const list = this.byTicker.get(row.ticker) ?? []
      list.push(row)
      this.byTicker.set(row.ticker, list)
    }
    for (const list of this.byTicker.values()) {
      list.sort((a, b) => (a.availableAt ?? a.asOf).localeCompare(b.availableAt ?? b.asOf))
    }
  }

  tickers(): string[] {
    return Array.from(this.byTicker.keys())
  }

  /**
   * Último dado divulgado até `date` (yyyy-mm-dd). Com `price` e `shares` na linha, os múltiplos que dependem
   * de preço (P/L, P/VP, valor de mercado, EV, dividend yield) são recalculados ao preço da data pedida.
   */
  asOf(ticker: string, date: string, price?: number | null): Fundamentals | null {
    const list = this.byTicker.get(ticker)
    if (!list) return null
    let found: Fundamentals | null = null
    for (const row of list) {
      if ((row.availableAt ?? row.asOf) <= date) found = row
      else break
    }
    if (found && typeof price === 'number' && price > 0 && found.shares) return repriceFundamentals(found, price)
    return found
  }

  rowCount(): number {
    let n = 0
    for (const list of this.byTicker.values()) n += list.length
    return n
  }
}

const CSV_NUMERIC_FIELDS = [
  'price', 'marketCap', 'enterpriseValue', 'trailingPE', 'priceToBook', 'eps', 'bookValuePerShare', 'dividendYield',
  'payoutRatio', 'roe', 'ebit', 'ebitda', 'netDebt', 'currentRatio', 'debtToEquity', 'freeCashFlow', 'operatingMargin',
  'grossMargin', 'revenueGrowth', 'earningsGrowth', 'beta',
] as const

/**
 * Carrega fundamentos ponto-no-tempo de CSV (cabeçalho obrigatório: ticker,asOf,availableAt + campos numéricos).
 * Aceita ';' ou ',' como separador. Linhas sem `availableAt` são rejeitadas (evita look-ahead silencioso).
 */
export function parseFundamentalsCsv(text: string): { rows: Fundamentals[]; rejected: number } {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) return { rows: [], rejected: 0 }
  const sep = (lines[0] as string).includes(';') ? ';' : ','
  const header = (lines[0] as string).split(sep).map(h => h.trim())
  const col = (name: string) => header.indexOf(name)
  const iTicker = col('ticker')
  const iAsOf = col('asOf')
  const iAvail = col('availableAt')
  if (iTicker < 0 || iAsOf < 0 || iAvail < 0) throw new Error('CSV precisa das colunas ticker, asOf e availableAt')

  const rows: Fundamentals[] = []
  let rejected = 0
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map(c => c.trim())
    const availableAt = cells[iAvail]
    const asOf = cells[iAsOf]
    const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
    // rejeita datas inválidas e dados "divulgados antes do período a que se referem" (look-ahead)
    if (!isDate(availableAt) || !isDate(asOf) || availableAt < asOf || !cells[iTicker]) {
      rejected++
      continue
    }
    const rawTicker = (cells[iTicker] as string).trim().toUpperCase()
    const row: Fundamentals = {
      ticker: rawTicker.includes('.') ? rawTicker : `${rawTicker}.SA`,
      asOf,
      availableAt,
      isFinancial: col('isFinancial') >= 0 ? cells[col('isFinancial')] === 'true' : undefined,
      price: null, marketCap: null, enterpriseValue: null, trailingPE: null, priceToBook: null, eps: null,
      bookValuePerShare: null, dividendYield: null, payoutRatio: null, roe: null, ebit: null, ebitda: null,
      netDebt: null, currentRatio: null, debtToEquity: null, freeCashFlow: null, operatingMargin: null,
      grossMargin: null, revenueGrowth: null, earningsGrowth: null, beta: null, statements: [],
    }
    for (const field of CSV_NUMERIC_FIELDS) {
      const i = col(field)
      if (i >= 0) row[field] = num((cells[i] ?? '').replace(',', '.'))
    }
    rows.push(row)
  }
  return { rows, rejected }
}
