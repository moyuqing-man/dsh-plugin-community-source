/**
 * 索引源：dsh.so
 *
 * 端点：https://www.dsh.so/plugins-index.json
 * 形状：{ name, url, ..., plugins: [ ... ] }
 *   单条：{ install, url, description, stars, topics[], verification: {level, label},
 *          security: {status, riskLevel} }
 *
 * 这是**能力最强**的一个源：它是唯一带「验证等级」和「安全扫描结论」的源。
 * 代价是体积 —— 实测 19.7 MB（dsh-find-plugins 的注释说约 9 MB）、冷启动 18.9 秒。
 * 所以：
 *   - **不进默认源集**，必须显式在配置里写 `sources: ['dsh-so']` 才会加载
 *   - 超时预算给到 90 秒
 *   - 缓存 6 小时
 *
 * 两个**必须照抄的细节**（来自 dsh-find-plugins 的实现，那是踩过坑的版本）：
 * 1. `security.riskLevel` 有四档 low/medium/high/**critical**。用 if/else 只判 `high`
 *    会让 critical 掉到 else 里被当成安全 —— 实测在野外抓到过 critical。
 * 2. 仓库坐标要从 `install` 命令里取（`targetFromCommand`），不是从 `url` 字段；
 *    `url` 是插件主页，常常是文档站而不是仓库。
 */

import { upstreamFailed } from '../errors.js'
import { createCard } from '../normalize.js'
import { parseRepo } from '../text.js'
import { npmFromTarget, repoFromTarget, targetFromCommand } from './install.js'

export const id = 'dsh-so'
export const label = 'dsh.so'
export const url = 'https://www.dsh.so/plugins-index.json'
export const timeoutMs = 90_000
export const ttlMs = 6 * 3600_000
/** 体积大，不进默认源集。 */
export const optIn = true

const str = (v) => (typeof v === 'string' ? v.trim() : '')

const RISK_NOTES = {
  critical: 'dsh.so 安全扫描：严重风险',
  high: 'dsh.so 安全扫描：高风险',
  medium: 'dsh.so 安全扫描：中风险',
}

export function parse(body) {
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw upstreamFailed('dsh.so 索引返回的不是合法 JSON')
  }
  const raw = Array.isArray(data?.plugins) ? data.plugins : []

  const cards = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const target = targetFromCommand(entry.install)
    const repo = repoFromTarget(target) || parseRepo(str(entry.url))
    if (!repo) continue

    const topics = Array.isArray(entry.topics) ? entry.topics.filter((t) => typeof t === 'string' && t.trim()) : []
    const riskLevel = str(entry.security?.riskLevel).toLowerCase()
    const riskNote = RISK_NOTES[riskLevel]

    const capabilities = []
    if (riskNote) capabilities.push(riskNote)
    const level = str(entry.verification?.level)
    if (level) capabilities.push(`dsh.so 验证等级：${level}`)
    const securityStatus = str(entry.security?.status)
    if (securityStatus && securityStatus !== 'clean') capabilities.push(`dsh.so 扫描状态：${securityStatus}`)

    const card = createCard(
      {
        repo,
        description: entry.description,
        stars: entry.stars,
        npm: npmFromTarget(target),
        // topics 是这个源里唯一的英文词汇表，全量进搜索文本，不能只取第一个
        topics,
        category: topics[0] ?? null,
        capabilities,
        // 只把「真的危险」放进红线；验证等级是正面信息，不该混进来吓人
        capabilityRedLines: riskNote ? [riskNote] : [],
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
    label: 'dsh.so 索引',
    accept: 'application/json',
  })
  if (!response.ok) {
    throw upstreamFailed(`dsh.so 索引返回 ${response.status}`, { status: response.status, url })
  }
  return parse(response.text)
}
