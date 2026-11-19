import { describe, expect, test } from 'bun:test'
import { parseAlertInput } from './alert-input.ts'

describe('parseAlertInput', () => {
  test('aceita alerta de preço e normaliza ticker e valor numérico em string', () => {
    const r = parseAlertInput({ ticker: ' petr4.sa ', type: 'price', condition: 'above', value: '35.5' })
    expect(r).toEqual({ ok: true, value: { ticker: 'PETR4.SA', type: 'price', condition: 'above', value: 35.5 } })
  })

  test('aceita sinal de ML com ação em qualquer caixa', () => {
    const r = parseAlertInput({ ticker: 'VALE3.SA', type: 'ml_signal', condition: 'action_equals', value: 'BUY' })
    expect(r).toMatchObject({ ok: true, value: { value: 'buy' } })
  })

  test.each([
    ['tipo desconhecido', { ticker: 'PETR4.SA', type: 'foo', condition: 'above', value: 1 }],
    ['ticker fora do formato B3', { ticker: '<script>', type: 'price', condition: 'above', value: 1 }],
    ['condição inválida para preço', { ticker: 'PETR4.SA', type: 'price', condition: 'action_equals', value: 1 }],
    ['valor não numérico', { ticker: 'PETR4.SA', type: 'price', condition: 'below', value: 'abc' }],
    ['valor NaN/Infinity', { ticker: 'PETR4.SA', type: 'price', condition: 'below', value: Infinity }],
    ['preço <= 0', { ticker: 'PETR4.SA', type: 'price', condition: 'below', value: 0 }],
    ['RSI fora de 0..100', { ticker: 'PETR4.SA', type: 'rsi', condition: 'above', value: 150 }],
    ['ação de ML inexistente', { ticker: 'PETR4.SA', type: 'ml_signal', condition: 'action_equals', value: 'moon' }],
    ['corpo não é objeto', null],
  ])('rejeita %s', (_name, body) => {
    expect(parseAlertInput(body).ok).toBe(false)
  })
})
