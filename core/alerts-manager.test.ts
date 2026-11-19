import { afterAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// alerts-manager reads ALERTS_DIR at import time and keeps module state, so each scenario runs in its own process.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'))
const mod = path.join(import.meta.dir, 'alerts-manager.ts')
const file = path.join(dir, 'alerts.json')

function run(script: string): string {
  const r = Bun.spawnSync(['bun', '-e', `const m = await import(${JSON.stringify(mod)}); ${script}`], {
    env: { ...process.env, ALERTS_DIR: dir },
    stderr: 'pipe'
  })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString().trim().split('\n').pop() ?? ''
}

describe('alerts-manager persistence', () => {
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('saves alerts atomically and leaves no temp file', () => {
    const id = run(`console.log(m.addAlert({ ticker: 'PETR4.SA', type: 'price', condition: 'above', value: 50 }).id)`)
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(saved.map((x: { id: string }) => x.id)).toContain(id)
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  test('a corrupt alerts file is kept aside instead of being overwritten', () => {
    fs.writeFileSync(file, '{"truncated":')
    expect(run(`console.log(m.loadAlerts().length)`)).toBe('0')
    const kept = fs.readdirSync(dir).filter(f => f.startsWith('alerts.json.corrupt-'))
    expect(kept.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, kept[0]!), 'utf-8')).toBe('{"truncated":')
  })

  test('a non-array JSON is rejected and quarantined', () => {
    fs.writeFileSync(file, '{"a":1}')
    expect(run(`console.log(m.loadAlerts().length)`)).toBe('0')
    expect(fs.existsSync(file)).toBe(false)
  })
})
