import { z } from 'zod'

const TICKER = /^[A-Z0-9]{4,6}\.[A-Z]{2}$/

const base = z.object({ ticker: z.string().trim().toUpperCase().regex(TICKER, 'Invalid B3 ticker format (ex: PETR4.SA)') })

const numeric = z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().finite())

const schema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('price'), condition: z.enum(['above', 'below']), value: numeric.pipe(z.number().positive()) }),
  base.extend({ type: z.literal('rsi'), condition: z.enum(['above', 'below']), value: numeric.pipe(z.number().min(0).max(100)) }),
  base.extend({
    type: z.literal('ml_signal'),
    condition: z.literal('action_equals'),
    value: z.string().trim().toLowerCase().pipe(z.enum(['buy', 'hold', 'sell'])),
  }),
])

export type AlertInput = z.infer<typeof schema>

/** Valida o corpo de POST /api/alerts: um alerta malformado nunca dispara e fica na lista para sempre. */
export function parseAlertInput(body: unknown): { ok: true; value: AlertInput } | { ok: false; error: string } {
  const parsed = schema.safeParse(body)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  return { ok: false, error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` }
}
