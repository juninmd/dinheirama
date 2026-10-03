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

// ---- Ponto-no-tempo --------------------------------------------------------

/** Fundamentos ponto-no-tempo: só devolve dados já divulgados (availableAt <= data). */
export class FundamentalsHistory {
  private readonly byTicker = new Map<string, Fundamentals[]>()

  constructor(rows: Fundamentals[]) {
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

  /** Último dado divulgado até `date` (yyyy-mm-dd). */
  asOf(ticker: string, date: string): Fundamentals | null {
    const list = this.byTicker.get(ticker)
    if (!list) return null
    let found: Fundamentals | null = null
    for (const row of list) {
      if ((row.availableAt ?? row.asOf) <= date) found = row
      else break
    }
    return found
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
    if (!availableAt || !/^\d{4}-\d{2}-\d{2}$/.test(availableAt)) {
      rejected++
      continue
    }
    const row: Fundamentals = {
      ticker: cells[iTicker] as string,
      asOf: cells[iAsOf] as string,
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
