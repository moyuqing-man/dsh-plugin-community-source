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

/*
 * 岚叔目录的测试全部用**上游真实取值**，不是编的：
 *   screening.state   clear 61 / review 467 / pending 105 / blocked 22
 *   screening.risk    low / medium / high / unknown
 *   attention.level   clear 111 / review 512 / caution 32
 *   manifest.state    verified 600 / missing 49 / package-only 6
 *   installCommand    非空 131（全是 github:owner/repo#sha）/ 空 524
 *   manifest.packageName 有值 606
 * 详见 plugin/lib/core/sources/lanshu.js 里的注释。
 */

const lanshuEntry = (overrides = {}) => ({
  repo: 'someone/dsh-thing',
  description: '一个插件',
  stars: 12,
  ...overrides,
})

const lanshuBody = (entries) => JSON.stringify({ plugins: entries })

test('lanshu.parse：上游结论最好的一档（clear）绝不能被当成红线', () => {
  // 这是被修掉的真 bug：旧代码用白名单反推，白名单里既没有 blocked 也没有 clear，
  // 于是上游明确放行的 61 条反而被挂上「目录审核：clear」的红线 —— 判据是反的。
  const result = lanshu.parse(
    lanshuBody([
      lanshuEntry({
        repo: 'safe/dsh-fine',
        screening: { state: 'clear', risk: 'low', findings: [] },
        attention: { level: 'clear', reasons: [] },
      }),
    ]),
  )

  const card = result.cards[0]
  assert.equal(card.repo, 'safe/dsh-fine')
  assert.deepEqual(card.capabilityRedLines, [])
})

test('lanshu.parse：只有 blocked / high / caution 三条是坏消息，其余常态一律不报警', () => {
  const benign = lanshu.parse(
    lanshuBody([
      lanshuEntry({ repo: 'a/one', screening: { state: 'review', risk: 'medium' }, attention: { level: 'review' } }),
      lanshuEntry({ repo: 'b/two', screening: { state: 'pending', risk: 'unknown' }, attention: { level: 'clear' } }),
      lanshuEntry({ repo: 'c/three', screening: { state: 'clear', risk: 'low' }, attention: { level: 'clear' } }),
      lanshuEntry({ repo: 'd/four', screening: { state: 'review', risk: 'low' }, attention: { level: 'review' } }),
    ]),
  )
  for (const card of benign.cards) {
    assert.deepEqual(card.capabilityRedLines, [], `${card.repo} 不该有红线`)
  }
})

test('lanshu.parse：blocked 条目要把上游 findings 的中文说明列出来（而不是只报一个枚举名）', () => {
  const result = lanshu.parse(
    lanshuBody([
      lanshuEntry({
        repo: 'risky/dsh-101',
        screening: {
          state: 'blocked',
          risk: 'high',
          findings: [
            { id: 'dynamic-code', severity: 'high', label: { zh: '发现动态代码执行入口', en: 'Dynamic code execution' } },
            { id: 'destructive-filesystem', severity: 'high', label: { zh: '发现递归删除或直接删除文件的调用', en: 'Destructive filesystem calls' } },
            { id: 'lockfile-missing', severity: 'medium', label: { zh: '仓库根目录未发现依赖锁文件', en: 'No lockfile' } },
          ],
        },
        attention: { level: 'caution', reasons: ['发现动态代码执行入口'] },
      }),
    ]),
  )

  const card = result.cards[0]
  const joined = card.capabilityRedLines.join('\n')
  assert.match(joined, /目录审核未通过/)
  assert.match(joined, /发现动态代码执行入口/)
  assert.match(joined, /发现递归删除或直接删除文件的调用/)
  // medium 级在 655 条里出现 1181 次，是常态，不该混进红线把真正的警告淹掉
  assert.doesNotMatch(joined, /仓库根目录未发现依赖锁文件/)
  // attention=caution 带上理由
  assert.match(joined, /目录提醒/)
})

test('lanshu.parse：findings 的说明超过 4 项时截断并说明还有多少项', () => {
  const findings = Array.from({ length: 7 }, (_, i) => ({
    id: `f${i}`,
    severity: 'high',
    label: { zh: `问题${i}` },
  }))
  const result = lanshu.parse(lanshuBody([lanshuEntry({ screening: { state: 'blocked', risk: 'high', findings } })]))
  const line = result.cards[0].capabilityRedLines.find((l) => l.startsWith('目录审核未通过'))
  assert.match(line, /问题0/)
  assert.match(line, /问题3/)
  assert.doesNotMatch(line, /问题4/)
  assert.match(line, /等 7 项/)
})

test('lanshu.parse：只有 131/655 条有安装命令，npm 名要回退到 manifest.packageName', () => {
  // 现实：有 installCommand 的都是 github:owner/repo#sha，推不出 npm 名；
  // 另有 475 条只有 manifest.packageName。不回退就白白丢掉 475 条的 npm 名，
  // 而 ?pkg=（拿 npm 包名反查仓库）正是靠这个字段工作的。
  const result = lanshu.parse(
    lanshuBody([
      lanshuEntry({
        repo: 'Nagi-ovo/dsh-visualize',
        installCommand: 'dsh plugin --profile web add github:Nagi-ovo/dsh-visualize#9667c0e',
        manifest: { state: 'verified', packageName: '@nagi/dsh-visualize' },
      }),
      lanshuEntry({
        repo: 'lehhair/dsh-diff-viewer',
        installCommand: 'dsh plugin --profile web add github:lehhair/dsh-diff-viewer#d576c00',
        manifest: { state: 'verified', packageName: 'dsh-diff-viewer' },
      }),
    ]),
  )

  // github: 目标推不出 npm 名 → 回退到声明的 packageName
  assert.equal(result.cards[0].npm, '@nagi/dsh-visualize')
  assert.equal(result.cards[1].npm, 'dsh-diff-viewer')
  // 安装命令原样透传（上游审核过、可直接执行的那份），且以它为准
  assert.equal(result.cards[0].install, 'dsh plugin --profile web add github:Nagi-ovo/dsh-visualize#9667c0e')
})

test('lanshu.parse：安装命令能推出 npm 名时，以安装命令为准而不是 packageName', () => {
  const result = lanshu.parse(
    lanshuBody([
      lanshuEntry({
        repo: 'x/dsh-y',
        installCommand: 'dsh plugin add @scope/real-name',
        manifest: { state: 'verified', packageName: 'stale-declared-name' },
      }),
    ]),
  )
  assert.equal(result.cards[0].npm, '@scope/real-name')
})

test('lanshu.parse：维护状态、精选、档案缺失进「说明」，归档进红线', () => {
  const result = lanshu.parse(
    lanshuBody([
      lanshuEntry({
        repo: 'a/dsh-warm',
        maintenance: 'warm',
        curated: true,
        manifest: { state: 'verified', packageName: 'a-dsh-warm' },
        screening: { state: 'clear', risk: 'low' },
      }),
      lanshuEntry({ repo: 'b/dsh-gone', archived: true, screening: { state: 'clear', risk: 'low' } }),
      lanshuEntry({ repo: 'c/dsh-nomanifest', screening: { state: 'review', risk: 'medium' }, manifest: { state: 'missing', packageName: null } }),
    ]),
  )

  const warm = result.cards.find((c) => c.repo === 'a/dsh-warm')
  assert.ok(warm.capabilities.includes('维护状态：warm'))
  assert.ok(warm.capabilities.includes('目录精选'))

  assert.deepEqual(result.cards.find((c) => c.repo === 'b/dsh-gone').capabilityRedLines, ['仓库已归档'])

  const nomanifest = result.cards.find((c) => c.repo === 'c/dsh-nomanifest')
  // 没到 blocked 就不当警告，但要如实说：它可能根本不是插件
  assert.deepEqual(nomanifest.capabilityRedLines, [])
  assert.ok(nomanifest.capabilities.includes('上游未识别到 dsh manifest'))
})

test('lanshu.parse：坏 JSON 报错、没有 repo 的条目被跳过而不是变成空卡片', () => {
  assert.throws(() => lanshu.parse('nope'), /不是合法 JSON/)

  const result = lanshu.parse(lanshuBody([{ description: '没有仓库地址' }, null, 'nope', lanshuEntry({ repo: 'ok/dsh-one' })]))
  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].repo, 'ok/dsh-one')
  assert.equal(result.meta.count, 4)
  assert.equal(result.meta.skipped, 3)
})

/*
 * dsh.so 的测试用的是**上游注释登记的字段形状**，不是真实响应 ——
 * 这个源本机连不上（2026-10-13 与 10-14 两次实测都超时），拿不到真数据。
 * 所以这里只钉两件不依赖真实分布的事：坐标怎么取、风险会不会被说成「功能」。
 * 等哪天能联网取到真响应，应该像 lanshu 那样用真实分布再核一遍。
 */

test('dshSo.parse：仓库坐标从 install 命令取，不从 url 字段取（url 常是文档站）', () => {
  const result = dshSo.parse(
    JSON.stringify({
      plugins: [
        {
          install: 'dsh plugin --profile web add github:owner/dsh-real#v1.2.3',
          url: 'https://docs.example.com/plugin-homepage',
          description: 'a plugin',
          stars: 5,
        },
        {
          // 没有可解析的安装命令、url 也不是仓库 → 跳过，而不是编一个 slug 出来
          install: 'npm install -g',
          url: 'https://docs.example.com/another',
        },
      ],
    }),
  )

  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].repo, 'owner/dsh-real')
  assert.equal(result.meta.count, 2)
  assert.equal(result.meta.skipped, 1)
})

test('dshSo.parse：安全风险只能进红线，绝不能同时出现在「它能做什么」里', () => {
  // 被修掉的真 bug：riskNote 同时 push 进 capabilities 与 capabilityRedLines。
  // capabilities 在详情页的标题是「它能做什么」—— 把「严重风险」写在
  // 「它能做什么」底下，等于把警告伪装成功能说明。
  const result = dshSo.parse(
    JSON.stringify({
      plugins: [
        {
          install: 'dsh plugin add owner/dsh-risky',
          description: 'risky',
          security: { riskLevel: 'critical', status: 'flagged' },
          verification: { level: 'community' },
        },
        {
          install: 'dsh plugin add owner/dsh-safe',
          description: 'safe',
          security: { riskLevel: 'low', status: 'clean' },
          verification: { level: 'verified' },
        },
      ],
    }),
  )

  const risky = result.cards.find((c) => c.repo === 'owner/dsh-risky')
  const safe = result.cards.find((c) => c.repo === 'owner/dsh-safe')

  assert.deepEqual(risky.capabilityRedLines, ['dsh.so 安全扫描：严重风险'])
  assert.ok(!risky.capabilities.includes('dsh.so 安全扫描：严重风险'), '风险不该进「它能做什么」')
  assert.ok(risky.capabilities.includes('dsh.so 验证等级：community'))

  // 低风险不是红线，验证等级是正面信息
  assert.deepEqual(safe.capabilityRedLines, [])
  assert.ok(safe.capabilities.includes('dsh.so 验证等级：verified'))
})

test('dshSo.parse：critical 与 high 都要被认出来（只判 high 会让 critical 掉进 else 被当成安全）', () => {
  const parseRisk = (riskLevel) =>
    dshSo.parse(
      JSON.stringify({ plugins: [{ install: 'dsh plugin add o/r', security: { riskLevel } }] }),
    ).cards[0].capabilityRedLines

  assert.deepEqual(parseRisk('critical'), ['dsh.so 安全扫描：严重风险'])
  assert.deepEqual(parseRisk('high'), ['dsh.so 安全扫描：高风险'])
  assert.deepEqual(parseRisk('HIGH'), ['dsh.so 安全扫描：高风险'])
  assert.deepEqual(parseRisk('medium'), ['dsh.so 安全扫描：中风险'])
  assert.deepEqual(parseRisk('low'), [])
  assert.deepEqual(parseRisk(undefined), [])

  assert.throws(() => dshSo.parse('nope'), /不是合法 JSON/)
})

/*
 * dsh.works 的测试同样基于**上游登记的字段形状**（该端点本机两次实测都超时）。
 * 重点是把上游自己就在做的两条过滤，以及「unverified 要留下」这条刻意的相反决定钉住。
 */

test('dshWorks.parse：丢掉非插件类目与 broken，但 unverified 必须留下并标注', () => {
  const result = dshWorks.parse(
    JSON.stringify({
      plugins: [
        { name: 'dsh-base', category: 'bundle', status: 'ok', repo: 'deepseek-ai/dsh-base' },
        { name: 'a-theme', category: 'theme', status: 'ok', repo: 'o/a-theme' },
        { name: 'gone', category: 'plugin', status: 'broken', repo: 'o/gone' },
        // 保留：没人复核 ≠ 不是真插件，藏起来等于悄悄缩小生态
        { name: 'fresh', category: 'plugin', status: 'unverified', repo: 'o/fresh' },
        { name: 'fine', category: 'plugin', status: 'ok', repo: 'o/fine', official: true, verifiedAgainst: '1.21.0' },
      ],
    }),
  )

  assert.deepEqual(
    result.cards.map((c) => c.repo).sort(),
    ['o/fine', 'o/fresh'],
  )
  assert.equal(result.meta.count, 5)
  assert.equal(result.meta.skipped, 3)

  const fresh = result.cards.find((c) => c.repo === 'o/fresh')
  assert.ok(fresh.capabilities.includes('安装路径未复核'))

  const fine = result.cards.find((c) => c.repo === 'o/fine')
  assert.ok(fine.capabilities.includes('官方'))
  assert.ok(fine.capabilities.includes('对着 dsh 1.21.0 验证过'))
})

test('dshWorks.parse：只有 npm 名没有仓库的条目进不来（卡片以仓库为主键，点不开的条目没有用）', () => {
  const result = dshWorks.parse(
    JSON.stringify({
      plugins: [
        { name: 'no-repo', category: 'plugin', status: 'ok', npm: 'some-pkg' },
        { name: 'bad-repo', category: 'plugin', status: 'ok', repo: 'not-a-full-name' },
        { name: 'good', category: 'plugin', status: 'ok', repo: 'owner/dsh-good', npm: 'dsh-good' },
      ],
    }),
  )

  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].repo, 'owner/dsh-good')
  assert.equal(result.cards[0].npm, 'dsh-good')
  assert.throws(() => dshWorks.parse('nope'), /不是合法 JSON/)
})

test('loadAll：未知源被明确标出来，而不是静默忽略', async () => {
  const loader = createSourceLoader({ http: { request: async () => { throw new Error('x') } }, cache: createCache({}) })
  const result = await loader.loadAll(['不存在的源'], {})
  assert.equal(result.cards.length, 0)
  assert.equal(result.errors[0].reason, 'UNKNOWN_SOURCE')
})
