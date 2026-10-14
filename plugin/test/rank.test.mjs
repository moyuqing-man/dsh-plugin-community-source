/**
 * 索引质量治理（`lib/core/rank.js`）的测试。
 *
 * 这一层要解决的是一个**实测出来的**问题，所以测试也用实测数据当基准：
 * `github-topic` 源查 `topic:dsh-plugin`，而 topic 是自我声明标签，
 * 官方框架 `deepseek-ai/deepseek-harness`（★248000）因此霸榜。
 * 下面几条用例就是拿这个真实场景钉住的 —— 如果哪天有人「顺手」
 * 把 log10 换成线性，或者把降级系数调没了，这里会立刻红。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  KIND_LABELS,
  KNOWN_FRAMEWORKS,
  applyKinds,
  classifyCard,
  compareRank,
  confidenceOf,
  excludeRepos,
  rankScore,
  rankSignals,
} from '../lib/core/rank.js'

/** 一个「像样的插件」：有 npm 包、有安装命令、被两个源收录、名字合规。 */
const realPlugin = {
  slug: 'alice/dsh-hello',
  repo: 'alice/dsh-hello',
  name: 'dsh-hello',
  stars: 320,
  npm: 'dsh-hello',
  install: 'dsh plugin add dsh-hello',
  sources: ['github-topic', 'awesome'],
  description: { en: 'a plugin that says hi', zh: '一个打招呼的插件' },
}

/** 真实的框架本体，star 数是插件的三个数量级。 */
const framework = {
  slug: 'deepseek-ai/deepseek-harness',
  repo: 'deepseek-ai/deepseek-harness',
  name: 'deepseek-harness',
  stars: 248000,
  sources: ['github-topic'],
  description: { en: 'the DSH framework itself' },
}

/** 一个只有 topic 标签、别的什么都没有的仓库。 */
const bare = {
  slug: 'someone/random-thing',
  repo: 'someone/random-thing',
  name: 'random-thing',
  stars: 40,
  sources: ['github-topic'],
  description: { en: 'nothing in particular' },
}

test('classifyCard：框架、聚合清单、插件、未知四档都认得出来', () => {
  assert.equal(classifyCard(framework), 'framework')
  assert.equal(classifyCard(realPlugin), 'plugin')
  assert.equal(classifyCard(bare), 'unknown')

  // 聚合清单：名字形态就是判据
  assert.equal(classifyCard({ ...realPlugin, slug: 'x/awesome-dsh', name: 'awesome-dsh', repo: 'x/awesome-dsh' }), 'aggregator')
  assert.equal(classifyCard({ ...realPlugin, slug: 'x/dsh-list', name: 'dsh-list', repo: 'x/dsh-list' }), 'aggregator')
  // 但 `marketplace` 不算 —— dsh-plugin-marketplace 本身是个能装的插件
  assert.notEqual(
    classifyCard({ ...realPlugin, slug: 'x/dsh-plugin-marketplace', name: 'dsh-plugin-marketplace', repo: 'x/dsh-plugin-marketplace' }),
    'aggregator',
  )
})

test('classifyCard 的框架名单可以被调用方覆盖（配置里能加自己的框架）', () => {
  const other = { slug: 'acme/acme-core', repo: 'acme/acme-core', name: 'acme-core', stars: 9000, sources: ['github-topic'] }
  assert.notEqual(classifyCard(other), 'framework')
  assert.equal(classifyCard(other, { frameworks: ['acme/acme-core'] }), 'framework')
  // 大小写不敏感 —— 配置里手写的名单不该因为大小写就失效
  assert.equal(classifyCard(other, { frameworks: ['Acme/ACME-Core'] }), 'framework')
})

test('classifyCard：空输入不抛错', () => {
  assert.equal(classifyCard(null), 'unknown')
  assert.equal(classifyCard({}), 'unknown')
  assert.equal(classifyCard({ repo: '   ' }), 'unknown')
  assert.equal(confidenceOf(undefined), 0)
  assert.equal(confidenceOf(null), 0)
})

test('confidenceOf：四个信号各占一份权重，加起来封顶 1', () => {
  assert.equal(confidenceOf(realPlugin), 1)
  // 拆开看，每一项都单独成立
  assert.equal(confidenceOf({ npm: 'x' }), 0.35)
  assert.equal(confidenceOf({ install: 'dsh plugin add x' }), 0.25)
  assert.equal(confidenceOf({ sources: ['a', 'b'] }), 0.2)
  assert.equal(confidenceOf({ sources: ['a'] }), 0)
  assert.equal(confidenceOf({ name: 'dsh-x' }), 0.12)
  assert.equal(confidenceOf({ description: { en: 'a plugin' } }), 0.08)
  // 中英描述都认
  assert.equal(confidenceOf({ description: { zh: '一个插件' } }), 0.08)
  // 单调叠加，但永不超过 1
  assert.equal(confidenceOf({ ...realPlugin, stars: 1e9 }), 1)
})

test('rankSignals：列出的理由与真正加分的项一致（可解释性）', () => {
  assert.deepEqual(rankSignals(realPlugin), ['npm', 'install', 'multi-source', 'name'])
  assert.deepEqual(rankSignals(bare), [])
  // 描述里的插件词会加分，但**不进**理由是刻意的：它太弱，说出来反而像噪音
  assert.deepEqual(rankSignals({ description: { en: 'a plugin' } }), [])
})

test('rankScore：★248000 的框架本体排在★320 的真插件后面（这是这个模块存在的理由）', () => {
  const fw = rankScore(framework)
  const plugin = rankScore(realPlugin)
  assert.ok(plugin > fw, `真插件(${plugin}) 必须排在框架(${fw}) 前面`)
})

test('rankScore：用 log10 压量级 —— 否则 24 万 star 永远翻不了身', () => {
  // 两个同类型的真插件，star 差 1000 倍，分数差距应该只有约 3 倍（log10）
  const small = rankScore({ ...realPlugin, stars: 100 })
  const big = rankScore({ ...realPlugin, stars: 100000 })
  const ratio = big / small
  assert.ok(ratio > 1.5 && ratio < 2.5, `star 差 1000 倍时分数只该差约 ${Math.log10(100000)} 倍(≈2)，实际 ${ratio}`)
})

test('rankScore：容器降级的系数是可验证的（框架 0.1 / 清单 0.3 / 未知 0.6）', () => {
  // 星数与置信度都固定，只有「是什么」在变 —— 这样比出来的差距就是降级系数。
  // 注意：比较必须在**同一置信度**下做，否则比的是「证据多不多」而不是「降了几折」。
  const base = {
    slug: 'x/y',
    repo: 'x/y',
    name: 'y',
    stars: 10000,
    sources: ['a', 'b'],
    description: { en: 'a plugin' },
  }
  // 证据只有「多源 0.2 + 描述 0.08」= 0.28 < 0.45 → 未知档
  assert.equal(confidenceOf(base), 0.28)
  assert.equal(classifyCard(base), 'unknown')

  // 同一个仓库，只是名字像清单 → 同一置信度,换成聚合清单档
  const aggCard = { ...base, name: 'y-list', repo: 'x/y-list', slug: 'x/y-list' }
  assert.equal(confidenceOf(aggCard), 0.28, '改名字不该改变置信度')
  assert.equal(classifyCard(aggCard), 'aggregator')

  const unknown = rankScore(base)
  const agg = rankScore(aggCard)
  // 降级系数：框架 0.1 < 聚合清单 0.3 < 未知 0.6 < 插件 1
  // 越「确定它是个容器」，压得越狠 —— 未知只是「没证据说它是插件」，不该比清单更惨。
  assert.ok(agg < unknown, `置信度相同时，聚合清单(${agg}) 该排在被降级更少的未知(${unknown}) 后面`)

  // 补上硬证据（npm + 安装命令）后置信度到 0.88 → 插件档，降级消失
  const strong = { ...base, npm: 'dsh-y', install: 'dsh plugin add dsh-y' }
  assert.equal(classifyCard(strong), 'plugin')
  assert.ok(rankScore(strong) > unknown, '有硬证据的插件要排在最前面')
})

test('rankScore：框架降级最狠（×0.1），但不会掉到 0', () => {
  const asPlugin = rankScore({ ...realPlugin, stars: 248000 })
  const asFramework = rankScore({ ...realPlugin, stars: 248000, repo: 'deepseek-ai/deepseek-harness', slug: 'deepseek-ai/deepseek-harness' })
  assert.equal(classifyCard({ ...realPlugin, repo: 'deepseek-ai/deepseek-harness' }), 'framework')
  assert.ok(asFramework < asPlugin * 0.15, `框架要打一折：${asFramework} vs ${asPlugin}`)
  assert.ok(asFramework > 0, '降级不是清零 —— 它还在列表里，只是不占前排')
  // 同一置信度下，框架档压得比聚合清单还狠
  const fwBase = { slug: 'deepseek-ai/deepseek-harness', repo: 'deepseek-ai/deepseek-harness', name: 'y', stars: 10000, sources: ['a', 'b'], description: { en: 'a plugin' } }
  const aggBase = { ...fwBase, slug: 'x/y-list', repo: 'x/y-list', name: 'y-list' }
  assert.equal(confidenceOf(fwBase), confidenceOf(aggBase))
  assert.ok(rankScore(fwBase) < rankScore(aggBase), '框架降级比清单更狠')
})

test('rankScore：openIssues 加分但封顶 20，免得 issue 多的项目压过 star', () => {
  const quiet = rankScore({ ...realPlugin, openIssues: 0 })
  const noisy = rankScore({ ...realPlugin, openIssues: 15 })
  const flood = rankScore({ ...realPlugin, openIssues: 5000 })
  assert.ok(noisy > quiet)
  assert.equal(flood, rankScore({ ...realPlugin, openIssues: 20 }), '超过 20 条就不再加分')
})

test('compareRank：先比分数，同分比 star，再同就按 slug 升序（结果必须稳定可复现）', () => {
  const a = { ...realPlugin, slug: 'a/x' }
  const b = { ...realPlugin, slug: 'b/x' }
  // 两条完全一样，只有 slug 不同 → 按 slug 升序，且**正反都得到同一个顺序**
  assert.ok(compareRank(a, b) < 0)
  assert.ok(compareRank(b, a) > 0)
  assert.equal(compareRank(a, a), 0)

  // 稳定排序：打乱顺序排出来的结果必须一致
  const pool = [framework, realPlugin, bare, { ...realPlugin, slug: 'z/dsh-other', stars: 900 }]
  const once = [...pool].sort(compareRank).map((c) => c.slug)
  const twice = [...pool].reverse().sort(compareRank).map((c) => c.slug)
  assert.deepEqual(once, twice, '相同输入的排序结果不能因为初始顺序而变')
})

test('已知真实场景：smart 排序把框架本体踢出真插件的前面', () => {
  const pool = [framework, { ...realPlugin, stars: 400 }, bare]
  const sorted = [...pool].sort(compareRank)
  assert.equal(sorted[0].slug, 'alice/dsh-hello', '★400 的真插件要排在 ★248000 的框架前面')
  assert.equal(sorted.at(-1).slug, framework.slug, '框架本体降到最后（但还是留在列表里）')
})

test('applyKinds：补 kind 与 confidence，且**不改动原对象**', () => {
  const input = [realPlugin, framework]
  const out = applyKinds(input)
  assert.equal(out[0].kind, 'plugin')
  assert.equal(out[1].kind, 'framework')
  assert.equal(typeof out[0].confidence, 'number')
  // 原对象没被动过 —— index-service 会反复对同一份快照做这件事
  assert.equal('kind' in realPlugin, false)
  assert.equal('kind' in framework, false)
  assert.equal(applyKinds(null).length, 0)
  assert.equal(applyKinds([]).length, 0)
})

test('excludeRepos：默认空名单 —— 降级不等于删除', () => {
  const pool = [realPlugin, framework]
  assert.equal(excludeRepos(pool, []).length, 2, '不配名单就一个都不删')
  assert.equal(excludeRepos(pool).length, 2)
  assert.equal(excludeRepos(pool, ['deepseek-ai/deepseek-harness']).length, 1)
  // 大小写与空白都要认，否则用户名单写起来很别扭
  assert.equal(excludeRepos(pool, [' DeepSeek-AI/Deepseek-Harness ']).length, 1)
  assert.equal(excludeRepos(null, ['x']).length, 0)
})

test('KIND_LABELS：四档都有标签，且 unknown 刻意留空', () => {
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), ['aggregator', 'framework', 'plugin', 'unknown'])
  for (const kind of ['framework', 'aggregator', 'plugin']) {
    assert.ok(KIND_LABELS[kind].zh, `${kind} 要有中文标签`)
    assert.ok(KIND_LABELS[kind].en, `${kind} 要有英文标签`)
  }
  // unknown 是「没有证据说明它是插件」，挂个「未知」标签只是噪音
  assert.equal(KIND_LABELS.unknown.zh, '')
  assert.equal(KIND_LABELS.unknown.en, '')
})

test('KNOWN_FRAMEWORKS 是冻结的默认名单，且不含任何真插件', () => {
  assert.ok(Object.isFrozen(KNOWN_FRAMEWORKS))
  assert.deepEqual([...KNOWN_FRAMEWORKS], ['deepseek-ai/deepseek-harness'])
})
