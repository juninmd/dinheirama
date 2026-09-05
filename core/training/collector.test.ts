import { describe, expect, test } from 'bun:test'
import { labelsForSample, needsLabels } from './collector.ts'

/** Serie de pregoes: seg-sex, sem sabado/domingo. */
function tradingDays(closes: number[], start = '2026-06-01') {
  const out: { date: string; close: number }[] = []
  const d = new Date(start + 'T00:00:00Z')
  for (const close of closes) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1)
    out.push({ date: d.toISOString().split('T')[0]!, close })
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

describe('labelsForSample', () => {
  test('conta o horizonte em pregoes, atravessando o fim de semana', () => {
    // 2026-06-01 e uma segunda. Com offset de calendario, +5 dias cai no sabado
    // 06/06, que nao tem pregao -- era assim que o label ficava nulo.
    const days = tradingDays([100, 101, 102, 103, 104, 110])
    expect(days[0]!.date).toBe('2026-06-01')
    expect(days[5]!.date).toBe('2026-06-08') // 5 pregoes depois, ja na semana seguinte

    const labels = labelsForSample('2026-06-01', days)
    expect(labels.return_5d).toBeCloseTo(10, 6)
    expect(labels.action_5d).toBe('buy')
  })

  test('classifica sell abaixo de -3% e hold na faixa neutra', () => {
    const queda = labelsForSample('2026-06-01', tradingDays([100, 1, 1, 1, 1, 90]))
    expect(queda.return_5d).toBeCloseTo(-10, 6)
    expect(queda.action_5d).toBe('sell')

    const neutro = labelsForSample('2026-06-01', tradingDays([100, 1, 1, 1, 1, 101]))
    expect(neutro.action_5d).toBe('hold')
  })

  test('nao rotula horizonte que ainda nao aconteceu', () => {
    // So 3 pregoes na serie: 1d existe, 5d e 20d ainda nao.
    const labels = labelsForSample('2026-06-01', tradingDays([100, 105, 106]))
    expect(labels.return_1d).toBeCloseTo(5, 6)
    expect(labels.return_5d).toBeUndefined()
    expect(labels.return_20d).toBeUndefined()
  })

  test('devolve vazio quando a data da amostra nao tem pregao', () => {
    expect(labelsForSample('2026-06-06', tradingDays([100, 101]))).toEqual({})
  })

  test('devolve vazio com preco base invalido', () => {
    expect(labelsForSample('2026-06-01', [{ date: '2026-06-01', close: 0 }])).toEqual({})
  })
})

describe('needsLabels', () => {
  const base = { ticker: 'PETR4.SA', timestamp: '2026-06-01T00:00:00Z', features: {}, metadata: {} }

  test('true enquanto algum horizonte estiver nulo', () => {
    const s: any = { ...base, labels: { return_1d: 1, return_5d: null, return_20d: null } }
    expect(needsLabels(s)).toBe(true)
  })

  test('false quando todos os horizontes ja tem valor', () => {
    const s: any = { ...base, labels: { return_1d: 1, return_5d: 2, return_20d: 3 } }
    expect(needsLabels(s)).toBe(false)
  })
})
