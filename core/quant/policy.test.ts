import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { type Ips, checkCompliance, deriveConstraints, ipsSchema } from './ips.ts'
import { Journal, brierScore, calibrationReport, journalInputSchema, logLoss, reliabilityBins } from './journal.ts'
import { DISCLAIMER, allowedNumbers, extractNumbers, guardedExplain, validateExplanation, type FactLine } from './llm-guard.ts'
import type { ConstructionResult } from './portfolio.ts'

const baseIps: Ips = ipsSchema.parse({
  objective: 'balanced',
  horizonYears: 10,
  maxDrawdownTolerance: 0.3,
  capital: 100_000,
  emergencyFundMonths: 8,
})

describe('IPS', () => {
  test('perfil saudável: adequado, HRP e fração em ações limitada pela tolerância de queda', () => {
    const c = deriveConstraints(baseIps, 0.5)
    expect(c.suitability).toBe('adequado')
    expect(c.method).toBe('hrp')
    // 30% de tolerância / 50% de pior cenário = 60% (< teto de 70% do perfil equilibrado)
    expect(c.maxEquityShare).toBeCloseTo(0.6, 3)
  })

  test('dívida cara, sem reserva e horizonte curto => inadequado e no máximo 10% em ações', () => {
    const c = deriveConstraints({ ...baseIps, hasHighInterestDebt: true, emergencyFundMonths: 1, horizonYears: 1 })
    expect(c.suitability).toBe('inadequado')
    expect(c.maxEquityShare).toBeLessThanOrEqual(0.1)
    expect(c.warnings.length).toBe(3)
  })

  test('horizonte de 3-5 anos pede cautela', () => {
    const c = deriveConstraints({ ...baseIps, horizonYears: 4 })
    expect(c.suitability).toBe('cautela')
    expect(c.maxEquityShare).toBeLessThanOrEqual(0.4)
  })

  test('preservação usa mínima variância e teto de 30%', () => {
    const c = deriveConstraints({ ...baseIps, objective: 'preservation', maxDrawdownTolerance: 0.9 })
    expect(c.method).toBe('minvar')
    expect(c.maxEquityShare).toBeLessThanOrEqual(0.3)
  })

  test('schema rejeita valores absurdos', () => {
    expect(ipsSchema.safeParse({ ...baseIps, maxDrawdownTolerance: 2 }).success).toBe(false)
    expect(ipsSchema.safeParse({ ...baseIps, capital: -1 }).success).toBe(false)
  })

  test('aderência: detecta concentração acima do limite', () => {
    const construction = {
      method: 'hrp',
      weights: [
        { ticker: 'A', weight: 0.4, riskContribution: 0.4 },
        { ticker: 'B', weight: 0.3, riskContribution: 0.3 },
        { ticker: 'C', weight: 0.3, riskContribution: 0.3 },
      ],
      diagnostics: {},
    } as unknown as ConstructionResult
    const result = checkCompliance({ ...baseIps, maxPositionWeight: 0.2, maxSectorWeight: 0.5 }, construction, { A: 'X', B: 'X', C: 'Y' }, null)
    expect(result.compliant).toBe(false)
    expect(result.checks.find(c => c.id === 'position')?.ok).toBe(false)
    expect(result.checks.find(c => c.id === 'sector')?.ok).toBe(false)
    expect(result.checks.find(c => c.id === 'stress')?.ok).toBe(true)
  })
})

describe('calibração', () => {
  test('Brier e log loss em casos conhecidos', () => {
    expect(brierScore([1, 0], [1, 0])).toBe(0)
    expect(brierScore([0.5, 0.5], [1, 0])).toBe(0.25)
    expect(logLoss([0.5, 0.5], [1, 0])).toBeCloseTo(Math.log(2), 8)
    expect(brierScore([], [])).toBeNull()
  })

  test('curva de confiabilidade agrupa por faixa', () => {
    const bins = reliabilityBins([0.1, 0.15, 0.9, 0.95], [0, 0, 1, 1], 5)
    expect(bins[0]?.count).toBe(2)
    expect(bins[0]?.observedFrequency).toBe(0)
    expect(bins[4]?.count).toBe(2)
    expect(bins[4]?.observedFrequency).toBe(1)
    expect(bins[2]?.meanForecast).toBeNull()
  })

  test('relatório alerta amostra pequena e mede habilidade vs taxa-base', () => {
    const mk = (p: number, outcome: 0 | 1) => ({
      id: `${p}${outcome}`, ticker: 'AAAA3.SA', action: 'buy' as const, probability: p, horizonDays: 30, entryPrice: 10, source: 'manual' as const,
      createdAt: '2024-01-01T00:00:00.000Z', dueAt: '2024-01-31T00:00:00.000Z', status: 'resolved' as const, outcome, returnPct: outcome ? 5 : -5, referenceReturnPct: 0,
    })
    const entries = [mk(0.9, 1), mk(0.9, 1), mk(0.1, 0), mk(0.1, 0)]
    const r = calibrationReport(entries)
    expect(r.resolved).toBe(4)
    expect(r.brier).toBeCloseTo(0.01, 8)
    expect(r.brierSkill).toBeGreaterThan(0.9)
    expect(r.warnings.some(w => w.includes('Apenas 4'))).toBe(true)
    expect(r.avgExcessReturnPctBuy).toBe(0)
  })
})

describe('diário', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'))
    dirs.push(d)
    return path.join(d, 'journal.json')
  }
  const input = journalInputSchema.parse({ ticker: 'PETR4.SA', action: 'buy', probability: 0.7, horizonDays: 30, entryPrice: 40 })

  test('persiste em disco e recarrega', () => {
    const file = tmp()
    const a = new Journal(file)
    const e = a.add(input, new Date('2024-01-02T10:00:00Z'))
    expect(e.dueAt.slice(0, 10)).toBe('2024-02-01')
    expect(new Journal(file).list().length).toBe(1)
    expect(a.remove(e.id)).toBe(true)
    expect(a.remove('nope')).toBe(false)
    expect(new Journal(file).list().length).toBe(0)
  })

  test('resolve só o que venceu e marca o resultado contra a referência', async () => {
    const j = new Journal(null)
    j.add(input, new Date('2024-01-02T10:00:00Z'))
    j.add({ ...input, ticker: 'VALE3.SA', horizonDays: 300 }, new Date('2024-01-02T10:00:00Z'))
    const lookup = async () => ({ exitPrice: 46, referenceReturn: 0.1 }) // +15% vs +10%
    const resolved = await j.resolveDue(lookup, new Date('2024-03-01T00:00:00Z'))
    expect(resolved.length).toBe(1)
    expect(resolved[0]?.outcome).toBe(1)
    expect(resolved[0]?.returnPct).toBeCloseTo(15, 8)
    expect(j.list().filter(e => e.status === 'open').length).toBe(1)
  })

  test('sem dado de preço a previsão continua aberta', async () => {
    const j = new Journal(null)
    j.add(input, new Date('2024-01-02T10:00:00Z'))
    expect((await j.resolveDue(async () => null, new Date('2025-01-01'))).length).toBe(0)
  })

  test('valida entrada (probabilidade 0 ou 1 é overconfidence)', () => {
    expect(journalInputSchema.safeParse({ ...input, probability: 1 }).success).toBe(false)
    expect(journalInputSchema.safeParse({ ...input, ticker: 'petr4' }).success).toBe(false)
  })
})

describe('guarda do LLM', () => {
  const facts: FactLine[] = [
    { label: 'Ativo', display: 'PETR4.SA' },
    { label: 'Score', display: '85/100', numbers: [85] },
    { label: 'Momentum', display: 'Momentum 12-1: 23,4%; volatilidade anual 31%.', numbers: [0.234, 0.31] },
    { label: 'Preço', display: 'R$ 1.234,56', numbers: [1234.56] },
  ]

  test('extrai números em formato brasileiro', () => {
    expect(extractNumbers('R$ 1.234,56 e 12,5% e -4%')).toEqual([1234.56, 12.5, -4])
    expect(extractNumbers('3.5x')).toEqual([3.5])
  })

  test('aceita variações (fração ↔ percentual, arredondamento) dos números da ficha', () => {
    const allowed = allowedNumbers(facts)
    expect(allowed.some(a => Math.abs(a - 23.4) < 1e-6)).toBe(true)
    expect(allowed.some(a => Math.abs(a - 31) < 1e-6)).toBe(true)
  })

  test('texto fiel aos fatos passa', () => {
    const v = validateExplanation('O score é 85, com momentum de 23,4% e volatilidade de 31%. Preço R$ 1.234,56.', facts)
    expect(v.ok).toBe(true)
  })

  test('número inventado reprova', () => {
    const v = validateExplanation('O preço-alvo é R$ 57,80 e o dividend yield é 9,3%.', facts)
    expect(v.ok).toBe(false)
    expect(v.unsupportedNumbers).toContain(57.8)
  })

  test('linguagem de certeza reprova mesmo sem números', () => {
    expect(validateExplanation('Retorno garantido, vai subir!', facts).ok).toBe(false)
    expect(validateExplanation('Compre agora, sem risco.', facts).forbidden.length).toBe(2)
  })

  test('ignora numeração de lista e anos', () => {
    expect(validateExplanation('1. Primeiro ponto em 2025. 2. Segundo ponto.', facts).ok).toBe(true)
  })

  test('guardedExplain usa o LLM quando válido e sempre acrescenta o aviso', async () => {
    const llm = { generate: async () => 'O score é 85 e a volatilidade é 31%.' }
    const r = await guardedExplain(llm, 'PETR4', facts, 'fallback')
    expect(r.source).toBe('llm')
    expect(r.text).toContain(DISCLAIMER)
  })

  test('guardedExplain cai no texto determinístico se o LLM inventar ou falhar', async () => {
    const liar = await guardedExplain({ generate: async () => 'Alvo de R$ 99,99 garantido.' }, 'PETR4', facts, 'texto seguro')
    expect(liar.source).toBe('template')
    expect(liar.text).toContain('texto seguro')
    expect(liar.rejected?.ok).toBe(false)

    const down = await guardedExplain({ generate: async () => { throw new Error('boom') } }, 'PETR4', facts, 'texto seguro')
    expect(down.source).toBe('template')

    const none = await guardedExplain(null, 'PETR4', facts, 'texto seguro')
    expect(none.source).toBe('template')
  })
})

describe('guarda do LLM: números pequenos e intervalos (correções da revisão)', () => {
  const facts: FactLine[] = [{ label: 'Score', display: '85/100', numbers: [85] }]

  test('inteiro pequeno com unidade não é numeração: "8% ao ano" e "10x" reprovam', () => {
    expect(validateExplanation('Retorno esperado de 8% ao ano.', facts).ok).toBe(false)
    expect(validateExplanation('Alavancagem de 10x.', facts).ok).toBe(false)
    expect(validateExplanation('Custo de R$ 7 por ordem.', facts).ok).toBe(false)
  })

  test('inteiro pequeno sem unidade segue ignorado (listas)', () => {
    expect(validateExplanation('1. Ponto um. 2. Ponto dois. 3. Ponto três.', facts).ok).toBe(true)
  })

  test('hífen entre dígitos é intervalo, não sinal negativo', () => {
    expect(extractNumbers('horizonte de 5-10 anos')).toEqual([5, 10])
    expect(extractNumbers('queda de -4% e -7,5%')).toEqual([-4, -7.5])
    expect(validateExplanation('No horizonte de 5-10 anos o score é 85.', facts).ok).toBe(true)
  })
})
