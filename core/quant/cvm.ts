// Fundamentos ponto-no-tempo (PIT) a partir dos dados abertos da CVM (DFP anual + FCA para ticker↔CNPJ).
//
// Por que PIT: cada linha só vale a partir de `DT_RECEB` (data em que a CVM recebeu o documento), e
// reapresentações (VERSAO > 1) geram novas linhas com data posterior — sem look-ahead.
//
// ATENÇÃO: a estrutura dos arquivos foi implementada a partir da documentação pública dos dados abertos
// (dados.cvm.gov.br) e coberta por testes com fixtures nesse formato; ela NÃO foi validada contra um download
// real neste ambiente de desenvolvimento (sem acesso à rede). Escala (MIL/UNIDADE), contas e nomes de colunas são
// tratados de forma tolerante, mas confira os resultados de algumas empresas antes de confiar.
//
// Limitações: só demonstrações anuais (DFP); o ITR trimestral não entra, então os indicadores ficam defasados
// até a próxima DFP. Números por ação usam o total de ações (ON+PN) e valem para todas as classes da empresa.

import { type Fundamentals, type StatementYear, buildFundamentalsFromStatements } from './fundamentals.ts'

export type CsvRow = Record<string, string>

export const CVM_BASE = 'https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC'

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

/** CSV da CVM: separador ';', possíveis aspas, cabeçalho normalizado (sem acento, MAIÚSCULO). */
export function parseCvmCsv(text: string): CsvRow[] {
  const clean = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ';') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || (row[0] ?? '') !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || (row[0] ?? '') !== '') rows.push(row)
  }
  if (rows.length < 2) return []
  const header = (rows[0] as string[]).map(h => stripAccents(h).toUpperCase().trim())
  return rows.slice(1).map(cells => {
    const out: CsvRow = {}
    header.forEach((h, i) => { out[h] = (cells[i] ?? '').trim() })
    return out
  })
}

// ---- ZIP (somente leitura; métodos 0 e 8) ---------------------------------------------------------

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Extrai todos os arquivos de um ZIP em memória. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('ZIP inválido: fim do diretório central não encontrado')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP inválido: entrada do diretório central corrompida')
    const method = view.getUint16(offset + 10, true)
    const compSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    if (compSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 não suportado')
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen))
    offset += 46 + nameLen + extraLen + commentLen

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP inválido: cabeçalho local corrompido')
    const localName = view.getUint16(localOffset + 26, true)
    const localExtra = view.getUint16(localOffset + 28, true)
    const start = localOffset + 30 + localName + localExtra
    const data = bytes.subarray(start, start + compSize)
    if (name.endsWith('/')) continue
    if (method === 0) out.set(name, data.slice())
    else if (method === 8) out.set(name, await inflateRaw(data))
    else throw new Error(`Método de compressão ${method} não suportado em ${name}`)
  }
  return out
}

// ---- Contas -----------------------------------------------------------------------------------------

interface Account {
  code: string
  label: string
  value: number
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

const digits = (v: string | undefined) => (v ?? '').replace(/\D/g, '')

function scaleOf(row: CsvRow): number {
  const e = stripAccents(row.ESCALA_MOEDA ?? '').toUpperCase()
  return e.startsWith('MIL') ? 1000 : e.startsWith('MILH') ? 1e6 : 1
}

const depth = (code: string) => code.split('.').length

function exact(accounts: Account[], code: string): number | null {
  const hit = accounts.find(a => a.code === code)
  return hit ? hit.value : null
}

function exactWithLabel(accounts: Account[], code: string, label: RegExp): number | null {
  const hit = accounts.find(a => a.code === code && label.test(stripAccents(a.label)))
  return hit ? hit.value : null
}

function sumWhere(accounts: Account[], predicate: (a: Account) => boolean): number | null {
  const hits = accounts.filter(predicate)
  return hits.length ? hits.reduce((acc, a) => acc + a.value, 0) : null
}

// "Atribuído a Sócios da Empresa Controladora" (lucro) / "Patrimônio Líquido Atribuído aos Controladores" (patrimônio)
const CONTROLLERS = /atribu\w+ (a|aos?) (socios da (empresa )?controladora|controladores|proprietarios)/

/** Demonstrações de um exercício (ÚLTIMO ou PENÚLTIMO) de um documento. */
export function statementFromAccounts(accounts: Account[], endDate: string | undefined): StatementYear {
  const norm = (a: Account) => stripAccents(a.label).toLowerCase()

  // Resultado antes do resultado financeiro e tributos: código padrão 3.05, com busca por rótulo como reserva.
  const ebit =
    exactWithLabel(accounts, '3.05', /antes do resultado financeiro/i) ??
    sumWhere(accounts, a => depth(a.code) === 2 && a.code.startsWith('3.') && /antes do resultado financeiro/.test(norm(a)))

  // lucro: atribuído aos controladores (3.11.xx) quando existir; senão o consolidado (3.11)
  const netIncome =
    sumWhere(accounts, a => a.code.startsWith('3.11.') && CONTROLLERS.test(norm(a))) ??
    exact(accounts, '3.11')

  // patrimônio líquido: conta de nível 2 do passivo (2.03 em industriais, 2.07/2.08 em financeiras)
  const equityParent = accounts.find(a => depth(a.code) === 2 && a.code.startsWith('2.') && /^patrimonio liquido/.test(norm(a)))
  const equity = equityParent
    ? sumWhere(accounts, a => a.code.startsWith(`${equityParent.code}.`) && (CONTROLLERS.test(norm(a)) || /^patrimonio liquido atribuido/.test(norm(a)))) ?? equityParent.value
    : null

  const cash =
    (exactWithLabel(accounts, '1.01.01', /caixa/i) ?? 0) + (exactWithLabel(accounts, '1.01.02', /aplicacoes financeiras/i) ?? 0)
  const hasCash = exactWithLabel(accounts, '1.01.01', /caixa/i) !== null || exactWithLabel(accounts, '1.01.02', /aplicacoes financeiras/i) !== null

  const dfc = accounts.filter(a => a.code.startsWith('6.'))
  const capexRaw = sumWhere(
    dfc,
    a =>
      a.code.startsWith('6.02.') &&
      depth(a.code) >= 3 &&
      /aquisicao|compra|adicoes|investimento/.test(norm(a)) &&
      /imobilizado|intangivel|propriedade/.test(norm(a)) &&
      !/venda|alienacao|baixa|recebimento/.test(norm(a))
  )
  const depreciation = sumWhere(dfc, a => a.code.startsWith('6.01.01') && /depreciacao|amortizacao/.test(norm(a)))
  const dividends = sumWhere(dfc, a => a.code.startsWith('6.03') && /dividendos|juros sobre o capital proprio|jcp/.test(norm(a)) && /pagos?/.test(norm(a)))

  return {
    endDate,
    revenue: exact(accounts, '3.01'),
    grossProfit: exact(accounts, '3.03'),
    netIncome,
    ebit,
    totalAssets: exact(accounts, '1'),
    currentAssets: exact(accounts, '1.01'),
    currentLiabilities: exact(accounts, '2.01'),
    longTermDebt: exactWithLabel(accounts, '2.02.01', /emprestimos|financiamentos/i),
    sharesOutstanding: null,
    operatingCashFlow: exact(accounts, '6.01'),
    capex: capexRaw === null ? null : Math.abs(capexRaw),
    equity,
    cash: hasCash ? cash : null,
    shortTermDebt: exactWithLabel(accounts, '2.01.04', /emprestimos|financiamentos/i),
    dividendsPaid: dividends === null ? null : Math.abs(dividends),
    depreciation: depreciation === null ? null : Math.abs(depreciation),
  }
}

export interface CvmInputs {
  /** Índice de documentos (dfp_cia_aberta_AAAA.csv). */
  docs: CsvRow[]
  /** Linhas dos demonstrativos consolidados (BPA, BPP, DRE, DFC). */
  statements: CsvRow[]
  /** Composição do capital (quantidade de ações). */
  capital: CsvRow[]
  /** Valores mobiliários do FCA (ticker ↔ CNPJ). */
  fca: CsvRow[]
  /** Tickers do universo (ex.: PETR4.SA). */
  tickers: Array<{ ticker: string; isFinancial?: boolean }>
}

export interface CvmBuildResult {
  rows: Fundamentals[]
  /** Tickers do universo sem CNPJ identificado no FCA. */
  unmapped: string[]
  docsUsed: number
}

/** ticker (PETR4.SA) → CNPJ (só dígitos), a partir do FCA e restrito ao universo. */
export function buildTickerCnpjMap(fca: CsvRow[], universe: string[]): Map<string, string> {
  const wanted = new Set(universe.map(t => t.replace(/\.SA$/i, '').toUpperCase()))
  const out = new Map<string, string>()
  for (const row of fca) {
    const code = (row.CODIGO_NEGOCIACAO ?? '').toUpperCase().trim()
    const cnpj = digits(row.CNPJ_COMPANHIA ?? row.CNPJ_CIA)
    if (code && cnpj && wanted.has(code)) out.set(`${code}.SA`, cnpj)
  }
  return out
}

/** Constrói a linha PIT de cada DFP recebida (e reapresentações) para cada ticker do universo. */
export function buildCvmFundamentals(input: CvmInputs): CvmBuildResult {
  const tickerCnpj = buildTickerCnpjMap(input.fca, input.tickers.map(t => t.ticker))
  const unmapped = input.tickers.map(t => t.ticker).filter(t => !tickerCnpj.has(t))
  const isFinancial = new Map(input.tickers.map(t => [t.ticker, t.isFinancial]))

  const byCnpj = new Map<string, string[]>()
  for (const [ticker, cnpj] of tickerCnpj) byCnpj.set(cnpj, [...(byCnpj.get(cnpj) ?? []), ticker])

  // contas por documento (CNPJ|DT_REFER|VERSAO) e exercício
  const accountsByDoc = new Map<string, { ULTIMO: Account[]; PENULTIMO: Account[]; endDates: { ULTIMO?: string; PENULTIMO?: string } }>()
  for (const row of input.statements) {
    const cnpj = digits(row.CNPJ_CIA)
    if (!byCnpj.has(cnpj)) continue
    const order = stripAccents(row.ORDEM_EXERC ?? '').toUpperCase().startsWith('PENULT') ? 'PENULTIMO' : 'ULTIMO'
    const value = num(row.VL_CONTA)
    if (value === null || !row.CD_CONTA) continue
    const key = `${cnpj}|${row.DT_REFER}|${row.VERSAO}`
    const entry = accountsByDoc.get(key) ?? { ULTIMO: [], PENULTIMO: [], endDates: {} }
    entry[order].push({ code: row.CD_CONTA, label: row.DS_CONTA ?? '', value: value * scaleOf(row) })
    if (row.DT_FIM_EXERC) entry.endDates[order] = row.DT_FIM_EXERC
    accountsByDoc.set(key, entry)
  }

  const sharesByDoc = new Map<string, number>()
  for (const row of input.capital) {
    const total = num(row.QT_ACAO_TOTAL_CAPITAL_INTEGR) ?? ((num(row.QT_ACAO_ORDINARIA_CAPITAL_INTEGR) ?? 0) + (num(row.QT_ACAO_PREFERENCIAL_CAPITAL_INTEGR) ?? 0))
    const treasury = num(row.QT_ACAO_TOTAL_TESOURO) ?? ((num(row.QT_ACAO_ORDINARIA_TESOURO) ?? 0) + (num(row.QT_ACAO_PREFERENCIAL_TESOURO) ?? 0))
    if (total > 0) sharesByDoc.set(`${digits(row.CNPJ_CIA)}|${row.DT_REFER}|${row.VERSAO}`, total - treasury)
  }

  const docsByCnpj = new Map<string, CsvRow[]>()
  for (const doc of input.docs) {
    const cnpj = digits(doc.CNPJ_CIA)
    if (!byCnpj.has(cnpj) || !doc.DT_RECEB) continue
    docsByCnpj.set(cnpj, [...(docsByCnpj.get(cnpj) ?? []), doc])
  }

  const rows: Fundamentals[] = []
  let docsUsed = 0
  for (const [cnpj, docs] of docsByCnpj) {
    docs.sort((a, b) => (a.DT_RECEB as string).localeCompare(b.DT_RECEB as string) || Number(a.VERSAO) - Number(b.VERSAO))
    let previous: ReturnType<typeof accountsByDoc.get> | undefined
    for (const doc of docs) {
      const key = `${cnpj}|${doc.DT_REFER}|${doc.VERSAO}`
      const entry = accountsByDoc.get(key)
      if (!entry || entry.ULTIMO.length === 0) continue
      // somente o que estava disponível em DT_RECEB: este documento (2 exercícios) + o anterior já divulgado
      const statements = [
        statementFromAccounts(entry.ULTIMO, entry.endDates.ULTIMO ?? doc.DT_REFER),
        ...(entry.PENULTIMO.length ? [statementFromAccounts(entry.PENULTIMO, entry.endDates.PENULTIMO)] : []),
        ...(previous?.PENULTIMO.length ? [statementFromAccounts(previous.PENULTIMO, previous.endDates.PENULTIMO)] : []),
      ]
      const shares = sharesByDoc.get(key) ?? null
      docsUsed++
      for (const ticker of byCnpj.get(cnpj) as string[]) {
        rows.push(
          buildFundamentalsFromStatements(
            { ticker, asOf: doc.DT_REFER as string, availableAt: doc.DT_RECEB, isFinancial: isFinancial.get(ticker) },
            statements,
            shares
          )
        )
      }
      previous = entry
    }
  }
  return { rows, unmapped, docsUsed }
}

// ---- Download ---------------------------------------------------------------------------------------

export interface CvmSyncOptions {
  years: number[]
  tickers: Array<{ ticker: string; isFinancial?: boolean }>
  fetchFn?: typeof fetch
  log?: (message: string, data?: Record<string, unknown>) => void
}

export interface CvmSyncResult extends CvmBuildResult {
  years: number[]
  failedYears: number[]
}

async function fetchZip(url: string, fetchFn: typeof fetch): Promise<Map<string, Uint8Array> | null> {
  const res = await fetchFn(url)
  if (!res.ok) return null
  return unzip(new Uint8Array(await res.arrayBuffer()))
}

function pickFiles(files: Map<string, Uint8Array>, pattern: RegExp): CsvRow[] {
  const out: CsvRow[] = []
  for (const [name, data] of files) if (pattern.test(name.toLowerCase())) out.push(...parseCvmCsv(decodeLatin1(data)))
  return out
}

/** Baixa DFP (e FCA) da CVM para os anos pedidos e monta as linhas PIT. */
export async function syncCvmFundamentals(options: CvmSyncOptions): Promise<CvmSyncResult> {
  const fetchFn = options.fetchFn ?? fetch
  const log = options.log ?? (() => undefined)
  const docs: CsvRow[] = []
  const statements: CsvRow[] = []
  const capital: CsvRow[] = []
  const fca: CsvRow[] = []
  const failedYears: number[] = []

  for (const year of [...options.years].sort()) {
    try {
      const dfp = await fetchZip(`${CVM_BASE}/DFP/DADOS/dfp_cia_aberta_${year}.zip`, fetchFn)
      if (!dfp) {
        failedYears.push(year)
        continue
      }
      docs.push(...pickFiles(dfp, new RegExp(`^dfp_cia_aberta_${year}\\.csv$`)))
      statements.push(...pickFiles(dfp, /_(bpa|bpp|dre|dfc_md|dfc_mi)_con_\d{4}\.csv$/))
      capital.push(...pickFiles(dfp, /composicao_capital/))
      const fcaZip = await fetchZip(`${CVM_BASE}/FCA/DADOS/fca_cia_aberta_${year}.zip`, fetchFn)
      if (fcaZip) fca.push(...pickFiles(fcaZip, /valor_mobiliario/))
      log('CVM ano carregado', { year, docs: docs.length })
    } catch (error: any) {
      log('CVM falha no ano', { year, error: error.message })
      failedYears.push(year)
    }
  }

  const built = buildCvmFundamentals({ docs, statements, capital, fca, tickers: options.tickers })
  return { ...built, years: options.years, failedYears }
}
