import { timingSafeEqual } from 'crypto'
import type { Context, Next } from 'hono'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function givenToken(c: Context): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]
  return bearer ?? c.req.header('x-admin-token') ?? ''
}

export interface AdminGuardOptions {
  /** Lido a cada requisição, para testes e troca de segredo sem reinício. */
  token?: () => string | undefined
  /** Escritas que continuam públicas (ex.: /api/analyze, que só lê e tem cache). */
  publicWrites?: string[]
}

/**
 * Escritas da API exigem ADMIN_TOKEN (Bearer ou x-admin-token). Sem o segredo
 * configurado, ficam fechadas (403): a API é pública e não tem login.
 */
export function adminWriteGuard(options: AdminGuardOptions = {}) {
  const token = options.token ?? (() => process.env.ADMIN_TOKEN)
  const publicWrites = new Set(options.publicWrites ?? [])
  return async (c: Context, next: Next) => {
    if (READ_METHODS.has(c.req.method) || publicWrites.has(c.req.path)) return next()
    const secret = token()?.trim()
    if (!secret) return c.json({ error: 'Configure ADMIN_TOKEN no servidor para liberar escritas', code: 'ADMIN_TOKEN_REQUIRED' }, 403)
    if (!sameSecret(givenToken(c), secret)) return c.json({ error: 'Token de admin inválido', code: 'UNAUTHORIZED' }, 401)
    return next()
  }
}
