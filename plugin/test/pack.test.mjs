// 发布前自检的测试：让 `node --test` 顺带守住打包边界。
//
// 为什么值得单独写：`node scripts/pack-check.mjs` 只有人记得跑的时候才会跑。
// 而「包发出去能不能用」这件事，一旦有人往 lib/ 里加一句越出包外的 import，
// 或者把凭据文件拖进 files，就必须在本地立刻红掉。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

import { checkPublish } from '../scripts/pack-check.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const report = await checkPublish(packageRoot)

test('发布自检没有拦住任何东西', () => {
  assert.deepEqual(report.problems, [], `发布自检不通过：\n${report.problems.join('\n')}`)
})

test('entry point 在打包文件集里', () => {
  const paths = report.files.map((file) => file.path)
  assert.ok(paths.includes('lib/index.js'), 'main 指向的 lib/index.js 必须进包')
  assert.ok(paths.includes('package.json'), 'package.json 必须进包')
  assert.ok(paths.includes('LICENSE'), 'LICENSE 必须进包')
})

test('包体是纯 JS，没有二进制或原生依赖混进来', () => {
  const allowed = /\.(js|mjs|cjs|json|md|yml|yaml|txt)$/i
  const extensionless = /^(LICENSE|LICENCE|CHANGELOG)$/
  for (const file of report.files) {
    assert.ok(
      allowed.test(file.path) || extensionless.test(file.path),
      `${file.path} 不是文本/JS 文件 —— 这个项目承诺零原生依赖`,
    )
  }
})

test('测试和 node_modules 不会被打包', () => {
  for (const file of report.files) {
    assert.ok(!/\.test\.mjs$/.test(file.path), `${file.path} 不该被发布`)
    assert.ok(!file.path.startsWith('node_modules/'), `${file.path} 不该被发布`)
    assert.ok(!file.path.startsWith('test/'), `${file.path} 不该被发布`)
  }
})

test('打包体积没有失控', () => {
  // 目前约 244 KB。留一倍余量，涨到 500 KB 以上说明有人塞了不该塞的东西。
  assert.ok(report.totalBytes < 512 * 1024, `包体 ${(report.totalBytes / 1024).toFixed(1)} KB，超出预期`)
})

test('清单里每个文件都真的存在于磁盘', async () => {
  for (const file of report.files) {
    const info = await stat(join(packageRoot, file.path))
    assert.ok(info.isFile(), `${file.path} 在清单里但磁盘上不是文件`)
    assert.equal(info.size, file.size, `${file.path} 的大小和上报的不一致`)
  }
})

test('清单必备字段齐全且零运行时依赖', () => {
  const pkg = report.pkg
  assert.equal(pkg.name, 'dsh-plugin-community')
  assert.equal(pkg.publishConfig.access, 'public')
  assert.ok(!pkg.dependencies, '这是本项目的红线：零运行时依赖')
  assert.ok(!pkg.peerDependencies, '这是本项目的红线：零 peer 依赖')
  assert.ok(!pkg.private, 'private: true 会发不出去')
})

test('repository 指向源码仓库，并且说明了包在子目录里', () => {
  const repo = report.pkg.repository
  assert.ok(repo, '没有 repository，npm 页面上就没有「源码」入口')
  assert.equal(repo.type, 'git')
  assert.match(repo.url, /^git\+https:\/\/github\.com\/moyuqing-man\/dsh-plugin-community-source\.git$/)
  // 包在 plugin/ 子目录里，少了这个 npm 会链到仓库根、找不到 package.json
  assert.equal(repo.directory, 'plugin')
  assert.match(report.pkg.homepage, /^https:\/\/github\.com\/moyuqing-man\/dsh-plugin-community-source/)
  assert.match(report.pkg.bugs.url, /^https:\/\/github\.com\/moyuqing-man\/dsh-plugin-community-source\/issues$/)
})

test('设计文档不会被打包 —— 它们是给人看的，不是给 npm 的', () => {
  // docs/ 与 plugin/ 在同一个仓库里（源码仓库），一旦有人图省事把它加进
  // package.json 的 files，几百 KB 的中文方案文档就跟着包发到 npm 了。
  for (const file of report.files) {
    assert.ok(!file.path.startsWith('docs/'), `${file.path} 不该被发布`)
    assert.ok(!file.path.startsWith('scripts/'), `${file.path} 不该被发布`)
    assert.ok(!/^PUBLISHING\.md$/.test(file.path), `${file.path} 不该被发布`)
  }
})
