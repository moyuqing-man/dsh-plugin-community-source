/**
 * 索引源：dsh.works registry（`awesome-dsh-plugins`）
 *
 * 端点：https://dsh.works/awesome-dsh-plugins/plugins.json
 * 形状：{ plugins: [ ... ] }
 *   单条：{ name, category, status, official, repo, npm, path, description, stars,
 *          pushedAt, tags[], verifiedAgainst, lastVerified }
 *
 * 这是唯一一个「机器优先」的目录：它记录**每个安装路径是在哪个文件里被验证过的**，
 * 以及**对着哪个 dsh 版本验的**，所以它能说别家说不了的话。
 *
 * 两条上游自己就在做的过滤，照抄（理由来自上游注释）：
 * - `category !== 'plugin'` 丢掉：同一个注册表还列了 core bundle（dsh-base、dsh-web-app）、
 *   技能、主题和工具。bundle 是官方核心，把它当「可以装的插件」推出去是噪音。
 * - `status === 'broken'` 丢掉：它当初验证过的安装路径在上游已经不存在了。
 *   **`unverified` 要留下并标注** —— 没人复核过不等于不是真插件，藏起来等于悄悄缩小生态。
 *
 * 本机实测该端点超时（2026-10-13），所以它**不进默认源集**，配置里显式写才启用。
 */

import { upstreamFailed } from '../errors.js'
import { createCard } from '../normalize.js'

export const id = 'dsh-works'
export const label = 'dsh.works'
export const url = 'https://dsh.works/awesome-dsh-plugins/plugins.json'
export const timeoutMs = 25_000
export const ttlMs = 6 * 3600_000
export const optIn = true

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** `owner/name`，否则空串。 */
function repoOf(value) {
  const text = str(value)
  return /^[^/\s]+\/[^/\s]+$/.test(text) ? text : ''
}

export function parse(body) {
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw upstreamFailed('dsh.works 索引返回的不是合法 JSON')
  }
  const raw = Array.isArray(data?.plugins) ? data.plugins : []

  const cards = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.category !== 'plugin') continue
    if (entry.status === 'broken') continue

    const repo = repoOf(entry.repo)
    // 卡片是**以仓库为主键**的；只有 npm 名没有仓库的条目进不来（拿不到 slug）。
    // 这是有意的取舍：宁可少几条，也不要一堆点不开的条目。
    if (!repo) continue

    const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === 'string' && t.trim()) : []
    const capabilities = []
    if (entry.status === 'unverified') capabilities.push('安装路径未复核')
    if (entry.official === true) capabilities.push('官方')
    if (str(entry.verifiedAgainst)) {
      capabilities.push(`对着 dsh ${str(entry.verifiedAgainst)} 验证过`)
    }

    const card = createCard(
      {
        repo,
        displayName: entry.name,
        description: entry.description,
        stars: entry.stars,
        npm: entry.npm,
        topics: tags,
        category: tags[0] ?? null,
        capabilities,
        pushedAt: entry.pushedAt,
      },
      id,
    )
    if (card) cards.push(card)
  }

  return {
    id,
    cards,
    categories: {},
    meta: { count: raw.length, skipped: raw.length - cards.length },
  }
}

export async function load({ http }) {
  const response = await http.request(url, {
    timeoutMs,
    retries: 1,
    label: 'dsh.works 索引',
    accept: 'application/json',
  })
  if (!response.ok) {
    throw upstreamFailed(`dsh.works 索引返回 ${response.status}`, { status: response.status, url })
  }
  return parse(response.text)
}
