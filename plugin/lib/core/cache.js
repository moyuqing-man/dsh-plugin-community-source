/**
 * 分层缓存。
 *
 * 两层语义：
 *   fresh  —— 在 TTL 内，直接用
 *   stale  —— 过了 TTL 但还在 staleTtl 窗口内；正常情况下会去刷新，
 *             但**刷新失败时返回这一份**并标记 stale，这是「外部失败不白屏」的实现基础
 *
 * 另外做并发去重：同一个 key 上同时来的多个请求只打一次上游。
 *
 * 刻意不做持久化：M1 只需要进程内缓存。跨重启的持久化要接 `ctx.storageDomain`，
 * 那属于后面的里程碑（见 docs/03 第 6 节）。
 */

export function createCache({ now = Date.now } = {}) {
  const entries = new Map()
  const inflight = new Map()

  const isExpired = (entry, at) => at > entry.storedAt + entry.ttlMs + entry.staleTtlMs

  const api = {
    get size() {
      return entries.size
    },

    set(key, value, { ttlMs = 0, staleTtlMs = 0 } = {}) {
      entries.set(key, { value, storedAt: now(), ttlMs, staleTtlMs })
    },

    /**
     * @returns {{state: 'miss'|'fresh'|'stale', value?: unknown, ageMs?: number}}
     */
    peek(key) {
      const entry = entries.get(key)
      if (!entry) return { state: 'miss' }
      const at = now()
      if (isExpired(entry, at)) {
        entries.delete(key)
        return { state: 'miss' }
      }
      const ageMs = at - entry.storedAt
      const state = ageMs <= entry.ttlMs ? 'fresh' : 'stale'
      return { state, value: entry.value, ageMs }
    },

    delete(key) {
      return entries.delete(key)
    },

    clear() {
      entries.clear()
      inflight.clear()
    },

    keys() {
      return [...entries.keys()]
    },

    /**
     * 缓存包裹。producer 抛错时的行为是这一层的全部价值：
     * 有陈旧数据就返回陈旧数据（state = 'stale-fallback'），没有才把错误抛出去。
     */
    async wrap(key, producer, { ttlMs = 0, staleTtlMs = 0, force = false } = {}) {
      if (!force) {
        const hit = api.peek(key)
        if (hit.state === 'fresh') {
          return { value: hit.value, state: 'fresh', ageMs: hit.ageMs, error: null }
        }
      }

      if (inflight.has(key)) {
        const shared = await inflight.get(key)
        return { ...shared, state: 'shared' }
      }

      const run = (async () => {
        try {
          const value = await producer()
          api.set(key, value, { ttlMs, staleTtlMs })
          return { value, state: 'refreshed', ageMs: 0, error: null }
        } catch (error) {
          const hit = api.peek(key)
          if (hit.state === 'stale') {
            return { value: hit.value, state: 'stale-fallback', ageMs: hit.ageMs, error }
          }
          throw error
        }
      })()

      inflight.set(key, run)
      try {
        return await run
      } finally {
        if (inflight.get(key) === run) inflight.delete(key)
      }
    },
  }

  return api
}
