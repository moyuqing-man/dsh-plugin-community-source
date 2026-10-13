/**
 * HTTP 客户端：超时预算、退避重试、配额门控。
 *
 * 三条实测事实决定了这里的形状（见 docs/08）：
 *   1. 未认证 REST 是 60 次/小时，**按来源 IP** —— 硬墙，没有绕过办法。
 *   2. `/rate_limit` 这个端点**不消耗配额**（实测 delta = 0），是免费的探针。
 *   3. ETag 条件请求**照样吃配额**（实测 304 也扣 1），所以别指望靠它省额度。
 *
 * 因此：配额门控以 x-ratelimit-remaining / x-ratelimit-reset 为准，
 * 撞墙时返回 429 + retryAfterMs，绝不死循环重试。
 */

import { rateLimited, upstreamFailed, upstreamTimeout } from './errors.js'

const RESOURCE_HEADER = 'x-ratelimit-resource'

export function createRateGuard({ now = Date.now, headroom = 1 } = {}) {
  const buckets = new Map()

  return {
    /** 从响应头更新各配额桶状态。GitHub 会用 x-ratelimit-resource 标明这是哪个桶。 */
    note(headers) {
      if (!headers || typeof headers.get !== 'function') return
      const resource = headers.get(RESOURCE_HEADER) || 'core'
      const remaining = Number(headers.get('x-ratelimit-remaining'))
      const reset = Number(headers.get('x-ratelimit-reset'))
      if (!Number.isFinite(remaining)) return
      buckets.set(resource, {
        remaining,
        limit: Number(headers.get('x-ratelimit-limit')) || null,
        resetAt: Number.isFinite(reset) ? reset * 1000 : 0,
        checkedAt: now(),
      })
    },

    /** 还剩多少毫秒不能打这个桶。0 = 可以打。 */
    blockedMs(resource = 'core') {
      const bucket = buckets.get(resource)
      if (!bucket) return 0
      if (bucket.remaining > headroom) return 0
      return Math.max(0, bucket.resetAt - now())
    },

    snapshot() {
      return Object.fromEntries(
        [...buckets.entries()].map(([k, v]) => [
          k,
          { ...v, blockedMs: Math.max(0, v.resetAt - now()) },
        ]),
      )
    },
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export function createHttpClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  userAgent = 'dsh-plugin-community',
  logger,
  rateGuard = createRateGuard({ now }),
  defaultTimeoutMs = 10_000,
  defaultRetries = 2,
} = {}) {
  async function request(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      timeoutMs = defaultTimeoutMs,
      retries = defaultRetries,
      accept,
      /** 写操作绝不重试：可能已经把内容写进去了，重试会造成重复帖（cp. docs/07 风险 12） */
      idempotent = method === 'GET',
      resource = 'core',
      label = url,
      body,
    } = options

    const blocked = rateGuard.blockedMs(resource)
    if (blocked > 0 && idempotent) {
      throw rateLimited(`GitHub ${resource} 配额已用尽，需等待 ${Math.ceil(blocked / 1000)} 秒`, blocked)
    }

    let lastError = null
    const maxAttempts = idempotent ? Math.max(1, retries + 1) : 1

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1)) * (0.5 + random() * 0.5)
        await sleep(Math.round(backoff))
      }

      let response
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            'user-agent': userAgent,
            ...(accept ? { accept } : {}),
            ...headers,
          },
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        lastError = aborted
          ? upstreamTimeout(`请求 ${label} 超时（${timeoutMs}ms）`, { url, timeoutMs })
          : upstreamFailed(`请求 ${label} 失败：${error?.message ?? error}`, { url, cause: String(error?.cause ?? '') })
        if (!idempotent) throw lastError
        logger?.debug?.(`[community] ${label} 第 ${attempt + 1} 次失败：${lastError.message}`)
        continue
      }

      rateGuard.note(response.headers)

      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        const text = await response.text()
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          text,
          url: response.url || url,
          durationMs: 0,
        }
      }

      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0
      await response.text().catch(() => '')

      if (response.status === 429 || response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining')
        if (remaining === '0' || response.status === 429) {
          const reset = Number(response.headers.get('x-ratelimit-reset'))
          const waitMs = retryAfterMs || (Number.isFinite(reset) ? Math.max(0, reset * 1000 - now()) : 0)
          lastError = rateLimited(`GitHub 拒绝了 ${label}（配额用尽）`, waitMs)
          if (!idempotent || attempt === maxAttempts - 1) throw lastError
          await sleep(Math.min(waitMs || 1_000, 60_000))
          continue
        }
      }

      lastError = upstreamFailed(`上游返回 ${response.status}（${label}）`, { status: response.status, url })
    }

    throw lastError ?? upstreamFailed(`请求 ${label} 失败`)
  }

  return {
    request,
    async json(url, options = {}) {
      const response = await request(url, { accept: 'application/vnd.github+json', ...options })
      let parsed = null
      try {
        parsed = response.text ? JSON.parse(response.text) : null
      } catch {
        throw upstreamFailed(`上游返回的不是合法 JSON（${options.label ?? url}）`, { status: response.status, url })
      }
      return { ...response, json: parsed }
    },
    async text(url, options = {}) {
      return request(url, options)
    },
    rateGuard,
  }
}

/**
 * 免费配额探针：`/rate_limit` 实测不消耗配额，可以随时打。
 * 用来在启动后把各桶的真实额度填进 rateGuard。
 */
export async function probeRateLimit(http, { timeoutMs = 5_000 } = {}) {
  try {
    const response = await http.request('https://api.github.com/rate_limit', {
      timeoutMs,
      retries: 0,
      label: 'rate_limit',
    })
    const data = JSON.parse(response.text)
    return data?.resources ?? null
  } catch {
    return null
  }
}
