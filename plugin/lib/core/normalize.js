/**
 * PluginCard —— 所有索引源的统一出口形状。
 *
 * 说明为什么字段长这样：`awesome-dsh-plugin` 的索引里已经有 npm 包名、版本、
 * star、下载量、能力清单（capabilities）和安装命令，比文档里最初设想的「只有仓库地址」
 * 丰富得多。所以卡片结构以它为基准，其它源往里补。
 */

import { parseRepo } from './text.js'

export const MAX_DESCRIPTION = 400

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [])

export function normalizeDescription(raw) {
  if (!raw) return { en: '', zh: '' }
  if (typeof raw === 'string') {
    const text = raw.trim()
    // 单串描述没法问它是哪种语言，只能按字符集猜。猜错的代价仅仅是显示时走另一栏兜底，
    // 不会丢内容；但猜对了（radar 的说明列全是中文）就能让中文栏真正有值。
    const isCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
    return isCjk ? { en: '', zh: text } : { en: text, zh: '' }
  }
  return { en: str(raw.en), zh: str(raw.zh) }
}

export function normalizeCategory(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * @param {object} input 任意源的原始条目
 * @param {string} sourceId 源标识
 * @returns {object|null} 拿不到合法仓库坐标时返回 null（宁可丢掉也不要脏数据）
 */
export function createCard(input, sourceId) {
  if (!input || typeof input !== 'object') return null

  const candidate = str(input.repo) || str(input.fullName) || str(input.full_name) || str(input.url)
    || (str(input.owner) && str(input.name) ? `${str(input.owner)}/${str(input.name)}` : '')
  const repo = parseRepo(candidate)
  if (!repo) return null

  const [owner, repoName] = repo.split('/')
  // 展示名优先用源里给的名字：awesome 与 radar 都会显式给出插件名，
  // 而它和仓库名不一定相同（例：插件叫 dsh-xiaomi-tts，仓库叫 dsh-plugin-xiaomi-mimo-tts）。
  const displayName = str(input.displayName) || str(input.name) || repoName
  return {
    slug: repo.toLowerCase(),
    repo,
    name: displayName,
    owner,
    url: `https://github.com/${repo}`,
    page: str(input.page) || null,
    description: normalizeDescription(input.description),
    category: normalizeCategory(input.category),
    categoryLabel: input.categoryLabel && typeof input.categoryLabel === 'object'
      ? { en: str(input.categoryLabel.en), zh: str(input.categoryLabel.zh) }
      : { en: '', zh: '' },
    npm: str(input.npm) || null,
    version: str(input.version) || null,
    stars: num(input.stars),
    downloads: num(input.downloads),
    capabilities: arr(input.capabilities),
    capabilityRedLines: arr(input.capabilityRedLines),
    install: str(input.install) || null,
    added: str(input.added) || null,
    topics: arr(input.topics),
    archived: input.archived === true,
    license: str(input.license) || null,
    pushedAt: str(input.pushedAt) || null,
    openIssues: num(input.openIssues),
    /** 这条记录来自哪些索引源 —— 界面要显示出来，让用户自己判断可信度 */
    sources: sourceId ? [sourceId] : [],
  }
}

/** 「有值」的判定：0 和 false 是有效值，只有空串/空数组/null 才算缺。 */
function has(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

const union = (a = [], b = []) => [...new Set([...a, ...b])]

/**
 * 合并多个源的同一仓库记录。
 * 规则：非空优先；数值取最大（star/下载量在不同源上口径一致，取大更接近真实）；
 * 数组取并集；`sources` 累积。
 */
export function mergeCards(cards) {
  const byslug = new Map()
  for (const card of cards) {
    if (!card) continue
    const existing = byslug.get(card.slug)
    if (!existing) {
      byslug.set(card.slug, { ...card })
      continue
    }
    const merged = { ...existing }
    for (const key of Object.keys(card)) {
      if (key === 'sources') continue
      if (key === 'stars' || key === 'downloads' || key === 'openIssues') {
        const a = existing[key]
        const b = card[key]
        merged[key] = a === null ? b : b === null ? a : Math.max(a, b)
      } else if (Array.isArray(card[key])) {
        merged[key] = union(existing[key], card[key])
      } else if (key === 'archived') {
        merged[key] = existing.archived || card.archived
      } else if (!has(existing[key]) && has(card[key])) {
        merged[key] = card[key]
      }
    }
    merged.sources = union(existing.sources, card.sources)
    byslug.set(card.slug, merged)
  }
  return [...byslug.values()]
}

/**
 * 给卡片补上分类的中英文标签。
 * @param {Array} cards
 * @param {Record<string, {en?: string, zh?: string}>} categories
 */
export function applyCategories(cards, categories) {
  if (!categories || typeof categories !== 'object') return cards
  return cards.map((card) => {
    const label = categories[card.category]
    if (!label) return card
    return { ...card, categoryLabel: { en: str(label.en), zh: str(label.zh) } }
  })
}

export const SORTS = {
  stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.slug.localeCompare(b.slug),
  downloads: (a, b) => (b.downloads ?? -1) - (a.downloads ?? -1) || a.slug.localeCompare(b.slug),
  name: (a, b) => a.slug.localeCompare(b.slug),
  recent: (a, b) => String(b.added ?? '').localeCompare(String(a.added ?? '')) || a.slug.localeCompare(b.slug),
}
