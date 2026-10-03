import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { deflateRawSync } from 'zlib'
import { Hono } from 'hono'
import { runBacktest } from './backtest.ts'
import {
  type CsvRow,
  buildCvmFundamentals,
  buildTickerCnpjMap,
  decodeLatin1,
  parseCvmCsv,
  statementFromAccounts,
  syncCvmFundamentals,
  unzip,
} from './cvm.ts'
import { FundamentalsHistory, parseFundamentalsCsv, repriceFundamentals } from './fundamentals.ts'
import { type Ips, checkCompliance, ipsSchema } from './ips.ts'
import { Journal, journalInputSchema } from './journal.ts'
import { alignPanel, monthStartIndexes } from './panel.ts'
import { applyCapsDetailed, type ConstructionResult } from './portfolio.ts'
import { IpsStore, crossSiteWriteGuard, loadPit, registerQuantRoutes } from './routes.ts'
import { createQuantService } from './service.ts'
import { eligibleTickers, type Strategy } from './strategies.ts'
import { DEFAULT_SYNTH_ASSETS, businessDates, syntheticMarketData } from './test-helpers.ts'
import { UniverseHistory, parseUniverseHistoryCsv } from './universe.ts'
import type { UniverseAsset } from './universe.ts'

// ---------- helpers ----------
function makeZip(files: Record<string, Buffer>): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const comp = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    parts.push(local, nameBuf, comp)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]))
}

const latin1 = (text: string) => Buffer.from(text, 'latin1')

const CNPJ = '33.000.167/0001-01'
const HEADER_DOC = 'CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;CATEG_DOC;ID_DOC;DT_RECEB;LINK_DOC'
const HEADER_ACC = 'CNPJ_CIA;DT_REFER;VERSAO;DENOM_CIA;CD_CVM;GRUPO_DFP;MOEDA;ESCALA_MOEDA;ORDEM_EXERC;DT_INI_EXERC;DT_FIM_EXERC;CD_CONTA;DS_CONTA;VL_CONTA;ST_CONTA_FIXA'

/** Linhas de demonstrativo (em MIL R$) de uma empresa fictícia. */
function accountRows(dtRefer: string, versao: number, ordem: 'ÚLTIMO' | 'PENÚLTIMO', fimExerc: string, k: number): CsvRow[] {
  const mk = (code: string, label: string, value: number): CsvRow => ({
    CNPJ_CIA: CNPJ, DT_REFER: dtRefer, VERSAO: String(versao), DENOM_CIA: 'EMPRESA', CD_CVM: '1', GRUPO_DFP: 'DF Consolidado', MOEDA: 'REAL', ESCALA_MOEDA: 'MIL',
    ORDEM_EXERC: ordem, DT_INI_EXERC: '', DT_FIM_EXERC: fimExerc, CD_CONTA: code, DS_CONTA: label, VL_CONTA: String(value), ST_CONTA_FIXA: 'S',
  })
  return [
    mk('1', 'Ativo Total', 20_000 * k),
    mk('1.01', 'Ativo Circulante', 6_000 * k),
    mk('1.01.01', 'Caixa e Equivalentes de Caixa', 1_500 * k),
    mk('1.01.02', 'Aplicações Financeiras', 500 * k),
    mk('2.01', 'Passivo Circulante', 4_000 * k),
    mk('2.01.04', 'Empréstimos e Financiamentos', 1_000 * k),
    mk('2.02.01', 'Empréstimos e Financiamentos', 3_000 * k),
    mk('2.03', 'Patrimônio Líquido Consolidado', 9_000 * k),
    mk('2.03.01', 'Patrimônio Líquido Atribuído aos Controladores', 8_500 * k),
    mk('3.01', 'Receita de Venda de Bens e/ou Serviços', 10_000 * k),
    mk('3.03', 'Resultado Bruto', 4_000 * k),
    mk('3.05', 'Resultado Antes do Resultado Financeiro e dos Tributos', 2_000 * k),
    mk('3.11', 'Lucro/Prejuízo Consolidado do Período', 1_500 * k),
    mk('3.11.01', 'Atribuído a Sócios da Empresa Controladora', 1_400 * k),
    mk('6.01', 'Caixa Líquido Atividades Operacionais', 2_200 * k),
    mk('6.01.01.02', 'Depreciação e Amortização', 600 * k),
    mk('6.02.01', 'Aquisição de Imobilizado', -900 * k),
    mk('6.03.01', 'Dividendos e JCP Pagos', -500 * k),
  ]
}

const docs: CsvRow[] = [
  { CNPJ_CIA: CNPJ, DT_REFER: '2023-12-31', VERSAO: '1', DENOM_CIA: 'EMPRESA', CD_CVM: '1', CATEG_DOC: 'DFP', ID_DOC: '10', DT_RECEB: '2024-02-20', LINK_DOC: '' },
  { CNPJ_CIA: CNPJ, DT_REFER: '2024-12-31', VERSAO: '1', DENOM_CIA: 'EMPRESA', CD_CVM: '1', CATEG_DOC: 'DFP', ID_DOC: '11', DT_RECEB: '2025-02-18', LINK_DOC: '' },
  { CNPJ_CIA: CNPJ, DT_REFER: '2024-12-31', VERSAO: '2', DENOM_CIA: 'EMPRESA', CD_CVM: '1', CATEG_DOC: 'DFP', ID_DOC: '12', DT_RECEB: '2025-04-10', LINK_DOC: '' },
]
const statements: CsvRow[] = [
  ...accountRows('2023-12-31', 1, 'ÚLTIMO', '2023-12-31', 1.0),
  ...accountRows('2023-12-31', 1, 'PENÚLTIMO', '2022-12-31', 0.9),
  ...accountRows('2024-12-31', 1, 'ÚLTIMO', '2024-12-31', 1.2),
  ...accountRows('2024-12-31', 1, 'PENÚLTIMO', '2023-12-31', 1.0),
  // reapresentação (versão 2) com lucro corrigido
  ...accountRows('2024-12-31', 2, 'ÚLTIMO', '2024-12-31', 1.1),
  ...accountRows('2024-12-31', 2, 'PENÚLTIMO', '2023-12-31', 1.0),
]
const capital: CsvRow[] = [
  { CNPJ_CIA: CNPJ, DT_REFER: '2023-12-31', VERSAO: '1', QT_ACAO_TOTAL_CAPITAL_INTEGR: '1000000', QT_ACAO_TOTAL_TESOURO: '0' },
  { CNPJ_CIA: CNPJ, DT_REFER: '2024-12-31', VERSAO: '1', QT_ACAO_TOTAL_CAPITAL_INTEGR: '1000000', QT_ACAO_TOTAL_TESOURO: '10000' },
  { CNPJ_CIA: CNPJ, DT_REFER: '2024-12-31', VERSAO: '2', QT_ACAO_TOTAL_CAPITAL_INTEGR: '1000000', QT_ACAO_TOTAL_TESOURO: '10000' },
]
const fca: CsvRow[] = [
  { CNPJ_COMPANHIA: CNPJ, CODIGO_NEGOCIACAO: 'EMPR3' },
  { CNPJ_COMPANHIA: CNPJ, CODIGO_NEGOCIACAO: 'EMPR4' },
  { CNPJ_COMPANHIA: '11.111.111/0001-11', CODIGO_NEGOCIACAO: 'OUTR3' },
]
const universe = [{ ticker: 'EMPR3.SA' }, { ticker: 'EMPR4.SA' }, { ticker: 'SEMCNPJ3.SA' }]

describe('CVM: CSV, ZIP e contas', () => {
  test('parseCvmCsv: separador ;, aspas, cabeçalho sem acento e latin1', () => {
    const text = decodeLatin1(latin1('CNPJ_CIA;DS_CONTA;VL_CONTA\n1;"Patrimônio; Líquido";10,5\n2;Ação "x";3\n'))
    const rows = parseCvmCsv(text)
    expect(rows.length).toBe(2)
    expect(rows[0]?.DS_CONTA).toBe('Patrimônio; Líquido')
    expect(rows[0]?.VL_CONTA).toBe('10,5')
    expect(parseCvmCsv('')).toEqual([])
    expect(parseCvmCsv('só cabeçalho')).toEqual([])
    expect(parseCvmCsv('Descrição;Código\na;b')[0]).toEqual({ DESCRICAO: 'a', CODIGO: 'b' })
  })

  test('unzip lê arquivos deflate e rejeita ZIP inválido', async () => {
    const zip = makeZip({ 'a.csv': latin1('x;y\n1;2\n'), 'dir/b.csv': latin1('não;ação\n'), 'c.txt': Buffer.alloc(0) })
    const files = await unzip(zip)
    expect(Array.from(files.keys()).sort()).toEqual(['a.csv', 'c.txt', 'dir/b.csv'])
    expect(decodeLatin1(files.get('dir/b.csv') as Uint8Array)).toBe('não;ação\n')
    await expect(unzip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('ZIP inválido')
  })

  test('statementFromAccounts extrai receita, EBIT, lucro dos controladores, patrimônio, dívida e caixa', () => {
    const accounts = accountRows('2024-12-31', 1, 'ÚLTIMO', '2024-12-31', 1).map(r => ({ code: r.CD_CONTA as string, label: r.DS_CONTA as string, value: Number(r.VL_CONTA) * 1000 }))
    const s = statementFromAccounts(accounts, '2024-12-31')
    expect(s.revenue).toBe(10_000_000)
    expect(s.ebit).toBe(2_000_000)
    expect(s.netIncome).toBe(1_400_000) // atribuído aos controladores
    expect(s.equity).toBe(8_500_000) // atribuído aos controladores
    expect(s.totalAssets).toBe(20_000_000)
    expect(s.cash).toBe(2_000_000)
    expect(s.shortTermDebt).toBe(1_000_000)
    expect(s.longTermDebt).toBe(3_000_000)
    expect(s.capex).toBe(900_000)
    expect(s.depreciation).toBe(600_000)
    expect(s.dividendsPaid).toBe(500_000)
    expect(s.operatingCashFlow).toBe(2_200_000)
  })

  test('mapeia ticker↔CNPJ pelo FCA só para o universo', () => {
    const map = buildTickerCnpjMap(fca, universe.map(u => u.ticker))
    expect(map.get('EMPR3.SA')).toBe('33000167000101')
    expect(map.get('EMPR4.SA')).toBe('33000167000101')
    expect(map.has('OUTR3.SA')).toBe(false)
  })
})

describe('CVM: fundamentos ponto-no-tempo', () => {
  const built = buildCvmFundamentals({ docs, statements, capital, fca, tickers: universe })

  test('uma linha por documento e por ticker, disponível só em DT_RECEB; reapresentação gera linha posterior', () => {
    expect(built.unmapped).toEqual(['SEMCNPJ3.SA'])
    expect(built.docsUsed).toBe(3)
    const empr3 = built.rows.filter(r => r.ticker === 'EMPR3.SA')
    expect(empr3.map(r => r.availableAt)).toEqual(['2024-02-20', '2025-02-18', '2025-04-10'])
    expect(built.rows.filter(r => r.ticker === 'EMPR4.SA').length).toBe(3)
  })

  test('sem look-ahead: a linha de 2023 só tem dados de 2023 e anteriores', () => {
    const first = built.rows.find(r => r.ticker === 'EMPR3.SA' && r.availableAt === '2024-02-20')!
    expect(first.statements.map(s => s.endDate)).toEqual(['2023-12-31', '2022-12-31'])
    const second = built.rows.find(r => r.ticker === 'EMPR3.SA' && r.availableAt === '2025-02-18')!
    expect(second.statements.map(s => s.endDate)).toEqual(['2024-12-31', '2023-12-31', '2022-12-31']) // 3º exercício vem do documento anterior
  })

  test('histórico PIT: antes da divulgação não há dado; versão corrigida só vale depois do reenvio', () => {
    const history = new FundamentalsHistory(built.rows)
    expect(history.asOf('EMPR3.SA', '2024-02-19')).toBeNull()
    expect(history.asOf('EMPR3.SA', '2025-03-01')?.statements[0]?.netIncome).toBe(1_400_000 * 1.2) // versão 1
    expect(history.asOf('EMPR3.SA', '2025-05-01')?.statements[0]?.netIncome).toBe(1_400_000 * 1.1) // versão 2 (reapresentada)
  })

  test('múltiplos dependem do preço da data (repricing) e ações excluem a tesouraria', () => {
    const history = new FundamentalsHistory(built.rows)
    const at = (price: number) => history.asOf('EMPR3.SA', '2025-03-01', price)!
    const low = at(10)
    const high = at(20)
    expect(low.shares).toBe(990_000)
    expect(low.marketCap).toBe(10 * 990_000)
    expect(high.trailingPE).toBeCloseTo(2 * (low.trailingPE as number), 8)
    expect(high.priceToBook).toBeCloseTo(2 * (low.priceToBook as number), 8)
    expect(low.dividendYield).toBeCloseTo((500_000 * 1.2) / 990_000 / 10, 6) // dividendos pagos (versão 1: k=1,2) / ações / preço
    // sem preço, devolve a linha original (sem múltiplos)
    expect(history.asOf('EMPR3.SA', '2025-03-01')?.trailingPE).toBeNull()
    expect(repriceFundamentals({ ...low, shares: null }, 30)).toEqual({ ...low, shares: null })
  })

  test('campos derivados: ROE, margens, alavancagem, EBITDA e FCF', () => {
    const f = built.rows.find(r => r.ticker === 'EMPR3.SA' && r.availableAt === '2024-02-20')!
    expect(f.roe).toBeCloseTo(1_400_000 / 8_500_000, 8) // lucro e patrimônio atribuídos aos controladores
    expect(f.operatingMargin).toBeCloseTo(0.2, 8)
    expect(f.grossMargin).toBeCloseTo(0.4, 8)
    expect(f.netDebt).toBe(4_000_000 - 2_000_000)
    expect(f.ebitda).toBe(2_000_000 + 600_000)
    expect(f.freeCashFlow).toBe(2_200_000 - 900_000)
    expect(f.currentRatio).toBeCloseTo(1.5, 8)
  })

  test('syncCvmFundamentals baixa DFP/FCA (zip), monta as linhas e reporta anos com falha', async () => {
    const csv = (rows: CsvRow[], header: string) => latin1([header, ...rows.map(r => header.split(';').map(h => r[h.toUpperCase()] ?? '').join(';'))].join('\n'))
    const dfpZip = makeZip({
      'dfp_cia_aberta_2024.csv': csv(docs, HEADER_DOC),
      'dfp_cia_aberta_DRE_con_2024.csv': csv(statements, HEADER_ACC),
      'dfp_cia_aberta_composicao_capital_2024.csv': csv(capital, 'CNPJ_CIA;DT_REFER;VERSAO;QT_ACAO_TOTAL_CAPITAL_INTEGR;QT_ACAO_TOTAL_TESOURO'),
    })
    const fcaZip = makeZip({ 'fca_cia_aberta_valor_mobiliario_2024.csv': csv(fca, 'CNPJ_Companhia;Codigo_Negociacao') })
    const fetchFn = (async (url: string) => {
      if (url.includes('/DFP/') && url.includes('2024')) return new Response(dfpZip as unknown as BodyInit)
      if (url.includes('/FCA/') && url.includes('2024')) return new Response(fcaZip as unknown as BodyInit)
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch
    const r = await syncCvmFundamentals({ years: [2023, 2024], tickers: universe, fetchFn })
    expect(r.failedYears).toEqual([2023])
    expect(r.rows.length).toBe(6)
    expect(r.unmapped).toEqual(['SEMCNPJ3.SA'])
  })
})

describe('universo histórico e deslistagem', () => {
  const csv = 'ticker,from,to\nOLD3,2015-01-01,2019-06-30\nNEW3,2020-03-01,\nbad,xx,\nOLD3,2019-12-31,2019-01-01'

  test('parse valida datas, normaliza tickers e conta rejeições', () => {
    const { ranges, rejected } = parseUniverseHistoryCsv(csv)
    expect(ranges.map(r => r.ticker)).toEqual(['OLD3.SA', 'NEW3.SA'])
    expect(rejected).toBe(2)
    expect(() => parseUniverseHistoryCsv('a,b\n1,2')).toThrow()
  })

  test('isMember: quem consta só vale dentro do intervalo; quem não consta vale sempre', () => {
    const h = new UniverseHistory(parseUniverseHistoryCsv(csv).ranges)
    expect(h.isMember('OLD3.SA', '2018-01-01')).toBe(true)
    expect(h.isMember('OLD3.SA', '2019-07-01')).toBe(false)
    expect(h.isMember('NEW3.SA', '2020-02-29')).toBe(false)
    expect(h.isMember('NEW3.SA', '2025-01-01')).toBe(true)
    expect(h.isMember('QUALQUER3.SA', '2000-01-01')).toBe(true)
    expect(new UniverseHistory(parseUniverseHistoryCsv(csv).ranges).version).toBe(h.version)
    expect(new UniverseHistory([]).version).not.toBe(h.version)
  })

  const dates = businessDates('2018-01-02', 700)
  const panel = alignPanel(['A', 'B'].map(ticker => ({ ticker, dates, closes: dates.map((_, i) => 10 + i * 0.01), volumes: dates.map(() => 5_000_000) })))

  test('elegibilidade respeita o pertencimento na data do sinal', () => {
    const t = 400
    const base = { panel, t, date: dates[t] as string, prevWeights: {}, riskFree12m: 0.1 }
    expect(eligibleTickers(base)).toEqual(['A', 'B'])
    expect(eligibleTickers({ ...base, isMember: (tk: string) => tk !== 'B' })).toEqual(['A'])
  })

  test('backtest com universo histórico não compra o ativo antes de ele entrar', () => {
    const sig = monthStartIndexes(dates).filter(i => i >= 30)
    const both: Strategy = { name: 'both', label: 'both', rebalance: ctx => Object.fromEntries(eligibleTickers(ctx, { minHistory: 20, minAdv: 0 }).map(tk => [tk, 0.5])) }
    const cfg = { cost: null, tax: null, warmup: 30, riskFreeAnnual: 0, rebalanceBand: 0 }
    const withAll = runBacktest(panel, both, cfg)!
    const joinDate = dates[sig[3] as number] as string
    const history = runBacktest(panel, both, { ...cfg, universeAt: (tk: string, d: string) => tk !== 'B' || d >= joinDate })!
    expect(history.avgPositions).toBeLessThan(withAll.avgPositions)
    expect(history.caveats.join(' ')).toContain('Universo histórico')
  })

  test('ativo sem cotação por muitos pregões é liquidado com perda assumida (deslistagem)', () => {
    const live = dates.map((_, i) => 10 + i * 0.01)
    const delisted = alignPanel([
      { ticker: 'LIVE', dates, closes: live, volumes: dates.map(() => 5_000_000) },
      { ticker: 'DEAD', dates: dates.slice(0, 200), closes: Array(200).fill(10), volumes: Array(200).fill(5_000_000) },
    ])
    const hold: Strategy = { name: 'hold-dead', label: 'hold-dead', rebalance: () => ({ DEAD: 0.5, LIVE: 0.5 }) }
    const cfg = { cost: null, tax: null, warmup: 30, riskFreeAnnual: 0, rebalanceBand: 0 }
    const r = runBacktest(delisted, hold, { ...cfg, delistingHaircut: 0.5, delistingStaleDays: 10 })!
    expect(r.delistings).toBe(1)
    expect(r.caveats.join(' ')).toContain('perda assumida de 50%')
    const noLoss = runBacktest(delisted, hold, { ...cfg, delistingHaircut: 0, delistingStaleDays: 10 })!
    expect(r.net.totalReturn).toBeLessThan(noLoss.net.totalReturn)
  })

  test('IR do mês é reservado: o caixa nunca fica negativo (revisão)', () => {
    const exits = monthStartIndexes(dates).filter(i => i >= 30)
    // sobe forte e a estratégia vende tudo e recompra no mesmo dia: gera imposto e precisa do caixa
    const grow = alignPanel([{ ticker: 'A', dates, closes: dates.map((_, i) => 10 * 1.004 ** i), volumes: dates.map(() => 5_000_000) }])
    const churn: Strategy = { name: 'churn', label: 'churn', rebalance: ctx => (exits.indexOf(ctx.t) % 2 === 0 ? { A: 1 } : ({} as Record<string, number>)) }
    const r = runBacktest(grow, churn, { cost: null, warmup: 30, riskFreeAnnual: 0, rebalanceBand: 0, initialCapital: 500_000 })!
    expect(r.totalTax).toBeGreaterThan(0)
    expect(r.minCash).toBeGreaterThanOrEqual(-1e-6)
  })
})

describe('tetos inviáveis, IPS e PIT (revisão)', () => {
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)

  test('tetos viáveis: sem relaxamento e tetos respeitados', () => {
    const r = applyCapsDetailed([0.6, 0.2, 0.1, 0.05, 0.05], ['X', 'X', 'Y', 'Z', 'W'], { maxWeight: 0.3, maxSector: 0.4 })
    expect(r.relaxed).toBe(false)
    expect(sum(r.weights)).toBeCloseTo(1, 8)
    expect(Math.max(...r.weights)).toBeLessThanOrEqual(0.3 + 1e-6)
  })

  test('tetos inviáveis (5 ativos, 3 no mesmo setor): relaxa e ainda soma 1', () => {
    const r = applyCapsDetailed([0.4, 0.3, 0.1, 0.1, 0.1], ['X', 'X', 'X', 'Y', 'Z'], { maxWeight: 0.15, maxSector: 0.35 })
    expect(r.relaxed).toBe(true)
    expect(sum(r.weights)).toBeCloseTo(1, 8)
    expect(Math.max(...r.weights)).toBeLessThanOrEqual(r.effectiveMaxWeight + 1e-9)
    expect(r.effectiveMaxWeight).toBeGreaterThan(0.15)
  })

  test('29 ativos com teto de 3% e de 10% por setor: soma 1 e avisa', () => {
    const sectors = Array.from({ length: 29 }, (_, i) => `S${i % 8}`)
    const r = applyCapsDetailed(Array.from({ length: 29 }, () => 1), sectors, { maxWeight: 0.03, maxSector: 0.1 })
    expect(r.relaxed).toBe(true)
    expect(sum(r.weights)).toBeCloseTo(1, 8)
  })

  test('IPS: a checagem de estresse não reprova por arredondamento da fração em ações', () => {
    const ips: Ips = ipsSchema.parse({ objective: 'growth', horizonYears: 15, maxDrawdownTolerance: 0.25, capital: 100_000, emergencyFundMonths: 12 })
    const construction = { method: 'hrp', weights: [{ ticker: 'A', weight: 0.1, riskContribution: 0.1 }], diagnostics: {} } as unknown as ConstructionResult
    const stress = { worstScenarioLoss: -0.37, tail: {}, scenarios: [], shocks: [], correlationInCrisis: null } as never
    const result = checkCompliance(ips, construction, { A: 'X' }, stress)
    expect(result.checks.find(c => c.id === 'stress')?.ok).toBe(true)
    expect(result.equityShare * 0.37).toBeLessThanOrEqual(0.25)
  })

  test('CSV PIT: rejeita disponibilidade anterior ao período, data inválida e normaliza o ticker', () => {
    const csv = [
      'ticker,asOf,availableAt,trailingPE',
      'aaaa3,2023-12-31,2024-03-15,8',
      'AAAA3.SA,2024-12-31,2024-01-01,7', // divulgado antes do período: look-ahead
      'AAAA3.SA,xx,2024-05-01,6',
      'BBBB3,2023-12-31,2024-03-15,9',
    ].join('\n')
    const { rows, rejected } = parseFundamentalsCsv(csv)
    expect(rejected).toBe(2)
    expect(rows.map(r => r.ticker)).toEqual(['AAAA3.SA', 'BBBB3.SA'])
    const history = new FundamentalsHistory(rows)
    expect(history.asOf('AAAA3.SA', '2024-03-01')).toBeNull()
    expect(history.asOf('AAAA3.SA', '2024-04-01')?.trailingPE).toBe(8)
    expect(new FundamentalsHistory(rows).version).not.toBe(history.version)
  })

  test('journal corrompido é preservado em backup antes de ser sobrescrito', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'))
    const file = path.join(dir, 'journal.json')
    fs.writeFileSync(file, '{ não é json')
    const j = new Journal(file)
    expect(j.list()).toEqual([])
    j.add(journalInputSchema.parse({ ticker: 'PETR4.SA', action: 'buy', probability: 0.6, horizonDays: 30, entryPrice: 10 }))
    expect(fs.readdirSync(dir).some((f: string) => f.startsWith('journal.json.corrupt-'))).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ---------- rotas ----------
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const synthUniverse: UniverseAsset[] = DEFAULT_SYNTH_ASSETS.map((a, i) => ({ ticker: a.ticker, name: a.ticker, assetClass: 'stock', thesis: 't', sector: `S${i % 3}`, isFinancial: false }))

function setup(opts: { cvmSync?: Parameters<typeof registerQuantRoutes>[1]['cvmSync']; allowedOrigins?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant2-'))
  dirs.push(dir)
  const data = syntheticMarketData()
  let pit: FundamentalsHistory | null = null
  let uni: UniverseHistory | null = null
  const service = createQuantService({ data, universe: synthUniverse, riskFreeAnnual: 0.1, getPit: () => pit, getUniverseHistory: () => uni })
  const app = new Hono()
  registerQuantRoutes(app, {
    service, data, journal: new Journal(path.join(dir, 'journal.json')), ipsStore: new IpsStore(path.join(dir, 'ips.json')), riskFreeAnnual: 0.1, dataDir: dir,
    cvmTickers: synthUniverse.map(u => ({ ticker: u.ticker })), cvmSync: opts.cvmSync, allowedOrigins: opts.allowedOrigins,
    onPitChange: h => { pit = h }, onUniverseHistoryChange: h => { uni = h }, log: () => undefined,
  })
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, raw = false) => {
    const res = await app.request(url, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { app, call, dir, service, data }
}

const ipsBody = { objective: 'balanced', horizonYears: 10, maxDrawdownTolerance: 0.3, capital: 100_000, emergencyFundMonths: 8 }

describe('proteção contra escritas cross-site', () => {
  test('bloqueia Sec-Fetch-Site cross-site e same-site; aceita same-origin e clientes sem navegador', async () => {
    const { call } = setup()
    expect((await call('PUT', '/api/ips', ipsBody, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await call('PUT', '/api/ips', ipsBody, { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403)
    expect((await call('PUT', '/api/ips', ipsBody, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)
    expect((await call('PUT', '/api/ips', ipsBody)).status).toBe(200) // curl / bot
  })

  test('sem Sec-Fetch-Site compara Origin com Host; origens extras podem ser liberadas', async () => {
    const { call } = setup({ allowedOrigins: ['http://localhost:5173'] })
    expect((await call('POST', '/api/journal', { ticker: 'PETR4.SA', action: 'buy', probability: 0.6, horizonDays: 30, entryPrice: 10 }, { Origin: 'https://evil.example', Host: 'dinheirama.example' })).status).toBe(403)
    expect((await call('PUT', '/api/ips', ipsBody, { Origin: 'https://dinheirama.example', Host: 'dinheirama.example' })).status).toBe(200)
    expect((await call('PUT', '/api/ips', ipsBody, { Origin: 'http://localhost:5173', Host: 'localhost:3000' })).status).toBe(200)
    expect((await call('DELETE', '/api/ips', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })

  test('leituras (GET) não são afetadas e o middleware pode ser usado isoladamente', async () => {
    const { call } = setup()
    expect((await call('GET', '/api/ips', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200)
    const app = new Hono()
    app.use('*', crossSiteWriteGuard())
    app.post('/x', c => c.json({ ok: true }))
    expect((await app.request('/x', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
  })

  test('limite de tamanho do corpo: IPS acima de 64 KB e CSV acima de 8 MB são recusados', async () => {
    const { call } = setup()
    expect((await call('PUT', '/api/ips', { ...ipsBody, notes: 'x'.repeat(70 * 1024) })).status).toBe(413)
    expect((await call('PUT', '/api/fundamentals/pit', 'ticker,asOf,availableAt\n' + 'A,2024-01-01,2024-02-01\n'.repeat(400_000), {}, true)).status).toBe(413)
  })
})

describe('rotas: CVM, universo histórico, IR, Black-Litterman e PBO', () => {
  test('sincronização CVM injetada grava o JSON PIT, passa a ser a fonte ativa e o CSV a substitui depois', async () => {
    const built = buildCvmFundamentals({ docs, statements, capital, fca, tickers: universe })
    const { call, dir } = setup({ cvmSync: async () => ({ ...built, years: [2024], failedYears: [] }) })
    const sync = await call('POST', '/api/fundamentals/cvm/sync', { from: 2023, to: 2024 })
    expect(sync.status).toBe(200)
    expect(sync.body.source).toBe('cvm')
    expect(sync.body.rows).toBe(6)
    expect(sync.body.unmapped).toEqual(['SEMCNPJ3.SA'])
    expect(fs.existsSync(path.join(dir, 'fundamentals_pit.json'))).toBe(true)
    expect(loadPit(dir).source).toBe('cvm')
    expect((await call('GET', '/api/fundamentals/pit')).body).toMatchObject({ loaded: true, source: 'cvm', rows: 6, tickers: 2 })

    const csv = await call('PUT', '/api/fundamentals/pit', 'ticker,asOf,availableAt,trailingPE\nAAAA3,2023-12-31,2024-03-15,8', {}, true)
    expect(csv.body.source).toBe('csv')
    expect(fs.existsSync(path.join(dir, 'fundamentals_pit.json'))).toBe(false)
    expect((await call('GET', '/api/fundamentals/pit')).body.source).toBe('csv')
  })

  test('sincronização CVM sem dados responde 502, sem rede não inventa e bloqueia execuções simultâneas', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve: () => void) => { release = resolve })
    const { call } = setup({ cvmSync: async () => { await gate; return { rows: [], unmapped: [], docsUsed: 0, years: [2024], failedYears: [2024] } } })
    const first = call('POST', '/api/fundamentals/cvm/sync', {})
    await new Promise(r => setTimeout(r, 10))
    expect((await call('POST', '/api/fundamentals/cvm/sync', {})).status).toBe(409)
    release()
    const done = await first
    expect(done.status).toBe(502)
    expect(done.body.code).toBe('CVM_NO_DATA')
  })

  test('universo histórico: PUT valida, GET lista, e o backtest reflete o pertencimento (cache por versão)', async () => {
    const { call } = setup()
    expect((await call('PUT', '/api/universe/history', 'ticker,from\n', {}, true)).status).toBe(400)
    const before = await call('GET', '/api/backtest?years=4&topN=3')
    expect(before.body.universeHistory).toBe(false)
    const put = await call('PUT', '/api/universe/history', 'ticker,from,to\nAAAA3,2016-01-04,2018-12-31', {}, true)
    expect(put.status).toBe(200)
    expect(put.body.tickers).toEqual(['AAAA3.SA'])
    expect((await call('GET', '/api/universe/history')).body.loaded).toBe(true)
    const after = await call('GET', '/api/backtest?years=4&topN=3')
    expect(after.body.universeHistory).toBe(true)
    expect(after.body.caveats.join(' ')).toContain('Universo histórico')
    await call('DELETE', '/api/universe/history')
    expect((await call('GET', '/api/universe/history')).body.loaded).toBe(false)
  })

  test('/api/tax/report calcula IR de operações; valida entrada; regras e proventos', async () => {
    const { call } = setup()
    const ok = await call('POST', '/api/tax/report', { trades: [
      { date: '2024-01-02', ticker: 'petr4', side: 'buy', qty: 1000, price: 30 },
      { date: '2024-02-05', ticker: 'PETR4', side: 'sell', qty: 1000, price: 60 },
    ] })
    expect(ok.status).toBe(200)
    expect(ok.body.months[1].swingAcoes.tax).toBeCloseTo(4500, 6)
    expect(ok.body.disclaimer).toContain('contador')
    expect((await call('POST', '/api/tax/report', { trades: [] })).status).toBe(400)
    expect((await call('POST', '/api/tax/report', { trades: [{ date: 'x', ticker: 'A', side: 'buy', qty: 1, price: 1 }] })).status).toBe(400)
    expect((await call('GET', '/api/tax/rules')).body.trading.swingMonthlyExemption).toBe(20_000)
    const prov = await call('GET', '/api/tax/proventos?jcp=1000&dividendos=60000')
    expect(prov.body.jcp.net).toBeCloseTo(850, 8)
    expect(prov.body.dividendos.withheld).toBeCloseTo(6000, 8)
  })

  test('/api/portfolio/construct?method=bl usa capitalização e visões de fator', async () => {
    const { call } = setup()
    const { status, body } = await call('GET', '/api/portfolio/construct?method=bl&maxWeight=0.4&maxSector=0.8')
    expect(status).toBe(200)
    expect(body.construction.method).toBe('bl')
    expect(body.construction.blackLitterman.marketWeightsSource).toBe('capitalizacao')
    expect(body.construction.blackLitterman.views).toBeGreaterThan(0)
    expect(body.construction.diagnostics.capsRelaxed).toBeDefined()
  })

  test('relatório de backtest traz PBO sobre todas as variantes, em excesso ao CDI, e deduplica execuções simultâneas', async () => {
    const { service, data } = setup()
    let calls = 0
    const counting = { ...data, priceSeries: async (t: string, y: number) => { calls++; return data.priceSeries(t, y) } }
    const svc = createQuantService({ data: counting, universe: synthUniverse, riskFreeAnnual: 0.1 })
    const p1 = svc.runBacktests({ years: 4, topN: 3 })
    const p2 = svc.runBacktests({ years: 4, topN: 3 })
    expect(p1).toBe(p2) // mesma promessa: não roda duas vezes
    const report = (await p1)!
    expect(calls).toBe(synthUniverse.length)
    expect(report.pbo?.combinations).toBeGreaterThan(1000)
    expect(report.pbo?.variants).toBe(report.trialsCounted)
    expect(report.pbo?.pbo).toBeGreaterThanOrEqual(0)
    expect(report.pbo?.pbo).toBeLessThanOrEqual(1)
    expect(report.pointInTimeFundamentals).toBe(false)
    void service
  })
})
