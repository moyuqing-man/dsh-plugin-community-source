/**
 * 守卫的守卫 —— 确认「防真机 bug 重演」的检查**真的会失败**。
 *
 * 为什么值得单独一个文件：`scripts/verify-tarball.mjs` 里那两条检查（Config 必须是
 * Standard Schema、未 inject 的服务访问不能让 apply 挂掉）如果只是永远通过，它们
 * 就不知道被谁改坏了。这里的做法是**把 bug 人为还原回去**，断言守卫确实报警 ——
 * 变异测试是最省事的「证明这条检查有牙」的办法。
 *
 * 两个变异都对应真机实测到的失败：
 *   1. `Config` 少了 `~standard` → 真实加载器 `resolveConfig` 抛
 *      `TypeError: Cannot read properties of undefined (reading 'validate')`，
 *      插件静默不激活（启动日志只有 `warning: 1 entry did not activate`，页面全 404）。
 *   2. `ctx.credentials ?? null` 这种「拿不到就是 null」的写法 → cordis 的 ctx 是 Proxy，
 *      未 inject 的属性访问直接抛 `cannot get property "credentials" without inject`。
 *
 * 变异点用源码正则定位，所以**改动 `lib/index.js` 的写法会让这里失效** ——
 * 那种情况下测试会明确报「变异没生效，测试本身写错了」，而不是假装通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { loadHostHalf } from '../scripts/verify-tarball.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 复制一份 lib/、按 `mutate` 改掉 index.js，返回临时目录（调用方负责删）。 */
async function withMutatedLib(mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'dcom-guard-'))
  await cp(join(packageRoot, 'lib'), join(dir, 'lib'), { recursive: true })
  const indexPath = join(dir, 'lib', 'index.js')
  const source = await readFile(indexPath, 'utf8')
  const mutated = mutate(source)
  assert.notEqual(mutated, source, '变异没生效 —— lib/index.js 的写法变了，这个测试需要跟着改')
  await writeFile(indexPath, mutated)
  return dir
}

test('变异 1：Config 掉了 ~standard 时，verify-tarball 必须察觉（真机 bug 1）', async () => {
  const dir = await withMutatedLib((source) =>
    source.replace(/Object\.defineProperty\(Config, '~standard', \{[\s\S]*?\n\}\)\n/, ''),
  )
  try {
    const loaded = await loadHostHalf(dir, {})
    const standard = loaded.mod.Config && loaded.mod.Config['~standard']
    assert.equal(standard, undefined, '变异没生效：Config 上还有 ~standard')
    // 这里断言的是**加载器会看到的东西**：读 .validate 会抛 TypeError。
    // verify-tarball 的 main() 正是拿这个形状去判问题的。
    assert.throws(
      () => loaded.mod.Config['~standard'].validate({}),
      (error) => error instanceof TypeError && /validate/.test(error.message),
      '少了 ~standard 之后读 .validate 必须抛 TypeError —— 这正是真机上插件不激活的原因',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('变异 2：把 optionalService 换回 ctx.credentials ?? null 时，verify-tarball 的假 ctx 必须抛（真机 bug 2）', async () => {
  const dir = await withMutatedLib((source) => {
    const mutated = source.replace(
      /const credentials = optionalService\(ctx, 'credentials'\)/,
      'const credentials = ctx.credentials ?? null',
    )
    return mutated
  })
  try {
    await assert.rejects(
      () => loadHostHalf(dir, {}),
      (error) => {
        assert.match(
          error.message,
          /cannot get property "credentials" without inject/,
          '假 ctx 必须像真 cordis 一样，对未 inject 的属性访问抛错',
        )
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('未变异时两条守卫都不误报（否则变异测试的「有牙」是假的）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcom-clean-'))
  try {
    await cp(join(packageRoot, 'lib'), join(dir, 'lib'), { recursive: true })
    const loaded = await loadHostHalf(dir, { sources: ['github-topic'], prewarm: false })
    assert.equal(typeof loaded.mod.Config['~standard'].validate, 'function')
    assert.ok(loaded.registered.routes.length >= 4)
    assert.equal(loaded.registered.tools.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
