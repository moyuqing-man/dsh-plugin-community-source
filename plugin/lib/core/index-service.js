/**
 * 索引服务：把「多个索引源的原始数据」变成「页面和 API 要的形状」。
 *
 * 分工：
 * - 列表页只吃索引源（快，秒级）
 * - 插件详情页才补 GitHub 元数据（慢，且吃 60/h 的核心配额）
 *
 * 这样做的原因很直接：未认证 60 请求/小时。如果列表页每条都去补元数据，
 * 30 条就能把一小时配额打光。
 */

import { SORTS } from './normalize.js'
import { DEFAULT_SOURCES, createSourceLoader, sourceIds } from './sources/index.js'

export const PAGE_SIZE_DEFAULT = 30
export const PAGE_SIZE_MAX = 100
export const PREWARM_DELAY_MS = 8_000

function haystack(card) {
  return [
    card.slug,
    card.name,
    card.owner,
    card.npm ?? '',
    card.description?.en ?? '',
    card.description?.zh ?? '',
    card.category,
    card.categoryLabel?.en ?? '',
    card.categoryLabel?.zh ?? '',
    ...(card.topics ?? []),
    ...(card.capabilities ?? []),
  ]
    .join(' ')
    .toLowerCase()
}

function matches(card, query) {
  const text = haystack(card)
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => text.includes(token))
}

/** 用实时 GitHub 元数据覆盖索引里可能过期的字段（索引更新时间不固定）。 */
export function applyMeta(card, meta) {
  if (!meta || meta.found === false) return card
  return {
    ...card,
    stars: Number.isFinite(meta.stars) ? meta.stars : card.stars,
    openIssues: Number.isFinite(meta.openIssues) ? meta.openIssues : card.openIssues,
    pushedAt: meta.pushedAt ?? card.pushedAt,
    archived: meta.archived === true,
    license: meta.license ?? card.license,
    topics: card.topics?.length ? card.topics : (meta.topics ?? []),
    /** 标记这几项是刚拉的实时值，界面可以据此显示「刚刚更新」 */
    metaFresh: true,
  }
}

export function createIndexService({ http, cache, github, logger, config = {} }) {
  const loader = createSourceLoader({ http, cache, logger })
  const configured = Array.isArray(config.sources) && config.sources.length ? config.sources : DEFAULT_SOURCES
  const known = new Set(sourceIds())
  const activeSources = configured.filter((id) => known.has(id))
  const sources = activeSources.length ? activeSources : [...DEFAULT_SOURCES]

  const knownSummary = new Map()

  function remember(result) {
    for (const card of result.cards) knownSummary.set(card.slug, card)
  }

  function facets(cards) {
    const byCategory = new Map()
    let archived = 0
    let withNpm = 0
    for (const card of cards) {
      const key = card.category || 'uncategorized'
      byCategory.set(key, (byCategory.get(key) ?? 0) + 1)
      if (card.archived) archived += 1
      if (card.npm) withNpm += 1
    }
    return {
      categories: [...byCategory.entries()]
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => b.count - a.count),
      archived,
      withNpm,
    }
  }

  async function list(options = {}) {
    const {
      q = '',
      category = '',
      sort = 'stars',
      page = 1,
      perPage = PAGE_SIZE_DEFAULT,
      force = false,
      sources: requested,
    } = options

    const snapshot = await loader.loadAll(requested ?? sources, { force })
    remember(snapshot)

    const searched = q ? snapshot.cards.filter((card) => matches(card, q)) : snapshot.cards
    const facetData = facets(searched)
    const filtered = category ? searched.filter((card) => card.category === category) : searched

    const comparator = SORTS[sort] ?? SORTS.stars
    const sorted = [...filtered].sort(comparator)

    const size = Math.min(Math.max(Number(perPage) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX)
    const total = sorted.length
    const pages = Math.max(1, Math.ceil(total / size))
    const current = Math.min(Math.max(Number(page) || 1, 1), pages)

    return {
      items: sorted.slice((current - 1) * size, current * size),
      total,
      filteredTotal: filtered.length,
      page: current,
      pages,
      perPage: size,
      sort,
      query: q,
      category,
      facets: facetData,
      sources: snapshot.sources,
      errors: snapshot.errors,
      stale: snapshot.stale,
      loadedAt: snapshot.loadedAt,
      knownTotal: snapshot.cards.length,
    }
  }

  /** 详情页才补实时元数据；列表页永远不走这里。 */
  async function get(slug, { force = false, withGithub = true } = {}) {
    const key = String(slug ?? '').toLowerCase()
    let card = knownSummary.get(key)
    if (!card) {
      const snapshot = await loader.loadAll(sources, { force })
      remember(snapshot)
      card = knownSummary.get(key)
    }
    if (!card) return null

    if (!withGithub) return { card }

    const meta = await github.repoMeta(card.repo, { force })
    return { card: applyMeta(card, meta), meta }
  }

  async function details(slug, { force = false } = {}) {
    const found = await get(slug, { force })
    if (!found) return null
    const repo = found.card.repo
    const [issues, discussions] = await Promise.all([
      github.issues(repo, { force }).catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [], totalCount: 0 })),
      github.discussions(repo, { force }).catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [], totalCount: 0, categories: [] })),
    ])
    return { card: found.card, meta: found.meta, issues, discussions }
  }

  /**
   * 后台预热：不 await、不抛错。
   * 只有它去碰那些「大而慢」的源，用户首屏不会等。
   */
  function prewarm() {
    const timer = setTimeout(async () => {
      try {
        const result = await loader.loadAll(sources, {})
        remember(result)
        logger?.debug?.(`[community] 后台预热完成：${result.cards.length} 条，${result.errors.length} 个源失败`)
      } catch (error) {
        logger?.debug?.(`[community] 后台预热失败（忽略）：${error?.message ?? error}`)
      }
    }, PREWARM_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }

  function stats() {
    return {
      sources: sources.map((id) => ({ id })),
      known: knownSummary.size,
      cache: cache.size,
    }
  }

  return { list, get, details, prewarm, stats, sources }
}
