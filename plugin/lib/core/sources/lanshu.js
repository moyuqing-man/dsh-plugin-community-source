/**
 * 索引源：岚叔目录
 *
 * 端点：https://dsh.lanshuagent.com/api/plugins
 * 形状：{ plugins: [ ... ] }
 *   单条：{ repo, url, description, stars, pushedAt, archived, license, category,
 *          installCommand, maintenance, curated, manifest: { state, packageName, ... },
 *          screening: { state, risk, findings: [{ id, severity, label: { zh, en } }] },
 *          attention: { level, reasons[] } }
 *
 * 条目最多（2026-10-14 实测 655 条），且**每条的信息量最大**：带归档、最近推送、
 * 许可证、维护状态、目录审核结论（含逐项 findings）、目录关注等级、以及 `curated`
 * 标记 —— 正是判断「还活着吗、有没有风险」需要的信号。
 *
 * 上游注释里有一条必须照抄的教训：`screening`、`attention`、`manifest` 都是**对象**，
 * 直接字符串化会得到 `[object Object]`，那比什么都不说更糟。
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

/*
 * 上游取值的真实分布（2026-10-14 对 655 条全量统计，不是猜的）：
 *   screening.state   clear 61 / review 467 / pending 105 / blocked 22
 *   screening.risk    low / medium / high / unknown（medium 是常态）
 *   attention.level   clear 111 / review 512 / caution 32
 *   screening.findings  high 23 / medium 1181
 *
 * **只有 blocked / high / caution 是坏消息。**
 *
 * 早先的写法是拿「白名单」反推（`BENIGN_SCREENING = ['pass','ok','pending']`）。
 * 那份白名单里既没有 `blocked`，也没有 `clear` —— 于是**上游结论最好的 61 条
 * 反而被挂上「目录审核：clear」的红线**，而判据本该警戒的 22 条 `blocked`
 * 里只有 `pending` 之外的会被拦下。判据是反的，等于把最安全的插件报成最危险的。
 * 现在改成正面列出「哪些是坏消息」，未知取值默认不报警 —— 宁可漏报噪音，
 * 也不要把干净的东西涂红：红线一旦泛滥，真正的警告就没人看了。
 *
 * `medium` 级 findings（缺锁文件、有网络请求、读环境变量、有 postinstall…）
 * 在 655 条里出现 1181 次，几乎是所有插件的常态，因此只在 blocked 时列出 `high` 级。
 */
const BAD_STATE = new Set(['blocked'])
const BAD_RISK = new Set(['high'])
const BAD_ATTENTION = new Set(['caution'])

/** 一张卡片的说明/红线最多列这么多项，避免详情页变成一面墙。 */
const MAX_LINES = 4

function joinCapped(items, max = MAX_LINES) {
  if (items.length <= max) return items.join('；')
  return `${items.slice(0, max).join('；')}；等 ${items.length} 项`
}

/** `high` 级 findings 的说明。上游自带 zh/en 双语 label，优先中文。 */
function severeFindings(entry) {
  const findings = Array.isArray(entry.screening?.findings) ? entry.screening.findings : []
  return findings
    .filter((f) => f && typeof f === 'object' && f.severity === 'high')
    .map((f) => str(f.label?.zh) || str(f.label?.en) || str(f.id))
    .filter(Boolean)
}

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

    const state = str(entry.screening?.state)
    const risk = str(entry.screening?.risk)
    if (BAD_STATE.has(state) || BAD_RISK.has(risk)) {
      const severe = severeFindings(entry)
      redLines.push(`目录审核未通过${severe.length ? `：${joinCapped(severe)}` : ''}`)
    }

    if (BAD_ATTENTION.has(str(entry.attention?.level))) {
      const reasons = Array.isArray(entry.attention?.reasons)
        ? entry.attention.reasons.filter((r) => typeof r === 'string' && r.trim())
        : []
      redLines.push(`目录提醒：${reasons.length ? joinCapped(reasons) : '需要人工确认'}`)
    }

    // 维护状态与精选是**正面**信息，进「说明」而不是红线。
    const maintenance = str(entry.maintenance)
    if (maintenance && maintenance !== 'active') capabilities.push(`维护状态：${maintenance}`)
    if (entry.curated === true) capabilities.push('目录精选')

    // 上游没在仓库里认出 dsh manifest。没到 blocked 就不当警告，但值得如实说出来：
    // 它可能根本不是插件，只是恰好带了 topic。
    const manifestState = str(entry.manifest?.state)
    if (manifestState === 'missing' && !BAD_STATE.has(state)) {
      capabilities.push('上游未识别到 dsh manifest')
    }
    if (entry.archived === true) redLines.push('仓库已归档')

    /*
     * npm 名：安装命令里能读出来就用读出来的。
     *
     * 但 655 条里只有 131 条有 `installCommand`（且全都是 `github:owner/repo#sha`，
     * 推不出 npm 名），另有 475 条**只有** `manifest.packageName`、49 条两者都没有。
     * 只用安装命令会让 475 条白白丢掉 npm 名 —— 而 `?pkg=` 反查（拿 npm 包名找仓库）
     * 正是靠这个字段工作的。
     *
     * `packageName` 来自上游读到的仓库 `package.json`，所以它是「**声明的**包名」，
     * 不是「已发布到 npm」的证明。这一点与同族源一致：`dsh-works` 直接透传上游的
     * `npm` 字段、`awesome` 直接透传清单里的 npm 字段，都没有联网核实过。
     * 有安装命令时以安装命令为准（那是上游审核过、可直接执行的）。
     */
    const npm = npmFromTarget(target) || str(entry.manifest?.packageName)

    const card = createCard(
      {
        repo,
        description: entry.description,
        stars: entry.stars,
        npm,
        install: entry.installCommand,
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
