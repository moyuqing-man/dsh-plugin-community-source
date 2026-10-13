import test from 'node:test'
import assert from 'node:assert/strict'

import { createCache } from '../lib/core/cache.js'

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('fresh 命中，不调用 producer', async () => {
  const c = clock()
  const cache = createCache({ now: c.now })
  let calls = 0
  const producer = async () => { calls += 1; return 'v1' }

  const first = await cache.wrap('k', producer, { ttlMs: 1000, staleTtlMs: 5000 })
  assert.equal(first.state, 'refreshed')
  assert.equal(first.value, 'v1')

  c.advance(500)
  const second = await cache.wrap('k', producer, { ttlMs: 1000, staleTtlMs: 5000 })
  assert.equal(second.state, 'fresh')
  assert.equal(second.value, 'v1')
  assert.equal(calls, 1)
})

test('过了 TTL 会重新生产', async () => {
  const c = clock()
  const cache = createCache({ now: c.now })
  let calls = 0
  const producer = async () => { calls += 1; return `v${calls}` }

  await cache.wrap('k', producer, { ttlMs: 1000, staleTtlMs: 5000 })
  c.advance(1001)
  const again = await cache.wrap('k', producer, { ttlMs: 1000, staleTtlMs: 5000 })
  assert.equal(again.state, 'refreshed')
  assert.equal(again.value, 'v2')
  assert.equal(calls, 2)
})

test('producer 失败但有陈旧数据 → stale-fallback（「外部失败不白屏」的核心）', async () => {
  const c = clock()
  const cache = createCache({ now: c.now })
  await cache.wrap('k', async () => 'good', { ttlMs: 1000, staleTtlMs: 5000 })

  c.advance(2000)
  const boom = new Error('上游炸了')
  const out = await cache.wrap('k', async () => { throw boom }, { ttlMs: 1000, staleTtlMs: 5000 })
  assert.equal(out.state, 'stale-fallback')
  assert.equal(out.value, 'good')
  assert.equal(out.error, boom)
  assert.equal(out.ageMs, 2000)
})

test('producer 失败且无任何数据 → 把错误抛出去', async () => {
  const cache = createCache({ now: clock().now })
  await assert.rejects(
    () => cache.wrap('k', async () => { throw new Error('第一次就失败') }, { ttlMs: 1000 }),
    /第一次就失败/,
  )
})

test('超出 ttl + staleTtl 之后条目被删除', async () => {
  const c = clock()
  const cache = createCache({ now: c.now })
  await cache.wrap('k', async () => 'v', { ttlMs: 1000, staleTtlMs: 1000 })
  assert.equal(cache.peek('k').state, 'fresh')

  c.advance(2001)
  assert.equal(cache.peek('k').state, 'miss')
  assert.equal(cache.size, 0)
})

test('force 跳过 fresh 直接刷新', async () => {
  const c = clock()
  const cache = createCache({ now: c.now })
  let calls = 0
  const producer = async () => { calls += 1; return calls }
  await cache.wrap('k', producer, { ttlMs: 10_000 })
  const out = await cache.wrap('k', producer, { ttlMs: 10_000, force: true })
  assert.equal(out.state, 'refreshed')
  assert.equal(calls, 2)
})

test('并发去重：同一个 key 同时来的请求只打一次上游', async () => {
  const cache = createCache({ now: clock().now })
  let calls = 0
  const producer = async () => {
    calls += 1
    await new Promise((r) => setTimeout(r, 5))
    return 'shared-value'
  }
  const [a, b, c] = await Promise.all([
    cache.wrap('k', producer, { ttlMs: 1000 }),
    cache.wrap('k', producer, { ttlMs: 1000 }),
    cache.wrap('k', producer, { ttlMs: 1000 }),
  ])
  assert.equal(calls, 1)
  assert.equal(a.value, 'shared-value')
  assert.equal(b.value, 'shared-value')
  assert.equal(c.value, 'shared-value')
  assert.ok([a.state, b.state, c.state].includes('shared'))
})

test('set / delete / keys / clear', () => {
  const cache = createCache({ now: clock().now })
  cache.set('a', 1, { ttlMs: 100 })
  cache.set('b', 2, { ttlMs: 100 })
  assert.equal(cache.size, 2)
  assert.deepEqual(cache.keys().sort(), ['a', 'b'])
  assert.equal(cache.delete('a'), true)
  assert.equal(cache.delete('a'), false)
  cache.clear()
  assert.equal(cache.size, 0)
})
