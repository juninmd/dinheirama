// Custos de transação, impacto de mercado e IR de swing trade (ações, pessoa física).
// Premissas explícitas e configuráveis: regras e taxas mudam, confira antes de operar.
// Inspiração: Bogle (custos corroem retorno) e Almgren/Kyle (impacto ~ raiz do volume relativo).

export interface CostConfig {
  /** Corretagem por ordem em R$ (muitas corretoras cobram 0 em ações à vista). */
  brokerageFixed: number
  /** Emolumentos + liquidação B3 (fração do financeiro, por lado). Default aprox. 0,0325%. */
  exchangeFeeRate: number
  /** Coeficiente do modelo de impacto: custo = k * sqrt(ordem / ADV) (k = 0,01 => 1% de impacto a 100% do ADV). */
  impactCoefficient: number
  /** Spread/slippage mínimo por lado (fração). */
  minSlippage: number
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  brokerageFixed: 0,
  exchangeFeeRate: 0.000325,
  impactCoefficient: 0.01,
  minSlippage: 0.0005,
}

/**
 * Custo de uma ordem em fração do financeiro negociado.
 * `adv` = volume financeiro médio diário (R$). Sem ADV, usa só o piso de slippage.
 */
export function tradeCostRate(orderValue: number, adv: number | null | undefined, config: CostConfig = DEFAULT_COST_CONFIG): number {
  if (orderValue <= 0) return 0
  const fixed = config.brokerageFixed / orderValue
  const impact = adv && adv > 0 ? config.impactCoefficient * Math.sqrt(orderValue / adv) : 0
  // slippage = max(piso, impacto de raiz quadrada), limitado a 5% por segurança.
  const slippage = Math.min(0.05, Math.max(config.minSlippage, impact))
  return config.exchangeFeeRate + slippage + fixed
}

export interface LiquidityCheck {
  ok: boolean
  participation: number | null
  reason?: string
}

/** Verifica se a ordem é pequena em relação ao volume diário (default máx. 10% do ADV). */
export function checkLiquidity(orderValue: number, adv: number | null | undefined, maxParticipation = 0.1): LiquidityCheck {
  if (!adv || adv <= 0) return { ok: false, participation: null, reason: 'Sem dado de volume (ADV) para avaliar liquidez.' }
  const participation = orderValue / adv
  if (participation > maxParticipation) {
    return { ok: false, participation, reason: `Ordem = ${(participation * 100).toFixed(1)}% do volume diário (limite ${(maxParticipation * 100).toFixed(0)}%).` }
  }
  return { ok: true, participation }
}

// ---- IR swing trade -------------------------------------------------------

export interface TaxConfig {
  /** Alíquota swing trade em ações (15%). */
  rate: number
  /** Isenção quando o total de vendas no mês é <= este valor (R$ 20.000). */
  monthlySalesExemption: number
}

export const DEFAULT_TAX_CONFIG: TaxConfig = { rate: 0.15, monthlySalesExemption: 20000 }

export interface MonthlyTaxInput {
  /** Total vendido no mês (R$). */
  sales: number
  /** Lucro (+) ou prejuízo (-) realizado no mês, já líquido de custos. */
  realizedPnl: number
}

export interface MonthlyTaxResult {
  tax: number
  lossCarryAfter: number
  exempt: boolean
}

/**
 * IR mensal de swing trade com compensação de prejuízos.
 * - vendas <= R$ 20 mil: lucro isento (não consome nem gera prejuízo acumulado positivo);
 * - prejuízo do mês soma ao saldo de prejuízo a compensar;
 * - lucro do mês é reduzido pelo prejuízo acumulado antes de aplicar 15%.
 */
export function monthlySwingTax(
  input: MonthlyTaxInput,
  lossCarry: number,
  config: TaxConfig = DEFAULT_TAX_CONFIG
): MonthlyTaxResult {
  if (input.realizedPnl < 0) {
    return { tax: 0, lossCarryAfter: lossCarry + -input.realizedPnl, exempt: false }
  }
  if (input.sales <= config.monthlySalesExemption) {
    return { tax: 0, lossCarryAfter: lossCarry, exempt: true }
  }
  const offset = Math.min(lossCarry, input.realizedPnl)
  const taxable = input.realizedPnl - offset
  return { tax: taxable * config.rate, lossCarryAfter: lossCarry - offset, exempt: false }
}

/** Acumula custo médio por ativo e apura lucro realizado nas vendas. */
export class CostBasisBook {
  private readonly lots = new Map<string, { qty: number; avgCost: number }>()

  buy(ticker: string, qty: number, price: number, fees = 0): void {
    if (qty <= 0) return
    const lot = this.lots.get(ticker) ?? { qty: 0, avgCost: 0 }
    const total = lot.qty * lot.avgCost + qty * price + fees
    lot.qty += qty
    lot.avgCost = lot.qty > 0 ? total / lot.qty : 0
    this.lots.set(ticker, lot)
  }

  /** Retorna o lucro realizado (já descontadas as taxas de venda). */
  sell(ticker: string, qty: number, price: number, fees = 0): number {
    const lot = this.lots.get(ticker)
    if (!lot || qty <= 0) return 0
    const sold = Math.min(qty, lot.qty)
    const pnl = sold * (price - lot.avgCost) - fees
    lot.qty -= sold
    if (lot.qty <= 1e-9) this.lots.delete(ticker)
    return pnl
  }

  quantity(ticker: string): number {
    return this.lots.get(ticker)?.qty ?? 0
  }
}
