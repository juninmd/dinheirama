// Calculadora de IR sobre renda variável (pessoa física), a partir de uma lista de operações.
// Cobre: swing trade de ações (15%, isenção de R$ 20 mil em vendas/mês), ETFs (15%, sem isenção),
// FIIs (20%, sem isenção), day trade (20%), compensação de prejuízos por "cesta", IRRF "dedo-duro"
// e DARF mínima de R$ 10. Também: JCP (15% na fonte) e retenção sobre dividendos altos.
//
// ATENÇÃO: regras tributárias mudam. As alíquotas e limites abaixo são configuráveis e devem ser
// conferidos com a Receita Federal / um contador antes de qualquer uso real. Isto NÃO é orientação fiscal.

export type AssetKind = 'acao' | 'etf' | 'fii'

export interface Trade {
  /** yyyy-mm-dd */
  date: string
  ticker: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  /** Taxas totais da ordem (corretagem + emolumentos), em R$. */
  fees?: number
  kind?: AssetKind
}

export interface TaxRules {
  swingRate: number
  swingMonthlyExemption: number
  etfRate: number
  fiiRate: number
  dayTradeRate: number
  /** IRRF "dedo-duro" sobre vendas em swing trade (0,005%). */
  swingIrrfRate: number
  /** IRRF sobre ganho líquido de day trade (1%). */
  dayTradeIrrfRate: number
  /** DARF abaixo deste valor não é emitida: acumula para o mês seguinte. */
  minDarf: number
}

export const DEFAULT_TAX_RULES: TaxRules = {
  swingRate: 0.15,
  swingMonthlyExemption: 20_000,
  etfRate: 0.15,
  fiiRate: 0.2,
  dayTradeRate: 0.2,
  swingIrrfRate: 0.00005,
  dayTradeIrrfRate: 0.01,
  minDarf: 10,
}

/** Cestas de compensação de prejuízo: ações+ETFs (operações comuns), FIIs e day trade ficam separados. */
export type LossPool = 'comum' | 'fii' | 'daytrade'

export interface BucketResult {
  /** Total vendido (R$) neste grupo no mês. */
  sales: number
  /** Lucro (+) ou prejuízo (−) realizado no mês. */
  pnl: number
  /** Lucro isento (ações com vendas ≤ limite). */
  exemptGain: number
  /** Base de cálculo após compensação de prejuízos. */
  taxable: number
  tax: number
  /** Saldo de prejuízo a compensar ao fim do mês. */
  lossCarryAfter: number
}

export interface MonthlyTaxReport {
  month: string
  swingAcoes: BucketResult
  swingEtf: BucketResult
  fii: BucketResult
  dayTrade: BucketResult
  /** IRRF retido (créditos) gerado no mês. */
  irrfWithheld: number
  totalTax: number
  /** DARF a pagar no mês seguinte (após créditos de IRRF e piso de R$ 10). */
  darfDue: number
}

export interface TaxReport {
  months: MonthlyTaxReport[]
  /** Posições abertas ao fim do período (custo médio). */
  positions: Array<{ ticker: string; qty: number; avgCost: number }>
  totalTax: number
  warnings: string[]
  rules: TaxRules
}

const emptyBucket = (): BucketResult => ({ sales: 0, pnl: 0, exemptGain: 0, taxable: 0, tax: 0, lossCarryAfter: 0 })

interface DayAgg {
  buyQty: number
  buyValue: number
  buyFees: number
  sellQty: number
  sellValue: number
  sellFees: number
  kind: AssetKind
}

/** Aplica compensação de prejuízos e alíquota a um grupo. Retorna o grupo preenchido e o novo saldo de prejuízo. */
function settleBucket(
  bucket: BucketResult,
  rate: number,
  lossCarry: number,
  exemption: number | null
): { bucket: BucketResult; lossCarry: number } {
  const b = { ...bucket }
  if (b.pnl < 0) {
    b.lossCarryAfter = lossCarry + -b.pnl
    return { bucket: b, lossCarry: b.lossCarryAfter }
  }
  if (exemption !== null && b.sales <= exemption) {
    b.exemptGain = b.pnl
    b.lossCarryAfter = lossCarry
    return { bucket: b, lossCarry }
  }
  const offset = Math.min(lossCarry, b.pnl)
  b.taxable = b.pnl - offset
  b.tax = b.taxable * rate
  b.lossCarryAfter = lossCarry - offset
  return { bucket: b, lossCarry: b.lossCarryAfter }
}

/**
 * Apura o IR mês a mês. Day trade = mesma ação comprada e vendida no mesmo dia (quantidade casada);
 * o excedente segue como swing trade pelo custo médio. Não suporta venda a descoberto.
 */
export function computeTaxReport(trades: Trade[], rules: TaxRules = DEFAULT_TAX_RULES): TaxReport {
  const warnings: string[] = []
  const sorted = [...trades].sort((a, b) => a.date.localeCompare(b.date))
  const positions = new Map<string, { qty: number; avgCost: number; kind: AssetKind }>()

  // agrupa por dia/ticker preservando a ordem cronológica
  const days = new Map<string, Map<string, DayAgg>>()
  for (const t of sorted) {
    if (!(t.qty > 0) || !(t.price > 0)) {
      warnings.push(`Operação ignorada (quantidade/preço inválidos): ${t.date} ${t.ticker}`)
      continue
    }
    const day = days.get(t.date) ?? new Map<string, DayAgg>()
    const agg = day.get(t.ticker) ?? { buyQty: 0, buyValue: 0, buyFees: 0, sellQty: 0, sellValue: 0, sellFees: 0, kind: t.kind ?? 'acao' }
    if (t.side === 'buy') {
      agg.buyQty += t.qty
      agg.buyValue += t.qty * t.price
      agg.buyFees += t.fees ?? 0
    } else {
      agg.sellQty += t.qty
      agg.sellValue += t.qty * t.price
      agg.sellFees += t.fees ?? 0
    }
    day.set(t.ticker, agg)
    days.set(t.date, day)
  }

  const monthAgg = new Map<string, { swingAcoes: BucketResult; swingEtf: BucketResult; fii: BucketResult; dayTrade: BucketResult; irrf: number }>()
  const monthOf = (date: string) => {
    const key = date.slice(0, 7)
    let m = monthAgg.get(key)
    if (!m) {
      m = { swingAcoes: emptyBucket(), swingEtf: emptyBucket(), fii: emptyBucket(), dayTrade: emptyBucket(), irrf: 0 }
      monthAgg.set(key, m)
    }
    return m
  }
  const swingBucket = (m: ReturnType<typeof monthOf>, kind: AssetKind) => (kind === 'fii' ? m.fii : kind === 'etf' ? m.swingEtf : m.swingAcoes)

  for (const date of Array.from(days.keys()).sort()) {
    const m = monthOf(date)
    let dayTradeNet = 0 // IRRF de day trade incide sobre o resultado LÍQUIDO do dia (positivo)
    for (const [ticker, d] of days.get(date) as Map<string, DayAgg>) {
      const dayQty = Math.min(d.buyQty, d.sellQty)
      const avgBuy = d.buyQty > 0 ? d.buyValue / d.buyQty : 0
      const avgSell = d.sellQty > 0 ? d.sellValue / d.sellQty : 0

      if (dayQty > 0) {
        const buyFee = d.buyQty > 0 ? (d.buyFees * dayQty) / d.buyQty : 0
        const sellFee = d.sellQty > 0 ? (d.sellFees * dayQty) / d.sellQty : 0
        const pnl = dayQty * (avgSell - avgBuy) - buyFee - sellFee
        m.dayTrade.pnl += pnl
        m.dayTrade.sales += dayQty * avgSell
        dayTradeNet += pnl
      }

      const pos = positions.get(ticker) ?? { qty: 0, avgCost: 0, kind: d.kind }
      // sobra de compra entra na posição pelo custo médio
      const buyRest = d.buyQty - dayQty
      if (buyRest > 0) {
        const fee = d.buyQty > 0 ? (d.buyFees * buyRest) / d.buyQty : 0
        const total = pos.qty * pos.avgCost + buyRest * avgBuy + fee
        pos.qty += buyRest
        pos.avgCost = pos.qty > 0 ? total / pos.qty : 0
      }
      // sobra de venda sai da posição (swing)
      const sellRest = d.sellQty - dayQty
      if (sellRest > 0) {
        const sold = Math.min(sellRest, pos.qty)
        if (sold < sellRest) warnings.push(`Venda acima da posição em ${ticker} (${date}): venda a descoberto não é suportada; excedente ignorado.`)
        if (sold > 0) {
          const fee = d.sellQty > 0 ? (d.sellFees * sold) / d.sellQty : 0
          const bucket = swingBucket(m, d.kind)
          bucket.sales += sold * avgSell
          bucket.pnl += sold * (avgSell - pos.avgCost) - fee
          m.irrf += sold * avgSell * rules.swingIrrfRate
          pos.qty -= sold
        }
      }
      if (pos.qty <= 1e-9) positions.delete(ticker)
      else positions.set(ticker, pos)
    }
    if (dayTradeNet > 0) m.irrf += dayTradeNet * rules.dayTradeIrrfRate
  }

  const carry: Record<LossPool, number> = { comum: 0, fii: 0, daytrade: 0 }
  let irrfCredit = 0
  let darfCarry = 0
  const months: MonthlyTaxReport[] = []

  for (const key of Array.from(monthAgg.keys()).sort()) {
    const m = monthAgg.get(key)!
    // Ações e ETFs formam a cesta de "operações comuns": o resultado do mês é compensado ENTRE eles antes de
    // usar/gerar prejuízo acumulado. Ganho de ações isento (vendas <= limite) fica de fora da compensação.
    const exemptActive = m.swingAcoes.pnl >= 0 && m.swingAcoes.sales <= rules.swingMonthlyExemption
    const acoesIn = exemptActive ? 0 : m.swingAcoes.pnl
    const comumPnl = acoesIn + m.swingEtf.pnl
    let acoesBucket: BucketResult = { ...m.swingAcoes, exemptGain: exemptActive ? m.swingAcoes.pnl : 0 }
    let etfBucket: BucketResult = { ...m.swingEtf }
    if (comumPnl < 0) {
      carry.comum += -comumPnl
    } else {
      const offset = Math.min(carry.comum, comumPnl)
      carry.comum -= offset
      const taxable = comumPnl - offset
      // reparte a base entre ações e ETFs proporcionalmente aos ganhos positivos de cada um
      const gains = { a: Math.max(0, acoesIn), e: Math.max(0, m.swingEtf.pnl) }
      const totalGains = gains.a + gains.e
      const shareA = totalGains > 0 ? gains.a / totalGains : 0
      acoesBucket = { ...acoesBucket, taxable: taxable * shareA, tax: taxable * shareA * rules.swingRate }
      etfBucket = { ...etfBucket, taxable: taxable * (1 - shareA), tax: taxable * (1 - shareA) * rules.etfRate }
    }
    acoesBucket.lossCarryAfter = carry.comum
    etfBucket.lossCarryAfter = carry.comum
    const acoes = { bucket: acoesBucket }
    const etf = { bucket: etfBucket }
    const fii = settleBucket(m.fii, rules.fiiRate, carry.fii, null)
    carry.fii = fii.lossCarry
    const dt = settleBucket(m.dayTrade, rules.dayTradeRate, carry.daytrade, null)
    carry.daytrade = dt.lossCarry

    const totalTax = acoes.bucket.tax + etf.bucket.tax + fii.bucket.tax + dt.bucket.tax
    irrfCredit += m.irrf
    const useCredit = Math.min(irrfCredit, totalTax)
    irrfCredit -= useCredit
    let due = totalTax - useCredit + darfCarry
    if (due > 0 && due < rules.minDarf) {
      darfCarry = due
      due = 0
    } else {
      darfCarry = 0
    }
    months.push({
      month: key,
      swingAcoes: acoes.bucket,
      swingEtf: etf.bucket,
      fii: fii.bucket,
      dayTrade: dt.bucket,
      irrfWithheld: m.irrf,
      totalTax,
      darfDue: due,
    })
  }

  return {
    months,
    positions: Array.from(positions, ([ticker, p]) => ({ ticker, qty: p.qty, avgCost: p.avgCost })),
    totalTax: months.reduce((a, m) => a + m.totalTax, 0),
    warnings,
    rules,
  }
}

// ---- Proventos ------------------------------------------------------------

export interface DividendRules {
  /** Retenção na fonte do JCP. */
  jcpRate: number
  /** Retenção sobre dividendos pagos por uma mesma fonte a uma PF acima do limite mensal. */
  highDividendRate: number
  highDividendMonthlyThreshold: number
}

/**
 * Premissas conforme meu conhecimento da Lei 15.270/2025 (retenção de 10% sobre o total pago por uma fonte a uma
 * PF residente quando excede R$ 50 mil no mês, a partir de 2026). CONFIRA a regra vigente: é configurável.
 */
export const DEFAULT_DIVIDEND_RULES: DividendRules = {
  jcpRate: 0.15,
  highDividendRate: 0.1,
  highDividendMonthlyThreshold: 50_000,
}

export interface DividendNet {
  gross: number
  withheld: number
  net: number
  note: string
}

/** JCP: 15% retido na fonte (definitivo para PF). */
export function jcpNet(gross: number, rules: DividendRules = DEFAULT_DIVIDEND_RULES): DividendNet {
  const withheld = gross * rules.jcpRate
  return { gross, withheld, net: gross - withheld, note: `JCP com retenção de ${(rules.jcpRate * 100).toFixed(0)}% na fonte.` }
}

/** Dividendos de uma mesma fonte no mês: retenção só se o total ultrapassar o limite. */
export function dividendNet(grossFromOneSourceInMonth: number, rules: DividendRules = DEFAULT_DIVIDEND_RULES): DividendNet {
  const over = grossFromOneSourceInMonth > rules.highDividendMonthlyThreshold
  const withheld = over ? grossFromOneSourceInMonth * rules.highDividendRate : 0
  return {
    gross: grossFromOneSourceInMonth,
    withheld,
    net: grossFromOneSourceInMonth - withheld,
    note: over
      ? `Acima de R$ ${rules.highDividendMonthlyThreshold.toLocaleString('pt-BR')}/mês por fonte: retenção de ${(rules.highDividendRate * 100).toFixed(0)}% (confirme a regra vigente).`
      : 'Abaixo do limite mensal por fonte: sem retenção (confirme a regra vigente).',
  }
}
