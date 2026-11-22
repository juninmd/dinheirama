import { describe, expect, it } from 'bun:test'
import { escapeHtml, escapeHtmlClipped } from './telegram-html.ts'

describe('escapeHtmlClipped', () => {
  it('never leaves a broken entity at the cut', () => {
    const raw = `${'a'.repeat(3497)}&`
    expect(escapeHtml(raw).slice(0, 3500).endsWith('&am')).toBe(true) // the old bug
    const out = escapeHtmlClipped(raw, 3500)
    expect(out).toBe('a'.repeat(3497))
    expect(out.length).toBeLessThanOrEqual(3500)
  })

  it('keeps whole entities that fit and respects the budget', () => {
    expect(escapeHtmlClipped('<b>&</b>', 9)).toBe('&lt;b&gt;')
    expect(escapeHtmlClipped('<b>&</b>', 100)).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    for (let max = 0; max < 30; max++) {
      const out = escapeHtmlClipped('R&D <ok> & mais', max)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(out).not.toMatch(/&[a-z]*$/)
    }
  })

  it('does not split an emoji', () => {
    expect(escapeHtmlClipped('ab📈', 3)).toBe('ab')
  })
})
