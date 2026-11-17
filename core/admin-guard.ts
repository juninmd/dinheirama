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
  /** Rotas que nunca rodam sem ADMIN_TOKEN configurado (executam comandos no servidor). */
  alwaysProtected?: string[]
}

/**
 * Escritas da API exigem ADMIN_TOKEN (Bearer ou x-admin-token) quando ele está configurado.
 * Sem o segredo, as escritas comuns seguem abertas para não quebrar a instalação atual,
 * mas as rotas de `alwaysProtected` ficam fechadas.
 */
export function adminWriteGuard(options: AdminGuardOptions = {}) {
  const token = options.token ?? (() => process.env.ADMIN_TOKEN)
  const publicWrites = new Set(options.publicWrites ?? [])
  const alwaysProtected = options.alwaysProtected ?? []
  return async (c: Context, next: Next) => {
    if (READ_METHODS.has(c.req.method) || publicWrites.has(c.req.path)) return next()
    const secret = token()?.trim()
    if (!secret) {
      if (alwaysProtected.some(p => c.req.path === p || c.req.path.startsWith(`${p}/`))) {
        return c.json({ error: 'Configure ADMIN_TOKEN para usar esta rota', code: 'ADMIN_TOKEN_REQUIRED' }, 403)
      }
      return next()
    }
    if (!sameSecret(givenToken(c), secret)) return c.json({ error: 'Token de admin inválido', code: 'UNAUTHORIZED' }, 401)
    return next()
  }
}
