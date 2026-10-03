// Orquestra os módulos quantitativos sobre dados reais (via MarketData injetável).

import { type BacktestConfig, type BacktestResult, compareStrategies, toApiResult } from './backtest.ts'
import { type LoadedPanel, type MarketData, loadPanel } from './data.ts'
import {
  DEFAULT_FACTOR_WEIGHTS,
  type FactorInput,
  type FactorScore,
  type FactorWeights,
  priceFactors,
  scoreUniverse,
} from './factors.ts'
import { type Fundamentals, FundamentalsHistory, type GrahamDefensiveResult, type PiotroskiResult, grahamDefensive, piotroskiFScore } from './fundamentals.ts'
import { type Ips, checkCompliance, type IpsCompliance } from './ips.ts'
import { type ConstructionMethod, type ConstructionResult, constructPortfolio } from './portfolio.ts'
import { TRADING_DAYS_YEAR, simpleReturns } from './stats.ts'
import { type StressReport, buildStressReport } from './stress.ts'
import {
  type Strategy,
  defaultStrategies,
  lowVolStrategy,
  momentumStrategy,
  multiFactorStrategy,
} from './strategies.ts'
import { type WalkForwardSelection, walkForwardSelect } from './validation.ts'
import { type UniverseAsset } from './universe.ts'
import { type ValuationResult, valueAsset } from './valuation.ts'

export interface QuantDeps {
  data: MarketData
  universe: UniverseAsset[]
  riskFreeAnnual: number
  /** Fundamentos ponto-no-tempo carregados pelo usuário (opcional). */
  getPit?: () => FundamentalsHistory | null
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
  now?: () => Date
}

export interface FactorTableRow extends FactorScore {
  name: string
  sector: string
  price: number | null
  graham: GrahamDefensiveResult | null
  piotroskiDetail: PiotroskiResult | null
  hasFundamentals: boolean
}

export interface FactorTable {
  generatedAt: string
  /** Última data de preço usada (yyyy-mm-dd). */
  asOf: string
  weights: FactorWeights
  universeSize: number
  scored: number
  withFundamentals: number
  missingPrices: string[]
  rows: FactorTableRow[]
  notes: string[]
}

export interface BacktestParams {
  years: number
  topN: number
  costs: boolean
  tax: boolean
  initialCapital: number
}

export interface BacktestReport {
  generatedAt: string
  params: BacktestParams
  benchmark: string | null
  cdiSource: 'bcb' | 'constant'
  assets: number
  missing: string[]
  results: Array<Omit<BacktestResult, 'series'>>
  robustness: (WalkForwardSelection & { variants: string[]; trainDays: number; testDays: number }) | null
  trialsCounted: number
  caveats: string[]
}

export interface ConstructionParams {
  method: ConstructionMethod
  maxWeight: number
  maxSector: number
  lookbackDays: number
  includeStress: boolean
}

export interface ConstructionReport {
  generatedAt: string
  params: ConstructionParams
  asOf: string
  excluded: string[]
  construction: ConstructionResult
  sectors: Array<{ sector: string; weight: number }>
  stress: StressReport | null
  ips: IpsCompliance | null
  notes: string[]
}

/**
 * Memoiza uma promessa (compartilhada entre chamadas simultâneas). Resultado nulo (sem dados de mercado)
 * fica em cache por pouco tempo para não repetir dezenas de requisições durante uma queda do provedor;
 * erro não é cacheado.
 */
function memoAsync<T>(ttlMs: number, fn: () => Promise<T>, nullTtlMs = 60_000): () => Promise<T> {
  let cached: { at: number; ttl: number; promise: Promise<T> } | null = null
  return () => {
    if (cached && Date.now() - cached.at < cached.ttl) return cached.promise
    const entry = { at: Date.now(), ttl: ttlMs, promise: fn() }
    cached = entry
    entry.promise.then(
      value => {
        if (value === null) {
          entry.at = Date.now()
          entry.ttl = nullTtlMs
        }
      },
      () => { entry.ttl = 0 }
    )
    return entry.promise
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  return out
}

function trailingRf12m(loaded: LoadedPanel, riskFreeAnnual: number): number {
  if (!loaded.cdiDaily) return riskFreeAnnual
  let acc = 1
  for (const r of loaded.cdiDaily.slice(-TRADING_DAYS_YEAR)) acc *= 1 + r
  return acc - 1
}

export function createQuantService(deps: QuantDeps) {
  const { data, universe, riskFreeAnnual } = deps
  const log = deps.log ?? (() => undefined)
  const now = deps.now ?? (() => new Date())
  const tickers = universe.map(a => a.ticker)
  const byTicker = new Map(universe.map(a => [a.ticker, a]))

  async function buildFactorTable(weights: FactorWeights = DEFAULT_FACTOR_WEIGHTS): Promise<FactorTable | null> {
    const loaded = await loadPanel(data, tickers, 2.3, riskFreeAnnual)
    if (!loaded) return null
    const { panel } = loaded
    const t = panel.dates.length - 1

    const alive = panel.tickers.filter(tk => typeof (panel.close[tk] as Array<number | null>)[t] === 'number')
    const funds = new Map<string, Fundamentals | null>()
    await mapLimit(alive, 4, async tk => {
      funds.set(tk, await data.fundamentals(tk, byTicker.get(tk)?.isFinancial))
    })

    const inputs: FactorInput[] = alive.map(tk => ({
      ticker: tk,
      price: priceFactors(panel.close[tk] as Array<number | null>, t),
      fundamentals: funds.get(tk) ?? null,
    }))
    const scores = scoreUniverse(inputs, { weights, riskFree12m: trailingRf12m(loaded, riskFreeAnnual) })

    const rows: FactorTableRow[] = scores.map((s, i) => {
      const f = inputs[i]!.fundamentals ?? null
      const meta = byTicker.get(s.ticker)
      return {
        ...s,
        name: meta?.name ?? s.ticker,
        sector: meta?.sector ?? 'outros',
        price: (panel.close[s.ticker] as Array<number | null>)[t] ?? null,
        graham: f ? grahamDefensive(f) : null,
        piotroskiDetail: f ? piotroskiFScore(f) : null,
        hasFundamentals: f !== null,
      }
    })
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))

    const withFundamentals = rows.filter(r => r.hasFundamentals).length
    const notes = [
      'Score = posto percentual do composto de 4 fatores (valor, qualidade, momentum, baixa volatilidade), pesos iguais.',
      'É um ranking relativo dentro do universo; não prevê retorno nem considera sua situação pessoal.',
    ]
    if (withFundamentals === 0) notes.push('Fundamentos indisponíveis: score calculado só com momentum e baixa volatilidade.')
    else if (withFundamentals < rows.length) notes.push(`Fundamentos disponíveis para ${withFundamentals}/${rows.length} ativos; os demais usam menos fatores.`)

    log('info', 'Factor table built', { scored: rows.length, withFundamentals })
    return {
      generatedAt: now().toISOString(),
      asOf: panel.dates[t] as string,
      weights,
      universeSize: universe.length,
      scored: rows.filter(r => r.score !== null).length,
      withFundamentals,
      missingPrices: loaded.missing,
      rows,
      notes,
    }
  }

  const getFactorTable = memoAsync(30 * 60_000, () => buildFactorTable())

  const backtestCache = new Map<string, { at: number; report: BacktestReport }>()

  async function runBacktests(partial: Partial<BacktestParams> = {}): Promise<BacktestReport | null> {
    const params: BacktestParams = {
      years: Math.min(15, Math.max(3, partial.years ?? 8)),
      topN: Math.min(20, Math.max(3, partial.topN ?? 8)),
      costs: partial.costs ?? true,
      tax: partial.tax ?? true,
      initialCapital: partial.initialCapital ?? 100_000,
    }
    const cacheKey = JSON.stringify({ params, pit: Boolean(deps.getPit?.()) })
    const hit = backtestCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.report

    // +1,2 ano para o aquecimento de 12 meses do momentum
    const loaded = await loadPanel(data, tickers, params.years + 1.2, riskFreeAnnual)
    if (!loaded) return null

    const pit = deps.getPit?.() ?? null
    const config: Partial<BacktestConfig> = {
      initialCapital: params.initialCapital,
      ...(pit ? { fundamentalsAt: (tk: string, date: string) => pit.asOf(tk, date) } : {}),
      riskFreeAnnual,
      cdiDaily: loaded.cdiDaily,
      cdiSource: loaded.cdiSource,
      benchmark: loaded.benchmark,
      benchmarkName: 'Ibovespa (^BVSP)',
      ...(params.costs ? {} : { cost: null }),
      ...(params.tax ? {} : { tax: null }),
    }

    // Variantes tentadas entram na contagem de tentativas do Sharpe deflacionado.
    const variants: Strategy[] = []
    for (const n of [5, 8, 12, 15]) {
      variants.push(momentumStrategy({ topN: n, absolute: true }), multiFactorStrategy({ topN: n, requireTrend: true }), lowVolStrategy({ topN: n }))
    }
    const variantResults = compareStrategies(loaded.panel, variants, config)
    const variantSharpes = variantResults.map(r => {
      const ex = r.series.strategy.map((x, i) => x - (r.series.rfDaily[i] as number))
      const m = ex.reduce((a, b) => a + b, 0) / ex.length
      const sd = Math.sqrt(ex.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, ex.length - 1))
      return sd === 0 ? 0 : m / sd
    })

    const strategies = defaultStrategies(params.topN)
    const results = compareStrategies(loaded.panel, strategies, config, variantSharpes)

    let robustness: BacktestReport['robustness'] = null
    if (variantResults.length >= 2) {
      const series: Record<string, number[]> = {}
      for (const r of variantResults) series[r.strategy] = r.series.strategy
      const wf = walkForwardSelect(series, 504, 126, 21)
      if (wf) robustness = { ...wf, variants: Object.keys(series), trainDays: 504, testDays: 126 }
    }

    const caveats = results[0]?.caveats ?? []
    log('info', 'Backtests done', { strategies: results.length, variants: variantResults.length })
    const report: BacktestReport = {
      generatedAt: now().toISOString(),
      params,
      benchmark: loaded.benchmark ? 'Ibovespa (^BVSP)' : null,
      cdiSource: loaded.cdiSource,
      assets: loaded.panel.tickers.length,
      missing: loaded.missing,
      results: results.map(toApiResult),
      robustness,
      trialsCounted: results.length + variantResults.length,
      caveats: loaded.benchmark ? caveats : [...caveats, 'Benchmark (Ibovespa) indisponível: comparação relativa omitida.'],
    }
    backtestCache.set(cacheKey, { at: Date.now(), report })
    return report
  }

  async function construct(partial: Partial<ConstructionParams> & { ips?: Ips | null } = {}): Promise<ConstructionReport | null> {
    const params: ConstructionParams = {
      method: partial.method ?? 'hrp',
      maxWeight: partial.maxWeight ?? 0.15,
      maxSector: partial.maxSector ?? 0.35,
      lookbackDays: Math.min(1008, Math.max(120, partial.lookbackDays ?? 504)),
      includeStress: partial.includeStress ?? false,
    }
    const years = params.includeStress ? 18 : Math.max(2.5, params.lookbackDays / TRADING_DAYS_YEAR + 0.5)
    const loaded = await loadPanel(data, tickers, years, riskFreeAnnual)
    if (!loaded) return null
    const { panel } = loaded
    const n = panel.dates.length
    const from = Math.max(0, n - params.lookbackDays - 1)

    // ativos com série completa na janela
    const complete = panel.tickers.filter(tk => {
      const col = panel.close[tk] as Array<number | null>
      for (let i = from; i < n; i++) if (typeof col[i] !== 'number') return false
      return true
    })
    const excluded = tickers.filter(tk => !complete.includes(tk))
    if (complete.length < 4) return null

    const rets = complete.map(tk => simpleReturns((panel.close[tk] as number[]).slice(from)))
    const rows = rets[0]!.map((_, i) => complete.map((_, j) => (rets[j] as number[])[i] as number))
    const construction = constructPortfolio({
      tickers: complete,
      returns: rows,
      sectors: complete.map(tk => byTicker.get(tk)?.sector ?? 'outros'),
      method: params.method,
      maxWeight: params.maxWeight,
      maxSector: params.maxSector,
    })
    if (!construction) return null

    const bySector = new Map<string, number>()
    for (const w of construction.weights) {
      const sector = byTicker.get(w.ticker)?.sector ?? 'outros'
      bySector.set(sector, (bySector.get(sector) ?? 0) + w.weight)
    }

    const weights: Record<string, number> = Object.fromEntries(construction.weights.map(w => [w.ticker, w.weight]))
    const stress = params.includeStress ? buildStressReport(panel, weights, loaded.benchmark) : null
    const sectorsMap = Object.fromEntries(universe.map(a => [a.ticker, a.sector]))
    const ips = partial.ips ? checkCompliance(partial.ips, construction, sectorsMap, stress) : null

    return {
      generatedAt: now().toISOString(),
      params,
      asOf: panel.dates[n - 1] as string,
      excluded,
      construction,
      sectors: Array.from(bySector, ([sector, weight]) => ({ sector, weight: Math.round(weight * 1000) / 1000 })).sort((a, b) => b.weight - a.weight),
      stress,
      ips,
      notes: [
        'Pesos de risco (HRP/ERC/etc.) usam só covariância encolhida; retornos esperados não são extrapolados do passado.',
        'Pesos descrevem a fração DENTRO da parcela em ações; o IPS define quanto do patrimônio vai para ações.',
        ...(params.includeStress ? ['Replays de crise cobrem só os ativos que já existiam na época (veja `coverage`).'] : ['Passe stress=1 para incluir replays de crise e diagnóstico de cauda.']),
      ],
    }
  }

  async function valuation(ticker: string): Promise<ValuationResult | null> {
    const meta = byTicker.get(ticker)
    const f = await data.fundamentals(ticker, meta?.isFinancial)
    return f ? valueAsset(f) : null
  }

  return { buildFactorTable, getFactorTable, runBacktests, construct, valuation }
}

export type QuantService = ReturnType<typeof createQuantService>
