/**
 * 索引源：dsh-plugin-radar
 *
 * 端点（首选）：https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/PLUGINS.md
 * 端点（回退）：https://api.github.com/repos/AdamPlatin123/dsh-plugin-radar/contents/PLUGINS.md
 *   —— 带上 `accept: application/vnd.github.raw` 直接拿原文。
 *   本机实测 raw.githubusercontent.com 经常超时，而 api.github.com 稳定；
 *   但 api 那条要占 1 次 60/小时的配额，所以放在回退位。
 *
 * 形状（实测 357 行、301 条）：按 `## <emoji> <类别>` 分节，节内是 Markdown 表格
 *   | 插件 | 仓库 | 说明 | 运行级 |
 *   |---|---|---|---|
 *   | dsh-xiaomi-tts | [owner/repo](https://github.com/owner/repo) | 描述… | agent |
 */

import { upstreamFailed } from '../errors.js'
import { createCard } from '../normalize.js'

export const id = 'radar'
export const label = 'dsh-plugin-radar'
export const url = 'https://raw.githubusercontent.com/AdamPlatin123/dsh-plugin-radar/main/PLUGINS.md'
export const fallbackUrl = 'https://api.github.com/repos/AdamPlatin123/dsh-plugin-radar/contents/PLUGINS.md'
export const timeoutMs = 15_000
export const ttlMs = 6 * 3600_000

const GITHUB_LINK = /\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/

/** 去掉单元格里的 markdown 链接语法，只留可读文本。 */
function plainText(cell) {
  return String(cell ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

function splitRow(line) {
  const cells = line.split('|').map((c) => c.trim())
  // 标准表格行 `| a | b |` 分割后首尾各有一个空串
  if (cells.length && cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))

/** 纯函数：可直接用离线 fixture 测。 */
export function parse(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const cards = []
  const categoryCounts = new Map()
  let category = ''

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      // 「## 🔌 单插件」→ 类别名取 emoji 之后的文字
      category = heading[1].replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '').trim()
      continue
    }
    if (!line.startsWith('|')) continue

    const cells = splitRow(line)
    if (cells.length < 3 || isSeparator(cells)) continue

    const linkIndex = cells.findIndex((c) => GITHUB_LINK.test(c))
    if (linkIndex < 0) continue // 表头行走这里被丢掉

    const repoCell = GITHUB_LINK.exec(cells[linkIndex])
    const repo = repoCell?.[2] ?? ''
    const name = linkIndex > 0 ? plainText(cells[linkIndex - 1]) : ''
    const description = linkIndex + 1 < cells.length ? plainText(cells[linkIndex + 1]) : ''

    const card = createCard({ repo, name, description, category }, id)
    if (!card) continue
    card.categorySlug = category
    cards.push(card)
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  }

  return {
    id,
    cards,
    categories: Object.fromEntries([...categoryCounts.keys()].map((name) => [name, { en: '', zh: name }])),
    meta: {
      count: cards.length,
      skipped: 0,
      categories: [...categoryCounts.entries()].map(([name, count]) => ({ name, count })),
    },
  }
}

export async function load({ http, logger }) {
  try {
    const response = await http.request(url, { timeoutMs, retries: 0, label: 'radar PLUGINS.md' })
    if (response.ok) return parse(response.text)
    logger?.debug?.(`[community] radar 首选端点返回 ${response.status}，走回退`)
  } catch (error) {
    logger?.debug?.(`[community] radar 首选端点失败：${error?.message ?? error}，走回退`)
  }

  const response = await http.request(fallbackUrl, {
    timeoutMs: 20_000,
    retries: 1,
    label: 'radar PLUGINS.md（api 回退）',
    accept: 'application/vnd.github.raw',
  })
  if (!response.ok) {
    throw upstreamFailed(`radar 索引返回 ${response.status}`, { status: response.status, url: fallbackUrl })
  }
  const result = parse(response.text)
  result.meta.viaFallback = true
  return result
}
