// 解包验证脚本的测试。
//
// 为什么值得单独写：`scripts/verify-tarball.mjs` 是**发布前最后一道检查**，
// 它自己要是不对，就会给出「验证通过」这种最危险的结论 —— 人以为查过了。
//
// 这里刻意**不依赖真实 tgz**（那需要先跑 `pnpm pack`，本机 npm registry 不通）。
// 分两层测：
//   1. `parsePatchConfig` 纯函数 —— 拿仓库里**真实的** cordis.patch.yml 当输入，
//      因为那份文件是安装时真正生效的配置，解析错了等于没查。
//   2. `loadHostHalf` —— 直接对**当前工作区**跑一次 import + apply，
//      证明「解出来的那棵树能被加载」这个断言的实现本身是对的。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadHostHalf, parsePatchConfig } from '../scripts/verify-tarball.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(packageRoot, 'cordis.patch.yml')

/* ----------------------------- parsePatchConfig ----------------------------- */

test('真实 cordis.patch.yml 能解析出 owner/repo，且不把注释当成键', async () => {
  const source = await readFile(patchPath, 'utf8')
  const parsed = parsePatchConfig(source)
  assert.equal(parsed.ok, true, `解析失败：${parsed.reason}`)
  assert.equal(parsed.config.owner, 'moyuqing-man')
  assert.equal(parsed.config.repo, 'dsh-plugin-community')
  // 注释里出现过「只需要改这两行。」这种带标点的句子 —— 它绝不能被当成配置键
  assert.ok(!('社区 Discussions 所在的仓库' in parsed.config))
})

test('块序列（sources / frameworks）解析成数组，而不是字符串或 undefined', async () => {
  const parsed = parsePatchConfig(await readFile(patchPath, 'utf8'))
  assert.deepEqual(parsed.config.sources, ['github-topic', 'awesome'])
  assert.deepEqual(parsed.config.frameworks, ['deepseek-ai/deepseek-harness'])
  assert.deepEqual(parsed.config.excludeRepos, [])
})

test('布尔与数字解出真类型，否则会被当成非空字符串骗过校验', async () => {
  const parsed = parsePatchConfig(await readFile(patchPath, 'utf8'))
  // `allowRemote: false` 若解成字符串 'false'，`if (!allowRemote)` 会是 false，
  // 远程访问就被静默打开了 —— 这是安全相关的类型
  assert.equal(parsed.config.allowRemote, false)
  assert.equal(parsed.config.cacheTtlMinutes, 60)
  assert.equal(typeof parsed.config.cacheTtlMinutes, 'number')
  // 空的 clientId 要解成空串（登录关闭），不是 undefined
  assert.equal(parsed.config.clientId, '')
})

test('解析出来的键必须与 lib/index.js 的 Config 对得上（少列键会假报警）', async () => {
  const parsed = parsePatchConfig(await readFile(patchPath, 'utf8'))
  const { mod } = await loadHostHalf(packageRoot, {})
  const declared = Object.keys(mod.Config)
  for (const key of Object.keys(parsed.config)) {
    assert.ok(
      declared.includes(key),
      `cordis.patch.yml 里的 ${key} 不在 Config 的键里（${declared.join(', ')}）——` +
        'verify-tarball.mjs 的 known 列表和 lib/index.js 的 Config 已经漂移了',
    )
  }
})

test('解析器对不认识的结构显式失败，而不是静默返回半个配置', () => {
  assert.equal(parsePatchConfig('### 没有 config 段 ###').ok, false)
  assert.equal(parsePatchConfig('config:\n').ok, false)
  const messy = parsePatchConfig('config:\n  这不是一个键值对\n')
  assert.equal(messy.ok, false)
  assert.match(messy.reason, /读不懂/)
})

test('行尾注释会被剥掉（`false # 说明` 要解成布尔 false）', () => {
  const parsed = parsePatchConfig('config:\n  allowRemote: false # 只有本机能访问\n')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.allowRemote, false)
})

/* ------------------------------ loadHostHalf ------------------------------ */

test('从工作区能 import + apply，并且注册出 4 条路由与 4 个 Agent 工具', async () => {
  const { registered, mod } = await loadHostHalf(packageRoot, {})
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('webServer'))

  const paths = registered.routes.map((route) => route.path)
  assert.ok(paths.includes('/community'), `路由里没有 /community：${paths.join(', ')}`)
  assert.ok(paths.includes('/api/v1/community'))

  const names = registered.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['community_plugin', 'community_post', 'community_search', 'community_triage'])
})

test('apply 接受「原始配置对象」而不是 Config 的实例（Config 是默认值对象不是类）', async () => {
  // 曾经的写法是 `new mod.Config()` —— Config 是普通对象，那样会 TypeError。
  // 这条测试守住「patch config 直接传进去也成立」，也就是 DSH 装载时走的路径。
  const parsed = parsePatchConfig(await readFile(patchPath, 'utf8'))
  const { registered, result } = await loadHostHalf(packageRoot, parsed.config)
  assert.equal(registered.routes.length >= 4, true)
  assert.ok(result, '有 webServer 时 apply 应当返回暴露面')
  assert.equal(result.toolDefinitions.length, 4)
})

test('未知配置键不会让 apply 抛错（装机时不该因为多写一个键就整插件不加载）', async () => {
  const { registered } = await loadHostHalf(packageRoot, { 这个键不存在: 1, owner: 'someone' })
  assert.equal(registered.routes.length >= 4, true)
})
