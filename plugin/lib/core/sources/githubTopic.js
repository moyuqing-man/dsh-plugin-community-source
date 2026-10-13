/**
 * 索引源：GitHub topic 搜索
 *
 * 端点：https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars
 *
 * 为什么它是首屏源：实测约 0.9 秒返回，而 awesome 那份 5 MB 索引要 20 秒以上。
 *
 * ⚠️ 但它吃的是**独立的 search 配额桶**，未认证只有 10 次/分钟
 *    （实测：核心配额还剩 29 次时 search 已经 403）。
 *    所以这里有两条硬规矩：每页只打一次、缓存 30 分钟、绝不分页狂刷。
 */

import { upstreamFailed } from '../errors.js'
import { createCard } from '../normalize.js'

export const id = 'github-topic'
export const label = 'GitHub topic: dsh-plugin'
export const ttlMs = 30 * 60_000
export const timeoutMs = 12_000
export const perPage = 100
export const defaultPages = 2

export function searchUrl(page = 1) {
  const query = encodeURIComponent('topic:dsh-plugin')
  return `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
}

/** 纯函数：用离线 fixture 测。 */
export function parse(body) {
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw upstreamFailed('GitHub 搜索返回的不是合法 JSON')
  }
  const items = Array.isArray(data?.items) ? data.items : []

  const cards = []
  for (const item of items) {
    const card = createCard(
      {
        repo: item.full_name,
        description: item.description,
        stars: item.stargazers_count,
        openIssues: item.open_issues_count,
        pushedAt: item.pushed_at,
        archived: item.archived,
        license: item.license?.spdx_id ?? '',
        topics: item.topics,
        category: 'github-topic',
      },
      id,
    )
    if (card) cards.push(card)
  }

  return {
    id,
    cards,
    categories: {},
    meta: {
      count: cards.length,
      totalCount: Number(data?.total_count) || cards.length,
      incomplete: data?.incomplete_results === true,
      skipped: items.length - cards.length,
    },
  }
}

export async function load({ http, pages = defaultPages }) {
  const merged = []
  const metas = []
  let lastError = null

  for (let page = 1; page <= Math.max(1, pages); page += 1) {
    try {
      const response = await http.request(searchUrl(page), {
        timeoutMs,
        retries: 1,
        label: `GitHub topic 搜索 第 ${page} 页`,
        resource: 'search',
        accept: 'application/vnd.github+json',
      })
      if (!response.ok) {
        lastError = upstreamFailed(`GitHub 搜索返回 ${response.status}`, { status: response.status })
        break
      }
      const result = parse(response.text)
      merged.push(...result.cards)
      metas.push(result.meta)
      if (result.cards.length < perPage) break
    } catch (error) {
      lastError = error
      break
    }
  }

  if (merged.length === 0 && lastError) throw lastError

  return {
    id,
    cards: merged,
    categories: {},
    meta: {
      count: merged.length,
      totalCount: metas[0]?.totalCount ?? merged.length,
      incomplete: metas.some((m) => m.incomplete),
      pages: metas.length,
      degraded: Boolean(lastError),
    },
  }
}
