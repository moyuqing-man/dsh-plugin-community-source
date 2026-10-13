import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as awesome from '../lib/core/sources/awesome.js'
import * as radar from '../lib/core/sources/radar.js'
import * as githubTopic from '../lib/core/sources/githubTopic.js'
import * as dshSo from '../lib/core/sources/dshSo.js'
import * as dshWorks from '../lib/core/sources/dshWorks.js'
import * as lanshu from '../lib/core/sources/lanshu.js'
import { npmFromTarget, repoFromTarget, targetFromCommand } from '../lib/core/sources/install.js'
import { createSourceLoader, SOURCES, DEFAULT_SOURCES, sourceIds, describe } from '../lib/core/sources/index.js'
import { createCache } from '../lib/core/cache.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

test('awesome.parse：丢掉非 github 条目、补分类标签、保留元数据', () => {
  const result = awesome.parse(fixture('awesome.sample.json'))

  assert.equal(result.id, 'awesome')
  assert.equal(result.cards.length, 2)
  assert.equal(result.meta.skipped, 1)
  assert.equal(result.meta.updated, '2026-10-13T00:00:00Z')
  assert.equal(result.meta.homepage, 'https://awesome-dsh-plugin.com')

  const j = result.cards.find((c) => c.repo === 'AnonyJcy/dsh-j-space')
  assert.equal(j.slug, 'anonyjcy/dsh-j-space')
  assert.equal(j.category, 'ui')
  assert.deepEqual(j.categoryLabel, { en: 'UI', zh: '界面' })
  assert.deepEqual(j.description, { en: 'A panel plugin', zh: '一个面板插件' })
  assert.equal(j.npm, '@anonyjcy/dsh-j-space')
  assert.equal(j.stars, 4)
  assert.equal(j.downloads, 1982)
  assert.equal(j.install, 'dsh plugin --profile web add @anonyjcy/dsh-j-space')
  assert.deepEqual(j.sources, ['awesome'])

  const x = result.cards.find((c) => c.repo === 'Someone/dsh-x')
  assert.deepEqual(x.categoryLabel, { en: 'Tools', zh: '工具' })
})

test('awesome.parse 对坏 JSON 报错而不是崩', () => {
  assert.throws(() => awesome.parse('<html>not json</html>'), /不是合法 JSON/)
})

const RADAR_MD = `# DSH Plugin Radar

> 自动生成

## 🔌 单插件

| 插件 | 仓库 | 说明 | 运行级 |
|---|---|---|---|
| dsh-xiaomi-tts | [ppy-web/dsh-plugin-xiaomi-mimo-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) | 小米音箱 TTS | agent |
| dsh-foo | [foo/bar](https://github.com/foo/bar) | 测试 [链接](https://example.com) 描述 | |

## 🧰 插件集

| 插件 | 仓库 | 说明 | 运行级 |
|---|---|---|---|
| dsh-pack | [someone/pack](https://github.com/someone/pack) | 一整套 | server |
`

test('radar.parse：跳过表头与分隔行，按分节归类别，清掉内嵌 markdown 链接', () => {
  const result = radar.parse(RADAR_MD)

  assert.equal(result.cards.length, 3)
  const tts = result.cards.find((c) => c.repo === 'ppy-web/dsh-plugin-xiaomi-mimo-tts')
  assert.equal(tts.name, 'dsh-xiaomi-tts')
  assert.equal(tts.description.zh, '小米音箱 TTS')
  assert.equal(tts.categorySlug, '单插件')
  assert.deepEqual(tts.sources, ['radar'])

  const foo = result.cards.find((c) => c.repo === 'foo/bar')
  assert.equal(foo.name, 'dsh-foo')
  assert.equal(foo.description.zh, '测试 链接 描述')

  const pack = result.cards.find((c) => c.repo === 'someone/pack')
  assert.equal(pack.categorySlug, '插件集')

  assert.deepEqual(result.meta.categories, [
    { name: '单插件', count: 2 },
    { name: '插件集', count: 1 },
  ])
})

test('radar.parse 对空输入返回空结果而不是抛错', () => {
  const result = radar.parse('')
  assert.deepEqual(result.cards, [])
  assert.equal(result.meta.count, 0)
})

test('githubTopic.parse：映射搜索结果的字段', () => {
  const body = JSON.stringify({
    total_count: 137,
    incomplete_results: false,
    items: [
      {
        full_name: 'bradeGithub/DSH-Plugins-Marketplace',
        description: 'marketplace',
        stargazers_count: 175,
        open_issues_count: 12,
        pushed_at: '2026-10-12T00:00:00Z',
        archived: false,
        license: { spdx_id: 'MIT' },
        topics: ['dsh-plugin', 'marketplace'],
      },
      { full_name: 'not-a-repo' },
    ],
  })
  const result = githubTopic.parse(body)

  assert.equal(result.meta.totalCount, 137)
  assert.equal(result.meta.incomplete, false)
  assert.equal(result.cards.length, 1)

  const card = result.cards[0]
  assert.equal(card.slug, 'bradegithub/dsh-plugins-marketplace')
  assert.equal(card.stars, 175)
  assert.equal(card.openIssues, 12)
  assert.equal(card.license, 'MIT')
  assert.equal(card.archived, false)
  assert.deepEqual(card.sources, ['github-topic'])
})

test('githubTopic.parse 对坏 JSON 报错', () => {
  assert.throws(() => githubTopic.parse('nope'), /不是合法 JSON/)
})

test('源注册表：id 与默认集', () => {
  assert.deepEqual(sourceIds().sort(), ['awesome', 'dsh-so', 'dsh-works', 'github-topic', 'lanshu', 'radar'])
  // 默认集**故意只有两个**：本机确实跑得通且够快的那两个。
  // 其余四个是可选项 —— 有体积 19.7 MB 的，也有本机网络下超时的。
  assert.deepEqual([...DEFAULT_SOURCES], ['github-topic', 'awesome'])
  assert.equal(SOURCES.radar.ttlMs, 6 * 3600_000)
  assert.equal(SOURCES['github-topic'].ttlMs, 30 * 60_000)
})

test('describe：把「默认源」和「可选源」区分开，并报出各自的超时预算', () => {
  assert.equal(describe('awesome').default, true)
  assert.equal(describe('awesome').optIn, false)

  // dsh.so 信息最全（验证等级 + 安全扫描）但 19.7 MB，必须显式开
  const dshso = describe('dsh-so')
  assert.equal(dshso.optIn, true)
  assert.equal(dshso.default, false)
  assert.equal(dshso.timeoutMs, 90_000)
  assert.equal(dshso.url, 'https://www.dsh.so/plugins-index.json')

  assert.equal(describe('lanshu').label, '岚叔目录')
  assert.equal(describe('dsh-works').url, 'https://dsh.works/awesome-dsh-plugins/plugins.json')
  assert.equal(describe('根本没这个源'), null)
})

test('loadAll：一个源失败不拖垮另一个源，失败只体现在 errors 里', async () => {
  const cache = createCache({})
  const http = {
    request: async (url) => {
      if (String(url).includes('search/repositories')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [{ full_name: 'a/b', stargazers_count: 1, topics: [] }],
          }),
        }
      }
      throw new Error('这个源挂掉了')
    },
  }

  const loader = createSourceLoader({ http, cache, logger: { debug() {} } })
  const result = await loader.loadAll(['github-topic', 'awesome'], {})

  assert.equal(result.cards.length, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].id, 'awesome')
  assert.equal(result.stale, false)

  // 不带 cards 出去：4600 张卡片不该出现在任何响应体里
  const awesomeReport = result.sources.find((s) => s.id === 'awesome')
  assert.equal('cards' in awesomeReport, false)
  assert.equal(awesomeReport.error.reason, 'UPSTREAM_FAILED')
})

test('loadAll：未知源被明确标出来，而不是静默忽略', async () => {
  const loader = createSourceLoader({ http: { request: async () => { throw new Error('x') } }, cache: createCache({}) })
  const result = await loader.loadAll(['不存在的源'], {})
  assert.equal(result.cards.length, 0)
  assert.equal(result.errors[0].reason, 'UNKNOWN_SOURCE')
})
