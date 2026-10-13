/**
 * 索引源注册表。
 *
 * 设计要点：
 * - 每个源单独缓存（`wrap` 自带 stale 降级），**一个源挂了不影响别的源**
 *   —— 这是「外部失败不白屏」的第一道防线。
 * - `loadAll` 永远不 reject：失败源只是从 sources[] 里带一个 error 出来。
 */

import * as awesome from './awesome.js'
import * as radar from './radar.js'
import * as githubTopic from './githubTopic.js'
import * as dshSo from './dshSo.js'
import * as dshWorks from './dshWorks.js'
import * as lanshu from './lanshu.js'
import { mergeCards } from '../normalize.js'

export const SOURCES = Object.freeze({
  awesome,
  radar,
  'github-topic': githubTopic,
  'dsh-so': dshSo,
  'dsh-works': dshWorks,
  lanshu,
})

/**
 * 默认源的选择理由（只有两个，其余是「可选源」）：
 * - `github-topic` 约 0.9 秒返回 → 首屏用它
 * - `awesome` 有 4602 条、带 npm 包名/下载量/能力清单，但 5 MB、20+ 秒 → 后台预热
 *
 * 其余四个都是**可选源**，理由分别是：
 * - `radar` 只有 301 条，且 raw.githubusercontent 在本机经常超时
 * - `dsh-so` 提供验证等级与安全扫描（信息最全），但 19.7 MB / 18.9 秒，太重
 * - `dsh-works` 提供「安装路径在哪个文件里被验证过」，但本机端点超时
 * - `lanshu` 信息密度最高（归档/维护/审核结论），但本机端点超时
 *
 * 换句话说：**默认集只放「本机确实能跑通且够快」的源**。可选源装好之后
 * 想开就在配置里写 `sources`，不需要改代码。
 */
export const DEFAULT_SOURCES = Object.freeze(['github-topic', 'awesome'])

/** 陈旧数据保留倍数：staleTtlMs = ttlMs × 这个数 */
const STALE_MULTIPLIER = 24

export function sourceIds() {
  return Object.keys(SOURCES)
}

export function describe(id) {
  const source = SOURCES[id]
  if (!source) return null
  return {
    id,
    label: source.label ?? id,
    url: source.url ?? null,
    ttlMs: source.ttlMs ?? null,
    timeoutMs: source.timeoutMs ?? null,
    /** 可选源：装好能用，但默认不加载（体积太大或在本机网络下不通）。 */
    optIn: source.optIn === true,
    default: DEFAULT_SOURCES.includes(id),
  }
}

export function createSourceLoader({ http, cache, logger }) {
  async function loadSource(id, { force = false } = {}) {
    const source = SOURCES[id]
    if (!source) {
      return {
        id, label: id, state: 'unknown', ageMs: 0, stale: false,
        cards: [], categories: {}, meta: {},
        error: { reason: 'UNKNOWN_SOURCE', message: `未知索引源：${id}` },
      }
    }

    const ttlMs = Number.isFinite(source.ttlMs) ? source.ttlMs : 30 * 60_000

    let outcome
    try {
      outcome = await cache.wrap(
        `source:${id}`,
        () => source.load({ http, logger }),
        { ttlMs, staleTtlMs: ttlMs * STALE_MULTIPLIER, force },
      )
    } catch (error) {
      // 这里必须兜住：loadAll 的 Promise.all 一旦被拒绝，「一个源挂了不影响其它源」
      // 和「外部失败不白屏」两条承诺就同时失效了。
      return {
        id,
        label: source.label ?? id,
        state: 'failed',
        ageMs: 0,
        stale: false,
        cards: [],
        categories: {},
        meta: {},
        error: { reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error) },
      }
    }

    const value = outcome.value ?? {}
    return {
      id,
      label: source.label ?? id,
      state: outcome.state,
      ageMs: outcome.ageMs ?? 0,
      stale: outcome.state === 'stale-fallback',
      cards: Array.isArray(value.cards) ? value.cards : [],
      categories: value.categories ?? {},
      meta: value.meta ?? {},
      error: outcome.error
        ? { reason: 'UPSTREAM_FAILED', message: String(outcome.error.message ?? outcome.error) }
        : null,
    }
  }

  async function loadAll(ids = DEFAULT_SOURCES, options = {}) {
    const requested = Array.isArray(ids) && ids.length ? ids : DEFAULT_SOURCES
    const unique = [...new Set(requested)].filter((id) => typeof id === 'string' && id.length > 0)
    const results = await Promise.all(unique.map((id) => loadSource(id, options)))

    return {
      cards: mergeCards(results.flatMap((r) => r.cards)),
      // 不带 cards 出去 —— 那 4600 张卡片不该出现在任何响应里
      sources: results.map(({ cards: _cards, categories: _categories, ...rest }) => rest),
      errors: results.filter((r) => r.error).map((r) => ({ id: r.id, ...r.error })),
      stale: results.some((r) => r.stale),
      loadedAt: new Date().toISOString(),
    }
  }

  return { loadSource, loadAll }
}
