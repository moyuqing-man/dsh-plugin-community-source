/** 纯文本工具：转义、截断、格式化。没有任何依赖，可单独测试。 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** 用于 href/src 等属性位置：在 HTML 转义之外，额外挡住 javascript: 之类的协议。 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim()
  if (!/^https?:\/\//i.test(raw)) return ''
  return escapeHtml(raw)
}

export function truncate(value, max) {
  const s = String(value ?? '')
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/** 把多行文本压成一行，用于列表里的描述。 */
export function oneLine(value, max = 200) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
}

/** 1234 -> 1.2k；用于列表里的 star 数。 */
export function formatCount(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num < 0) return '—'
  if (num < 1000) return String(num)
  if (num < 10000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (num < 1_000_000) return Math.round(num / 1000) + 'k'
  return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
]

/**
 * 相对时间。`locale` 只影响单位词与语序。
 *
 * 中文是 `12 天前`（前缀），英文是 `12 days ago`（后缀 + 复数）。
 * 不引 `Intl.RelativeTimeFormat` 的原因和别处一样：零依赖红线，而且它在老一点的
 * Android WebView / Node 上未必有。
 */
const RELATIVE_WORDS = {
  zh: { now: '刚刚', year: '年', month: '个月', day: '天', hour: '小时', minute: '分钟', suffix: '前' },
  en: { now: 'just now', year: 'year', month: 'month', day: 'day', hour: 'hour', minute: 'minute', suffix: ' ago' },
}

export function relativeTime(iso, nowMs = Date.now(), locale = 'zh') {
  const t = typeof iso === 'number' ? iso : Date.parse(String(iso))
  if (!Number.isFinite(t)) return '—'
  const en = locale === 'en'
  const words = en ? RELATIVE_WORDS.en : RELATIVE_WORDS.zh
  const delta = nowMs - t
  if (delta < 60_000) return words.now
  for (const [key, size] of RELATIVE_UNITS) {
    if (delta >= size) {
      const n = Math.floor(delta / size)
      if (en) return `${n} ${words[key]}${n === 1 ? '' : 's'}${words.suffix}`
      return `${n} ${words[key]}${words.suffix}`
    }
  }
  return words.now
}

/**
 * 把各种仓库写法统一成 `owner/name`。
 * 支持 `owner/name`、`https://github.com/owner/name`、`git+https://…`、`github:owner/name`、结尾 .git。
 */
export function parseRepo(value) {
  let s = String(value ?? '').trim()
  if (!s) return null
  s = s.replace(/^git\+/, '').replace(/^github:/i, '')
  const url = /^https?:\/\//i.test(s) ? s : s.includes('/') && !s.includes('://') ? `https://github.com/${s}` : s
  let path
  try {
    const u = new URL(url)
    if (!/(^|\.)github\.com$/i.test(u.hostname)) return null
    path = u.pathname
  } catch {
    return null
  }
  const parts = path.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const owner = parts[0]
  const name = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null
  return `${owner}/${name}`
}

export function repoSlug(value) {
  const repo = parseRepo(value)
  return repo ? repo.toLowerCase() : ''
}

export function ownerOf(repo) {
  return String(repo).split('/')[0] ?? ''
}
