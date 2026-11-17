import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { adminWriteGuard } from './admin-guard.ts'

function appWith(token: string | undefined) {
  const app = new Hono()
  app.use('/api/*', adminWriteGuard({ token: () => token, publicWrites: ['/api/analyze'], alwaysProtected: ['/api/training'] }))
  app.all('/api/*', c => c.json({ ok: true }))
  return app
}
const req = (app: Hono, method: string, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method, headers })

describe('adminWriteGuard', () => {
  test('com ADMIN_TOKEN: escrita sem token → 401, com token → 200', async () => {
    const app = appWith('s3cret')
    expect((await req(app, 'POST', '/api/alerts')).status).toBe(401)
    expect((await req(app, 'DELETE', '/api/ips', { 'x-admin-token': 'errado' })).status).toBe(401)
    expect((await req(app, 'POST', '/api/alerts', { 'x-admin-token': 's3cret' })).status).toBe(200)
    expect((await req(app, 'POST', '/api/training/retrain', { authorization: 'Bearer s3cret' })).status).toBe(200)
  })

  test('leituras e /api/analyze seguem públicas', async () => {
    const app = appWith('s3cret')
    expect((await req(app, 'GET', '/api/alerts')).status).toBe(200)
    expect((await req(app, 'POST', '/api/analyze')).status).toBe(200)
  })

  test('sem ADMIN_TOKEN: treino (roda comandos) fica fechado; o resto segue aberto', async () => {
    const app = appWith(undefined)
    expect((await req(app, 'POST', '/api/training/collect')).status).toBe(403)
    expect((await req(app, 'POST', '/api/training/retrain')).status).toBe(403)
    expect((await req(app, 'POST', '/api/alerts')).status).toBe(200)
  })
})
