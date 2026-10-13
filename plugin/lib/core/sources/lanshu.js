/**
 * 索引源：岚叔目录
 *
 * 端点：https://dsh.lanshuagent.com/api/plugins
 * 形状：{ plugins: [ ... ] }
 *   单条：{ repo, url, description, stars, pushedAt, archived, license, category,
 *          installCommand, maintenance, screening: {state, risk}, attention: {level, reasons[]} }
 *
 * 条数最少（约 560），但**每条的信息量最大**：带归档、最近推送、许可证、维护状态、
 * 目录审核结论、目录关注等级、以及 `curated` 标记 —— 正是判断「还活着吗、有没有风险」
 * 需要的信号。
 *
 * 上游注释里有一条必须照抄的教训：`screening` 与 `attention` 都是**对象**
 * （`{state, risk}` / `{level, reasons[]}`），直接字符串化会得到 `[object Object]`，
 * 那比什么都不说更糟。只有**明确的坏消息**才写成提示 —— `pending` / `unknown`
 * 是常态，全写出来会把真正的警告淹掉。
 *
 * 本机实测该端点超时（2026-10-13），所以它**不进默认源集**。
 */

import { upstreamFailed } from '../errors.js'
import { createCard } from '../normalize.js'
import { parseRepo } from '../text.js'
import { npmFromTarget, targetFromCommand } from './install.js'

export const id = 'lanshu'
export const label = '岚叔目录'
export const url = 'https://dsh.lanshuagent.com/api/plugins'
export const timeoutMs = 25_000
export const ttlMs = 6 * 3600_000
export const optIn = true

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** 常态值：把这些当成「好消息」处理，不进提示。 */
const BENIGN_SCREENING = new Set(['pass', 'ok', 'pending'])
const BENIGN_RISK = new Set(['low', 'none', 'unknown'])

export function parse(body) {
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw upstreamFailed('岚叔目录返回的不是合法 JSON')
  }
  const raw = Array.isArray(data?.plugins) ? data.plugins : []

  const cards = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const repo = str(entry.repo) || parseRepo(str(entry.url))
    if (!repo) continue

    const target = targetFromCommand(entry.installCommand)
    const capabilities = []
    const redLines = []

    const screeningState = str(entry.screening?.state)
    if (screeningState && !BENIGN_SCREENING.has(screeningState)) {
      redLines.push(`目录审核：${screeningState}`)
    }
    const screeningRisk = str(entry.screening?.risk)
    if (screeningRisk && !BENIGN_RISK.has(screeningRisk)) {
      redLines.push(`目录审核风险：${screeningRisk}`)
    }

    const attention = str(entry.attention?.level)
    if (attention && attention !== 'clear') {
      const reasons = Array.isArray(entry.attention?.reasons)
        ? entry.attention.reasons.filter((r) => typeof r === 'string' && r.trim())
        : []
      redLines.push(`目录关注：${attention}${reasons.length ? `（${reasons.join('；')}）` : ''}`)
    }

    const maintenance = str(entry.maintenance)
    if (maintenance && maintenance !== 'active') capabilities.push(`维护状态：${maintenance}`)
    if (entry.archived === true) redLines.push('仓库已归档')
    if (entry.curated === true) capabilities.push('目录精选')

    const card = createCard(
      {
        repo,
        description: entry.description,
        stars: entry.stars,
        npm: npmFromTarget(target),
        category: entry.category || null,
        license: entry.license,
        pushedAt: entry.pushedAt,
        archived: entry.archived === true,
        capabilities,
        capabilityRedLines: redLines,
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
    label: '岚叔目录',
    accept: 'application/json',
  })
  if (!response.ok) {
    throw upstreamFailed(`岚叔目录返回 ${response.status}`, { status: response.status, url })
  }
  return parse(response.text)
}
