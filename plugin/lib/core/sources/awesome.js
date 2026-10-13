/**
 * 索引源：awesome-dsh-plugin
 *
 * 端点：https://awesome-dsh-plugin.com/plugins.json
 * 形状（2026-10-13 实测）：
 *   { name, url, source, updated, count, categories: {slug: {en, zh}}, plugins: [...] }
 *   单条：{ name, owner, url, page, category, description: {en, zh}, npm, version,
 *          stars, downloads, downloadsStart, downloadsEnd, capabilities: [],
 *          capabilityRedLines: [], install, added }
 *
 * ⚠️ 实测体积 5.06 MB、冷启动耗时 21–32 秒。所以这个源：
 *   - 不参与首屏（首屏用 github-topic）
 *   - 在插件加载后台预热
 *   - 超时预算给到 45 秒，比其它源宽得多
 */

import { upstreamFailed } from '../errors.js'
import { applyCategories, createCard } from '../normalize.js'

export const id = 'awesome'
export const label = 'awesome-dsh-plugin'
export const url = 'https://awesome-dsh-plugin.com/plugins.json'
export const timeoutMs = 45_000
export const ttlMs = 6 * 3600_000

/** 纯函数：拆出来是为了能用离线 fixture 直接测解析，不碰网络。 */
export function parse(body) {
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw upstreamFailed('awesome 索引返回的不是合法 JSON')
  }
  const rawPlugins = Array.isArray(data?.plugins) ? data.plugins : []
  const categories = data?.categories && typeof data.categories === 'object' ? data.categories : {}

  const cards = []
  for (const entry of rawPlugins) {
    const card = createCard(entry, id)
    if (card) cards.push(card)
  }

  return {
    id,
    cards: applyCategories(cards, categories),
    categories,
    meta: {
      count: Number(data?.count) || cards.length,
      skipped: rawPlugins.length - cards.length,
      updated: typeof data?.updated === 'string' ? data.updated : null,
      homepage: typeof data?.url === 'string' ? data.url : null,
      upstream: typeof data?.source === 'string' ? data.source : null,
    },
  }
}

export async function load({ http }) {
  const response = await http.request(url, {
    timeoutMs,
    retries: 1,
    label: 'awesome 索引',
    accept: 'application/json',
  })
  if (!response.ok) {
    throw upstreamFailed(`awesome 索引返回 ${response.status}`, { status: response.status, url })
  }
  return parse(response.text)
}
