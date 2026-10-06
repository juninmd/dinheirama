import { describe, expect, test } from 'bun:test'
import { CacheManager, mapPool } from './cache.ts'

describe('CacheManager', () => {
  test('getOrLoad deduplica cargas simultâneas e guarda o resultado', async () => {
    const cache = new CacheManager(1)
    let calls = 0
    const loader = async () => {
      calls++
      await Bun.sleep(10)
      return { n: 1 }
    }
    const [a, b] = await Promise.all([cache.getOrLoad('k', loader), cache.getOrLoad('k', loader)])
    expect(calls).toBe(1)
    expect(a.value).toBe(b.value)
    expect(a.cached).toBe(false)
    const c = await cache.getOrLoad('k', loader)
    expect(c.cached).toBe(true)
    expect(calls).toBe(1)
  })

  test('null e erro não são cacheados', async () => {
    const cache = new CacheManager(1)
    let calls = 0
    await cache.getOrLoad<null>('n', async () => { calls++; return null })
    await cache.getOrLoad<null>('n', async () => { calls++; return null })
    expect(calls).toBe(2)
    await expect(cache.getOrLoad('e', async () => { throw new Error('x') })).rejects.toThrow('x')
    const ok = await cache.getOrLoad('e', async () => 5)
    expect(ok).toEqual({ value: 5, cached: false })
  })

  test('respeita o limite de entradas descartando as mais antigas', () => {
    const cache = new CacheManager(1, 3)
    for (const k of ['a', 'b', 'c', 'd']) cache.set(k, k)
    expect(cache.size).toBe(3)
    expect(cache.get('a')).toBeNull()
    expect(cache.get('d')).toBe('d')
  })
})

describe('mapPool', () => {
  test('preserva a ordem e respeita o limite de concorrência', async () => {
    let running = 0
    let peak = 0
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async n => {
      running++
      peak = Math.max(peak, running)
      await Bun.sleep(5)
      running--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
    expect(await mapPool([], 3, async n => n)).toEqual([])
  })
})
