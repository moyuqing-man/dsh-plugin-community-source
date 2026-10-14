/**
 * 索引质量治理：把「打着 topic 标签的仓库」和「真的是插件」分开。
 *
 * 为什么需要这一层（这是实测出来的真问题，不是假想）：
 * `github-topic` 源查的是 `topic:dsh-plugin`，而 **topic 是自我声明**——
 * 谁都可以给自己的仓库打上这个标签，GitHub 不会核对。结果是官方框架本体
 * `deepseek-ai/deepseek-harness`（★248k）排在第一位，而它显然不是插件。
 * 该 topic 下共有 19055 个仓库，光靠 star 排序根本压不住这类噪声。
 *
 * 设计上有三条刻意的选择：
 *
 * 1. **不删，只降级。** 框架与聚合清单仍然出现在列表里，只是排到后面并打上
 *    「框架本体 / 聚合清单」标签。把它们悄悄藏掉会让人以为索引不全 ——
 *    说「它在这，但它不是插件」比假装它不存在更诚实。
 *    `sort=stars` 仍然是**纯 star 排序**，想按原样看随时能看。
 *
 * 2. **信号是可解释的。** 每个加分项都对应一个可以指给用户看的理由
 *    （有 npm 包 / 有安装命令 / 被两个以上源同时收录…）。没有黑箱权重。
 *
 * 3. **纯函数、零依赖。** 不 import 任何别的东西，所以它可以被单独测。
 */

/** 被打上 topic 但并不是插件的「容器」仓库。可被配置里的 `excludeRepos` 追加。 */
export const KNOWN_FRAMEWORKS = Object.freeze(['deepseek-ai/deepseek-harness'])

/**
 * 「聚合清单」的识别：仓库名像 awesome-xxx / xxx-list / curated-xxx 的，
 * 内容通常是**指路**而不是**功能**。注意 `dsh-plugin-marketplace` 这种
 * 虽然叫 marketplace，但它本身是个能装的插件（一个浏览市场的界面），
 * 所以判据只认「清单形态」的名字，不认 marketplace / registry 这类词。
 */
const AGGREGATOR_NAME = /(^|[-_/])awesome([-_]|$)|[-_]list$|^awesome[-_]|[-_]awesome$/i

/** 插件名惯例：DSH 生态里绝大多数包/仓库以 `dsh-` 开头。 */
const PLUGIN_NAME = /^dsh[-_]|dsh[-_]?plugin/i

/** 描述里的插件味道（中英都要认，索引里两种语言都有）。 */
const PLUGIN_HINT = /插件|面板|plugin|panel|widget|tool for|扩展|extension/i

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/**
 * 把配置里手写的仓库名单规整成可比较的形式。
 *
 * **必须 trim**：名单是人在 YAML / JSON 里手写的，多一个尾空格
 * （或者从别处粘贴时带上空格）就会静默失效 —— 用户配了 `excludeRepos`
 * 却发现那个仓库还在，而且完全看不出为什么。这种失败方式最难查。
 */
const repoList = (items) =>
  new Set(
    (items ?? [])
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter(Boolean),
  )

function repoKey(card) {
  return str(card?.repo).toLowerCase()
}

/**
 * 这条记录是「框架」「聚合清单」还是「插件」。
 *
 * `unknown` 是给「既没有插件信号、也看不出是什么」的仓库留的一档 ——
 * 它们不是错的，只是没有任何证据说明它是插件，所以不给它插件的位置。
 */
export function classifyCard(card, { frameworks = KNOWN_FRAMEWORKS } = {}) {
  const key = repoKey(card)
  if (!key) return 'unknown'
  if (repoList(frameworks).has(key)) return 'framework'
  if (AGGREGATOR_NAME.test(str(card?.name)) || AGGREGATOR_NAME.test(key)) return 'aggregator'
  if (confidenceOf(card) >= 0.45) return 'plugin'
  return 'unknown'
}

/**
 * 「这有多像一个真插件」——0 到 1。
 *
 * 每一项都有明确理由，加起来封顶 1：
 *   npm 包名         0.35  插件靠 npm 分发，有包名是最硬的证据
 *   安装命令         0.25  索引源给了可执行的安装方式，说明被当成插件整理过
 *   多源同时收录     0.20  两个互不相干的目录都收了它，比自我声明可靠
 *   命名符合惯例     0.12  `dsh-xxx` 是生态内的约定
 *   描述里有插件词   0.08  最弱的一项，只是佐证
 */
export function confidenceOf(card) {
  if (!card || typeof card !== 'object') return 0
  let score = 0
  if (str(card.npm)) score += 0.35
  if (str(card.install)) score += 0.25
  if (Array.isArray(card.sources) && card.sources.length >= 2) score += 0.2
  if (PLUGIN_NAME.test(str(card.name)) || PLUGIN_NAME.test(repoKey(card))) score += 0.12
  const desc = `${str(card.description?.en)} ${str(card.description?.zh)} ${str(card.description)}`
  if (PLUGIN_HINT.test(desc)) score += 0.08
  return Math.min(1, Number(score.toFixed(4)))
}

/** 每个加分项对应的理由，给用户看（工具卡片与详情页会用到）。 */
export function rankSignals(card) {
  const out = []
  if (str(card?.npm)) out.push('npm')
  if (str(card?.install)) out.push('install')
  if (Array.isArray(card?.sources) && card.sources.length >= 2) out.push('multi-source')
  if (PLUGIN_NAME.test(str(card?.name)) || PLUGIN_NAME.test(repoKey(card))) out.push('name')
  return out
}

/**
 * 混合评分。
 *
 * 直观理解：**star 决定量级，插件证据决定打几折**。
 * `log10` 把 star 从「线性」压成「数量级」，否则一个 24 万 star 的仓库
 * 会让所有真插件永远翻不了身。
 *
 * 容器降级是这里的第二道闸：框架乘 0.1、聚合清单乘 0.3、看不出是插件的乘 0.6。
 * 实测效果：`deepseek-ai/deepseek-harness` 从第 1 名掉出第一屏，
 * 而★400 左右、有 npm 包的真插件会排到它前面。
 */
export function rankScore(card, options = {}) {
  const base = Math.log10((Number(card?.stars) || 0) + 1)
  const confidence = confidenceOf(card)
  let score = base * (0.35 + 0.65 * confidence)
  const kind = classifyCard(card, options)
  if (kind === 'framework') score *= 0.1
  else if (kind === 'aggregator') score *= 0.3
  else if (kind === 'unknown') score *= 0.6
  // 有人提 issue 说明有人在真的用它。封顶 20 条，免得 issue 多的项目压过 star。
  score += Math.min(Number(card?.openIssues) || 0, 20) / 200
  return Number(score.toFixed(6))
}

/** 排序比较器：评分降序 → star 降序 → slug 升序（保证结果稳定可复现）。 */
export function compareRank(a, b, options = {}) {
  const diff = rankScore(b, options) - rankScore(a, options)
  if (diff) return diff
  const stars = (Number(b?.stars) || 0) - (Number(a?.stars) || 0)
  if (stars) return stars
  return String(a?.slug ?? '').localeCompare(String(b?.slug ?? ''))
}

/** 给每条记录补上 `kind` 与 `confidence` 两个可展示字段（不改动原对象）。 */
export function applyKinds(cards, options = {}) {
  return (cards ?? []).map((card) =>
    card ? { ...card, kind: classifyCard(card, options), confidence: confidenceOf(card) } : card,
  )
}

/**
 * 排除名单。默认**为空**——框架本体是被降级而不是被删掉，
 * 只有用户显式配置了 `excludeRepos` 才真的过滤。
 */
export function excludeRepos(cards, excludes = []) {
  const drop = repoList(excludes)
  if (!drop.size) return cards ?? []
  return (cards ?? []).filter((card) => card && !drop.has(repoKey(card)))
}

export const KIND_LABELS = Object.freeze({
  framework: { zh: '框架本体', en: 'Framework' },
  aggregator: { zh: '聚合清单', en: 'List' },
  plugin: { zh: '插件', en: 'Plugin' },
  unknown: { zh: '', en: '' },
})
