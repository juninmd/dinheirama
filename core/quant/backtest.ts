// Backtest walk-forward sem look-ahead, com custos, impacto, IR de swing trade e CDI no caixa.
//
// Regras de honestidade:
// - o sinal usa dados até t; a execução acontece em t + executionLagDays (fechamento);
// - caixa rende CDI; vendas apuram IR mensal (15%, isenção de R$ 20 mil, compensação de prejuízo);
// - resultado bruto e líquido são reportados lado a lado;
// - ressalvas (viés de sobrevivência etc.) acompanham todo resultado.

import { CostBasisBook, DEFAULT_COST_CONFIG, DEFAULT_TAX_CONFIG, type CostConfig, type TaxConfig, monthlySwingTax, tradeCostRate } from './costs.ts'
import { type BenchmarkRelative, type PerformanceMetrics, benchmarkRelative, computeMetrics, deflatedSharpe, periodSharpe } from './metrics.ts'
import { type PricePanel, averageDollarVolume, monthStartIndexes } from './panel.ts'
import { TRADING_DAYS_YEAR, simpleReturns } from './stats.ts'
import type { Fundamentals } from './fundamentals.ts'
import type { Strategy, Weights } from './strategies.ts'

export interface BacktestConfig {
  initialCapital: number
  /** Dias de atraso entre sinal e execução (1 = executa no fechamento seguinte). */
  executionLagDays: number
  /** Pregões mínimos antes do primeiro sinal. */
  warmup: number
  cost: CostConfig | null
  tax: TaxConfig | null
  /** Taxa livre de risco anual usada se não houver série de CDI. */
  riskFreeAnnual: number
  /** CDI diário (fração) alinhado a panel.dates. */
  cdiDaily?: number[]
  cdiSource?: 'bcb' | 'constant'
  /** Fechamento ajustado do benchmark (ex.: ^BVSP) alinhado a panel.dates. */
  benchmark?: Array<number | null>
  benchmarkName?: string
  /** Ignora variações menores que esta fração do patrimônio ao rebalancear. */
  rebalanceBand: number
  fundamentalsAt?: (ticker: string, date: string) => Fundamentals | null
  /** Primeira data (yyyy-mm-dd) de sinal permitida. */
  startDate?: string
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 100_000,
  executionLagDays: 1,
  warmup: 253,
  cost: DEFAULT_COST_CONFIG,
  tax: DEFAULT_TAX_CONFIG,
  riskFreeAnnual: Number(process.env.MC_RISK_FREE_RATE ?? 0.105),
  rebalanceBand: 0.005,
}

export interface BacktestSeries {
  dates: string[]
  strategy: number[]
  rfDaily: number[]
  benchmark?: number[]
}

export interface BacktestResult {
  strategy: string
  label: string
  startDate: string
  endDate: string
  years: number
  net: PerformanceMetrics
  gross: PerformanceMetrics
  cash: PerformanceMetrics
  benchmark?: PerformanceMetrics & { name: string }
  relative?: BenchmarkRelative
  turnoverAnnual: number
  totalCosts: number
  totalTax: number
  trades: number
  rebalances: number
  avgPositions: number
  deflatedSharpe?: number
  equityCurve: Array<{ date: string; strategy: number; cdi: number; benchmark?: number }>
  caveats: string[]
  /** Séries diárias (a API não serializa). */
  series: BacktestSeries
}

interface SimOutput {
  dates: string[]
  returns: number[]
  rf: number[]
  equity: number[]
  costs: number
  taxes: number
  trades: number
  rebalances: number
  tradedValue: number
  positionsSum: number
  startIndex: number
}

function dailyRf(config: BacktestConfig, n: number): number[] {
  const flat = (1 + config.riskFreeAnnual) ** (1 / TRADING_DAYS_YEAR) - 1
  return Array.from({ length: n }, (_, i) => config.cdiDaily?.[i] ?? flat)
}

/** CDI acumulado em 12 meses (252 pregões) até t. */
function rf12m(rf: number[], t: number): number {
  let acc = 1
  for (let i = Math.max(1, t - 251); i <= t; i++) acc *= 1 + (rf[i] as number)
  return acc - 1
}

function simulate(panel: PricePanel, strategy: Strategy, config: BacktestConfig, withFrictions: boolean): SimOutput | null {
  const n = panel.dates.length
  const rf = dailyRf(config, n)
  const cost = withFrictions ? config.cost : null
  const tax = withFrictions ? config.tax : null

  const signalDays = monthStartIndexes(panel.dates).filter(i => {
    if (i < config.warmup) return false
    if (config.startDate && (panel.dates[i] as string) < config.startDate) return false
    return i + config.executionLagDays < n
  })
  if (signalDays.length === 0) return null

  const execToSignal = new Map<number, number>()
  for (const s of signalDays) execToSignal.set(s + config.executionLagDays, s)

  const startIndex = signalDays[0] as number
  const shares = new Map<string, number>()
  const lastPrice = new Map<string, number>()
  const book = new CostBasisBook()
  let cash = config.initialCapital
  let lossCarry = 0
  let monthSales = 0
  let monthPnl = 0
  let costs = 0
  let taxes = 0
  let trades = 0
  let rebalances = 0
  let tradedValue = 0
  let positionsSum = 0
  let prevWeights: Weights = {}

  const equity: number[] = [config.initialCapital]
  const rets: number[] = []
  const dates: string[] = [panel.dates[startIndex] as string]

  const markToMarket = (i: number): number => {
    let value = cash
    for (const [ticker, qty] of shares) {
      const p = panel.close[ticker]?.[i]
      if (typeof p === 'number') lastPrice.set(ticker, p)
      value += qty * (lastPrice.get(ticker) ?? 0)
    }
    return value
  }
  for (const ticker of panel.tickers) {
    const p = panel.close[ticker]?.[startIndex]
    if (typeof p === 'number') lastPrice.set(ticker, p)
  }

  const settleTax = () => {
    if (!tax) {
      monthSales = 0
      monthPnl = 0
      return
    }
    const result = monthlySwingTax({ sales: monthSales, realizedPnl: monthPnl }, lossCarry, tax)
    lossCarry = result.lossCarryAfter
    cash -= result.tax
    taxes += result.tax
    monthSales = 0
    monthPnl = 0
  }

  for (let i = startIndex + 1; i < n; i++) {
    const prevDate = panel.dates[i - 1] as string
    const date = panel.dates[i] as string
    if (prevDate.slice(0, 7) !== date.slice(0, 7)) settleTax()

    cash *= 1 + (rf[i] as number)
    let value = markToMarket(i)

    const signalIndex = execToSignal.get(i)
    if (signalIndex !== undefined) {
      rebalances++
      const targets = strategy.rebalance({
        panel,
        t: signalIndex,
        date: panel.dates[signalIndex] as string,
        prevWeights,
        riskFree12m: rf12m(rf, signalIndex),
        fundamentalsAt: config.fundamentalsAt,
      })

      const targetValue = new Map<string, number>()
      for (const [ticker, w] of Object.entries(targets)) {
        const p = panel.close[ticker]?.[i]
        if (typeof p === 'number' && w > 0) targetValue.set(ticker, w * value)
      }

      const currentValue = (ticker: string) => (shares.get(ticker) ?? 0) * (lastPrice.get(ticker) ?? 0)
      const universe = new Set<string>([...shares.keys(), ...targetValue.keys()])
      const band = config.rebalanceBand * value

      // 1) vendas
      for (const ticker of universe) {
        const cur = currentValue(ticker)
        const tv = targetValue.get(ticker) ?? 0
        const price = panel.close[ticker]?.[i]
        const px = typeof price === 'number' ? price : (lastPrice.get(ticker) ?? 0)
        if (px <= 0 || cur <= tv) continue
        const exit = tv === 0
        if (!exit && cur - tv < band) continue
        const sellValue = cur - tv
        const rate = cost ? tradeCostRate(sellValue, averageDollarVolume(panel, ticker, i), cost) : 0
        const fee = sellValue * rate
        const qty = sellValue / px
        const pnl = book.sell(ticker, qty, px, fee)
        const remaining = (shares.get(ticker) ?? 0) - qty
        if (remaining <= 1e-9) shares.delete(ticker)
        else shares.set(ticker, remaining)
        cash += sellValue - fee
        costs += fee
        monthSales += sellValue
        monthPnl += pnl
        tradedValue += sellValue
        trades++
      }

      // 2) compras (escaladas ao caixa disponível, já incluindo custos)
      const buys: Array<{ ticker: string; value: number; rate: number; px: number }> = []
      for (const [ticker, tv] of targetValue) {
        const cur = currentValue(ticker)
        const px = panel.close[ticker]?.[i] as number
        if (tv - cur < band || px <= 0) continue
        const buyValue = tv - cur
        buys.push({ ticker, value: buyValue, rate: cost ? tradeCostRate(buyValue, averageDollarVolume(panel, ticker, i), cost) : 0, px })
      }
      const need = buys.reduce((a, b) => a + b.value * (1 + b.rate), 0)
      const scale = need > 0 ? Math.min(1, Math.max(0, cash) / need) : 0
      for (const b of buys) {
        const buyValue = b.value * scale
        if (buyValue <= 0) continue
        const fee = buyValue * b.rate
        const qty = buyValue / b.px
        book.buy(b.ticker, qty, b.px, fee)
        shares.set(b.ticker, (shares.get(b.ticker) ?? 0) + qty)
        lastPrice.set(b.ticker, b.px)
        cash -= buyValue + fee
        costs += fee
        tradedValue += buyValue
        trades++
      }

      value = markToMarket(i)
      prevWeights = {}
      for (const [ticker, qty] of shares) prevWeights[ticker] = (qty * (lastPrice.get(ticker) ?? 0)) / value
    }

    positionsSum += shares.size
    const prev = equity[equity.length - 1] as number
    equity.push(value)
    rets.push(prev > 0 ? value / prev - 1 : 0)
    dates.push(date)
  }
  settleTax()
  // imposto do último mês reduz o patrimônio final
  if (equity.length > 1 && taxes > 0) {
    const last = markToMarket(n - 1)
    const prev = equity[equity.length - 2] as number
    equity[equity.length - 1] = last
    rets[rets.length - 1] = prev > 0 ? last / prev - 1 : 0
  }

  return {
    dates,
    returns: rets,
    rf: rf.slice(startIndex + 1),
    equity,
    costs,
    taxes,
    trades,
    rebalances,
    tradedValue,
    positionsSum,
    startIndex,
  }
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const step = items.length / max
  const out: T[] = []
  for (let k = 0; k < max; k++) out.push(items[Math.floor(k * step)] as T)
  out.push(items[items.length - 1] as T)
  return out
}

export function standardCaveats(config: BacktestConfig, panel: PricePanel): string[] {
  const out = [
    'Viés de sobrevivência: o universo é a lista atual de ações líquidas; empresas que deixaram de existir ou saíram do índice não entram.',
    'Retorno total via fechamento ajustado (proventos/splits do Yahoo); ajustes podem conter erros.',
    `Execução no fechamento ${config.executionLagDays} pregão(ões) após o sinal; custos e impacto são modelos simplificados.`,
    'IR de swing trade simplificado (15%, isenção de R$ 20 mil em vendas/mês, compensação de prejuízos); não cobre day trade, JCP, fracionário e outras regras.',
    'Desempenho passado não prevê desempenho futuro; muitas variantes testadas inflam o Sharpe (veja o Sharpe deflacionado).',
  ]
  if (!config.fundamentalsAt) out.push('Fatores de valor/qualidade NÃO entram no backtest: não há fundamentos ponto-no-tempo carregados (evita look-ahead).')
  if (config.cdiSource !== 'bcb') out.push(`CDI aproximado por taxa constante de ${(config.riskFreeAnnual * 100).toFixed(2)}% a.a.`)
  const years = panel.dates.length / TRADING_DAYS_YEAR
  if (years < 5) out.push(`Amostra curta (${years.toFixed(1)} anos de preços): conclusões estatísticas fracas.`)
  return out
}

export function runBacktest(panel: PricePanel, strategy: Strategy, partial: Partial<BacktestConfig> = {}): BacktestResult | null {
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...partial }
  // executar no mesmo fechamento do sinal seria look-ahead: o atraso mínimo é de 1 pregão
  config.executionLagDays = Math.max(1, Math.floor(config.executionLagDays))
  const net = simulate(panel, strategy, config, true)
  const gross = simulate(panel, strategy, config, false)
  if (!net || !gross || net.returns.length < 20) return null

  const metricsNet = computeMetrics(net.returns, net.rf, net.dates)
  const metricsGross = computeMetrics(gross.returns, gross.rf, gross.dates)
  const cashMetrics = computeMetrics(net.rf.map(r => r), net.rf, net.dates)

  let benchReturns: number[] | undefined
  if (config.benchmark) {
    const slice = config.benchmark.slice(net.startIndex)
    const clean: number[] = []
    let last: number | null = null
    for (const v of slice) {
      if (typeof v === 'number') last = v
      if (last !== null) clean.push(last)
    }
    if (clean.length === net.returns.length + 1) benchReturns = simpleReturns(clean)
  }
  const caveats = standardCaveats(config, panel)
  if (config.benchmark && !benchReturns) caveats.push('Benchmark não cobre todo o período do backtest: comparação relativa omitida.')

  const years = net.returns.length / TRADING_DAYS_YEAR
  const avgEquity = net.equity.reduce((a, b) => a + b, 0) / net.equity.length
  const cdiCurve: number[] = [1]
  net.rf.forEach(r => cdiCurve.push((cdiCurve[cdiCurve.length - 1] as number) * (1 + r)))
  let benchCurve: number[] | undefined
  if (benchReturns) {
    benchCurve = [1]
    for (const r of benchReturns) benchCurve.push((benchCurve[benchCurve.length - 1] as number) * (1 + r))
  }

  const curve = net.dates.map((date, i) => ({
    date,
    strategy: (net.equity[i] as number) / config.initialCapital,
    cdi: cdiCurve[i] as number,
    ...(benchCurve ? { benchmark: benchCurve[i] as number } : {}),
  }))

  return {
    strategy: strategy.name,
    label: strategy.label,
    startDate: net.dates[0] as string,
    endDate: net.dates[net.dates.length - 1] as string,
    years,
    net: metricsNet,
    gross: metricsGross,
    cash: cashMetrics,
    benchmark: benchReturns
      ? { ...computeMetrics(benchReturns, net.rf, net.dates), name: config.benchmarkName ?? 'benchmark' }
      : undefined,
    relative: benchReturns ? benchmarkRelative(net.returns, benchReturns, net.rf) : undefined,
    turnoverAnnual: years > 0 ? net.tradedValue / 2 / avgEquity / years : 0,
    totalCosts: net.costs,
    totalTax: net.taxes,
    trades: net.trades,
    rebalances: net.rebalances,
    avgPositions: net.returns.length > 0 ? net.positionsSum / net.returns.length : 0,
    equityCurve: downsample(curve, 400),
    caveats,
    series: { dates: net.dates, strategy: net.returns, rfDaily: net.rf, benchmark: benchReturns },
  }
}

/** Roda várias estratégias e calcula o Sharpe deflacionado considerando todas as variantes testadas. */
export function compareStrategies(
  panel: PricePanel,
  strategies: Strategy[],
  partial: Partial<BacktestConfig> = {},
  extraTrialSharpes: number[] = []
): BacktestResult[] {
  const results = strategies
    .map(s => runBacktest(panel, s, partial))
    .filter((r): r is BacktestResult => r !== null)
  const trialSharpes = [
    ...results.map(r => periodSharpe(r.series.strategy.map((x, i) => x - (r.series.rfDaily[i] as number)))),
    ...extraTrialSharpes,
  ]
  for (const r of results) {
    const excess = r.series.strategy.map((x, i) => x - (r.series.rfDaily[i] as number))
    r.deflatedSharpe = deflatedSharpe(excess, trialSharpes)
  }
  return results
}

/** Remove séries diárias para serialização na API. */
export function toApiResult(result: BacktestResult): Omit<BacktestResult, 'series'> {
  const { series: _series, ...rest } = result
  return rest
}
