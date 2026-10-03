// Painel de preços alinhado por data (base de backtest, fatores e estresse).

export interface RawSeries {
  ticker: string
  /** Datas ISO (yyyy-mm-dd), ascendentes. */
  dates: string[]
  /** Fechamento ajustado (proventos e splits) — retorno total. */
  closes: Array<number | null>
  /** Volume em ações (opcional). */
  volumes?: Array<number | null>
}

export interface PricePanel {
  dates: string[]
  tickers: string[]
  /** Fechamento ajustado alinhado a `dates`; null = sem cotação (antes do início ou lacuna longa). */
  close: Record<string, Array<number | null>>
  /** Volume financeiro diário (R$) = fechamento * volume; null se indisponível. */
  dollarVolume: Record<string, Array<number | null>>
}

/**
 * Alinha séries na união das datas. Preenche lacunas curtas (feriados locais,
 * dias sem negócio) com o último preço, no máximo `maxFillDays` dias seguidos.
 * Nunca preenche para trás: ativo sem histórico antes da estreia fica null (sem look-ahead).
 */
export function alignPanel(series: RawSeries[], maxFillDays = 5): PricePanel {
  const dateSet = new Set<string>()
  for (const s of series) for (const d of s.dates) dateSet.add(d)
  const dates = Array.from(dateSet).sort()
  const index = new Map(dates.map((d, i) => [d, i]))

  const close: PricePanel['close'] = {}
  const dollarVolume: PricePanel['dollarVolume'] = {}

  for (const s of series) {
    const col: Array<number | null> = Array.from({ length: dates.length }, () => null)
    const vol: Array<number | null> = Array.from({ length: dates.length }, () => null)
    for (let k = 0; k < s.dates.length; k++) {
      const i = index.get(s.dates[k] as string)
      const price = s.closes[k]
      if (i === undefined || typeof price !== 'number' || !(price > 0)) continue
      col[i] = price
      const v = s.volumes?.[k]
      if (typeof v === 'number' && v >= 0) vol[i] = v * price
    }

    let last: number | null = null
    let gap = 0
    for (let i = 0; i < col.length; i++) {
      if (col[i] !== null) {
        last = col[i] as number
        gap = 0
      } else if (last !== null) {
        gap++
        if (gap <= maxFillDays) col[i] = last
      }
    }
    close[s.ticker] = col
    dollarVolume[s.ticker] = vol
  }

  return { dates, tickers: series.map(s => s.ticker), close, dollarVolume }
}

/** Último preço válido <= t (ou null). */
export function priceAt(panel: PricePanel, ticker: string, t: number): number | null {
  const col = panel.close[ticker]
  if (!col) return null
  const v = col[t]
  return typeof v === 'number' ? v : null
}

/** Janela de fechamentos [from, to] (inclusive) sem nulls; retorna null se houver lacuna. */
export function windowCloses(panel: PricePanel, ticker: string, from: number, to: number): number[] | null {
  const col = panel.close[ticker]
  if (!col || from < 0 || to >= col.length || from > to) return null
  const out: number[] = []
  for (let i = from; i <= to; i++) {
    const v = col[i]
    if (typeof v !== 'number') return null
    out.push(v)
  }
  return out
}

/** ADV (R$) médio dos últimos `window` pregões até t, ignorando nulls. */
export function averageDollarVolume(panel: PricePanel, ticker: string, t: number, window = 60): number | null {
  const col = panel.dollarVolume[ticker]
  if (!col) return null
  let sum = 0
  let n = 0
  for (let i = Math.max(0, t - window + 1); i <= t; i++) {
    const v = col[i]
    if (typeof v === 'number') {
      sum += v
      n++
    }
  }
  return n >= Math.min(10, window) ? sum / n : null
}

/** Índices do primeiro pregão de cada mês (datas de rebalanceamento mensal). */
export function monthStartIndexes(dates: string[]): number[] {
  const out: number[] = []
  let prev = ''
  dates.forEach((d, i) => {
    const month = d.slice(0, 7)
    if (month !== prev) out.push(i)
    prev = month
  })
  return out
}

/** Converte CDI diário em % a.d. (formato SGS 12 do BCB) em fator diário alinhado ao painel. */
export function alignDailyRate(
  dates: string[],
  ratesByDate: Map<string, number>,
  fallbackAnnual: number
): number[] {
  const fallbackDaily = (1 + fallbackAnnual) ** (1 / 252) - 1
  let last = fallbackDaily
  return dates.map(d => {
    const r = ratesByDate.get(d)
    if (typeof r === 'number' && Number.isFinite(r)) last = r
    return last
  })
}
