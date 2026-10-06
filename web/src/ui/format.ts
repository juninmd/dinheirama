// Formatação e normalização compartilhadas pelas views.

import { fmtBrl, fmtSignedPoints, isNum } from '../research-dom'
import type { Action, Risk, Sentiment } from '../types'

export { NA, fmtBrl, fmtBrlCompact, fmtDate, fmtDateTime, fmtMult, fmtNum, fmtPct, fmtSigned, fmtSignedPct, fmtSignedPoints, isNum } from '../research-dom'

export const ACTION_LABEL: Record<Action, string> = { buy: 'Comprar', hold: 'Manter', sell: 'Vender' }
export const RISK_LABEL: Record<Risk, string> = { low: 'baixo', medium: 'médio', high: 'alto' }
export const SENTIMENT_LABEL: Record<Sentiment, string> = { bullish: 'Positivo', bearish: 'Negativo', neutral: 'Neutro' }

/** Tom semântico (cor + sinal no texto: a cor nunca é o único canal). */
export type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'neutral'

export const actionTone = (a: Action): Tone => (a === 'buy' ? 'pos' : a === 'sell' ? 'neg' : 'warn')
export const riskTone = (r: Risk): Tone => (r === 'low' ? 'pos' : r === 'high' ? 'neg' : 'warn')
export const sentimentTone = (s: Sentiment): Tone => (s === 'bullish' ? 'pos' : s === 'bearish' ? 'neg' : 'neutral')
export const signTone = (v: number | null | undefined): Tone => (!isNum(v) || v === 0 ? 'neutral' : v > 0 ? 'pos' : 'neg')

/** Faixa do RSI(14): abaixo de 30 = sobrevendido, acima de 70 = sobrecomprado. */
export function rsiTone(rsi: number | null | undefined): Tone {
  if (!isNum(rsi)) return 'neutral'
  return rsi < 30 ? 'pos' : rsi > 70 ? 'neg' : 'neutral'
}

export function rsiLabel(rsi: number | null | undefined): string {
  if (!isNum(rsi)) return 'sem dado'
  return rsi < 30 ? 'sobrevendido' : rsi > 70 ? 'sobrecomprado' : 'neutro'
}

export const fmtPrice = (v: unknown): string => fmtBrl(v, 2)
/** Variação já em pontos percentuais (a API devolve 1,23 para 1,23%). */
export const fmtChange = (v: unknown): string => fmtSignedPoints(v, 2)

/** "petr4" -> "PETR4.SA". Só completa o sufixo quando parece um código B3 (4–6 caracteres terminando em número). */
export function toTicker(raw: string): string {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '')
  if (!value) return ''
  return /^[A-Z0-9]{3,5}[0-9]$/.test(value) ? `${value}.SA` : value
}

export const isValidTicker = (ticker: string): boolean => /^[A-Z0-9]{4,6}\.[A-Z]{2}$/.test(ticker)

/** "PETR4.SA" -> "PETR4" (visual; a API sempre recebe o ticker completo). */
export const shortTicker = (ticker: string): string => ticker.replace(/\.SA$/i, '')

export function relTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '—'
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.round((now - time) / 1000)
  if (seconds < 45) return 'agora há pouco'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `há ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `há ${hours} h`
  return `há ${Math.round(hours / 24)} d`
}

/** Remove as marcações HTML do Telegram (<b>, <code>…) de mensagens do servidor, mantendo só o texto. */
export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '')
}

/** Universo monitorado (espelha core/quant/universe.ts): só alimenta sugestões; qualquer ticker B3 é aceito. */
export const UNIVERSE: ReadonlyArray<{ ticker: string; name: string }> = [
  { ticker: 'PETR4.SA', name: 'Petrobras PN' },
  { ticker: 'VALE3.SA', name: 'Vale ON' },
  { ticker: 'ITUB4.SA', name: 'Itaú Unibanco PN' },
  { ticker: 'WEGE3.SA', name: 'WEG ON' },
  { ticker: 'BBAS3.SA', name: 'Banco do Brasil ON' },
  { ticker: 'BBDC4.SA', name: 'Bradesco PN' },
  { ticker: 'RENT3.SA', name: 'Localiza ON' },
  { ticker: 'PRIO3.SA', name: 'Prio ON' },
  { ticker: 'MGLU3.SA', name: 'Magazine Luiza ON' },
  { ticker: 'B3SA3.SA', name: 'B3 ON' },
  { ticker: 'GGBR4.SA', name: 'Gerdau PN' },
  { ticker: 'JBSS3.SA', name: 'JBS ON' },
  { ticker: 'TOTS3.SA', name: 'TOTVS ON' },
  { ticker: 'RADL3.SA', name: 'Raia Drogasil ON' },
  { ticker: 'VIVT3.SA', name: 'Telefônica Brasil ON' },
  { ticker: 'TAEE11.SA', name: 'Taesa Unit' },
  { ticker: 'SUZB3.SA', name: 'Suzano ON' },
  { ticker: 'EQTL3.SA', name: 'Equatorial ON' },
  { ticker: 'CSNA3.SA', name: 'CSN ON' },
  { ticker: 'LREN3.SA', name: 'Lojas Renner ON' },
  { ticker: 'BBSE3.SA', name: 'BB Seguridade ON' },
  { ticker: 'CMIG4.SA', name: 'Cemig PN' },
  { ticker: 'CPLE6.SA', name: 'Copel PNB' },
  { ticker: 'CYRE3.SA', name: 'Cyrela ON' },
  { ticker: 'ELET3.SA', name: 'Eletrobras ON' },
  { ticker: 'SBSP3.SA', name: 'Sabesp ON' },
  { ticker: 'ASAI3.SA', name: 'Assaí ON' },
  { ticker: 'NATU3.SA', name: 'Natura ON' },
  { ticker: 'HAPV3.SA', name: 'Hapvida ON' },
]

export const POPULAR: readonly string[] = ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'BBAS3.SA', 'MGLU3.SA']

export function companyName(ticker: string): string | null {
  return UNIVERSE.find(u => u.ticker === ticker)?.name ?? null
}
