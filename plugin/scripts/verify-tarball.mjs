/**
 * 从**真实的 tgz** 里验证插件能不能被加载。
 *
 * 为什么需要这个脚本：`test/pack.test.mjs` 只证明「tar 里有没有这个文件」，
 * 它不证明「解出来的那棵目录树能被 import」。两者差别很大 ——
 * 一个大小写错误的 import、一个只在源目录里存在而没进 `files` 的文件，
 * 在仓库里跑测试永远发现不了，只有在**解包后的副本**上才会暴露。
 *
 * 所以这里做三件事：
 *   1. 用 node:zlib 解 gzip、手写 tar 头解析（零依赖，不引 tar 包）；
 *   2. 把包解到临时目录，**从解出来的副本** import host 半边；
 *   3. 用假 ctx 真的 apply 一次，检查路由与 Agent 工具是否注册。
 *
 * 用法：node scripts/verify-tarball.mjs [tgz 路径]
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const DEFAULT_TGZ = join(pluginRoot, 'dist', 'dsh-plugin-community-0.1.0.tgz')

/* ------------------------------- tar 解析 ------------------------------- */

/**
 * 解析 tar 缓冲区 → `[{ name, bytes }]`。
 *
 * tar 的格式很笨但很好读：每个文件前面有一个 512 字节的头，头的第 0..100 字节
 * 是以 NUL 结尾的文件名，第 124..136 是**八进制**的文件大小。数据紧跟在头后面，
 * 补齐到 512 的整数倍。连续两个全零块表示结束。
 *
 * 这里只处理普通文件与目录 —— npm 打出来的包不会有硬链接或设备节点。
 */
export function parseTar(buffer) {
  const entries = []
  let offset = 0

  const readString = (start, length) => {
    const slice = buffer.subarray(start, start + length)
    const end = slice.indexOf(0)
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
  }

  while (offset + 512 <= buffer.length) {
    const name = readString(offset, 100)
    if (name === '') break // 全零块 = 结束

    const sizeField = readString(offset + 124, 12).trim()
    const size = sizeField === '' ? 0 : parseInt(sizeField, 8)
    const typeFlag = buffer.subarray(offset + 156, offset + 157).toString('utf8')

    if (Number.isNaN(size)) {
      throw new Error(`tar 头里的 size 不是八进制：${JSON.stringify(sizeField)}（条目 ${name}）`)
    }

    const dataStart = offset + 512
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      entries.push({ name, bytes: buffer.subarray(dataStart, dataStart + size) })
    } else if (typeFlag === '5') {
      entries.push({ name, directory: true })
    }
    // 其它类型（符号链接、长文件名扩展）npm 不会产出，忽略即可

    offset = dataStart + Math.ceil(size / 512) * 512
  }

  return entries
}

/** 把 tar 条目写到磁盘；返回写了哪些文件。 */
export async function extractTar(entries, targetDir) {
  const written = []
  for (const entry of entries) {
    const safe = entry.name.replace(/\\/g, '/').replace(/^\.\//, '')
    if (safe === '' || safe.startsWith('/') || safe.split('/').includes('..')) {
      throw new Error(`拒绝写出可疑路径：${entry.name}`)
    }
    const full = join(targetDir, ...safe.split('/'))
    if (entry.directory) {
      await mkdir(full, { recursive: true })
      continue
    }
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, entry.bytes)
    written.push(safe)
  }
  return written
}

/* ------------------------------- 加载验证 ------------------------------- */

/**
 * 从解包目录加载 host 半边并 apply 一次。
 *
 * 这里**刻意**不用真实 DSH 运行时：项目的硬约束就是「不 import DSH 即可本地测试」。
 * `ctx` 只提供 host 半边真正会碰的东西：日志、`webServer.register`、`tools.register`、
 * `effect`、`get`。
 */
export async function loadHostHalf(pkgDir, overrides) {
  const registered = { routes: [], tools: [], effects: 0 }
  const logs = []
  const makeLogger = (level) => (...args) => logs.push({ level, text: args.join(' ') })

  const ctx = {
    logger: { debug: makeLogger('debug'), info: makeLogger('info'), warn: makeLogger('warn'), error: makeLogger('error') },
    get(name) {
      if (name === 'webServer') return ctx.webServer
      if (name === 'tools') return ctx.tools
      return undefined
    },
    effect(fn, label) {
      registered.effects++
      const disposer = fn()
      return () => disposer?.()
    },
    webServer: {
      register(route) {
        registered.routes.push(route)
      },
    },
    tools: {
      register(tool) {
        // 与真实 ctx.tools.register 的契约一致：给的是一个带 name 的普通对象
        if (!tool || typeof tool.name !== 'string') {
          throw new Error(`工具缺 name：${JSON.stringify(Object.keys(tool ?? {}))}`)
        }
        registered.tools.push(tool)
      },
    },
  }

  const modulePath = join(pkgDir, 'lib', 'index.js')
  const mod = await import(pathToFileURL(modulePath).href)

  // 注意：`Config` 是**默认值对象**（`export const Config = { owner, repo, ... }`），
  // 不是 Schemastery 的构造函数 —— `new mod.Config()` 会 TypeError。
  // host 半边真正接受的是「原始配置对象」，缺的键由内部 normalizeConfig 补默认。
  const result = await mod.apply(ctx, { ...(overrides ?? {}) })

  // 有 webServer 时 apply 会返回暴露面；没有时返回 undefined 也是合法的。
  return { mod, registered, logs, result, ctx }
}

/* -------------------------- cordis.patch.yml 校验 -------------------------- */

/**
 * 从 `cordis.patch.yml` 里抠出那段 config。
 *
 * 为什么值得单独查：这个文件是**安装时真正生效的那份配置** —— profile 根目录的
 * `cordis.yml` 只是 `[]`，插件的配置全靠这个 patch 插进层栈。它写错了，
 * 在仓库里跑任何测试都不会发现，只有装到 DSH 里才炸。
 *
 * 刻意**不引用 YAML 库**（本包零依赖，而且生产环境根本没有 yaml 包可用）。
 * 目标形状是固定的 `- insert: - id/name/config`，用缩进解析就够；
 * 这里的选择是：宁可因为不认识的结构而**显式报错**，也不要静默解析出半个配置
 * 让人以为查过了。
 */
export function parsePatchConfig(source) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
  if (start === -1) return { ok: false, reason: '文件里没有 config: 段' }

  const baseIndent = lines[start].match(/^\s*/)[0].length
  const entries = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s*#/.test(line)) {
      // 注释不影响缩进判断，但也不该中断 config 段 —— 直接收进来由调用方跳过
      entries.push(line)
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    // 缩进回到 config 同级或更浅，说明 config 段结束了
    if (indent <= baseIndent) break
    entries.push(line)
  }
  if (entries.length === 0) return { ok: false, reason: 'config: 下面是空的' }

  const config = {}
  const scalar = (raw) => {
    let value = raw.trim()
    // 行尾注释要剥掉（`false # 说明` → `false`）。引号里的 `#` 不算注释，
    // 所以先处理带引号的值：它们必须整体被引号包住才算。
    const quoted = value.match(/^'(.*)'$/) || value.match(/^"(.*)"$/)
    if (quoted) return quoted[1]
    value = value.replace(/\s+#.*$/, '').trim()
    if (value === 'true' || value === 'false') return value === 'true'
    if (/^-?\d+$/.test(value)) return Number(value)
    if (value.startsWith('[') && value.endsWith(']')) {
      return value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'))
        .filter((item) => item !== '')
    }
    return value
  }

  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]
    // 注释行必须跳过 —— 这个 patch 文件里注释比配置还多，
    // 而且注释里出现的冒号（比如「只需要改这两行。」）会被当成键。
    if (/^\s*#/.test(line)) continue

    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (!match) return { ok: false, reason: `读不懂这一行：${JSON.stringify(line.trim())}` }
    const [, key, rawValue] = match

    if (rawValue.trim() === '') {
      // 块序列：紧随其后的、缩进更深的 `- xxx` 行都属于这个键。
      // （这个文件里 sources / frameworks 就是这种写法，不是内联数组。）
      const keyIndent = line.match(/^\s*/)[0].length
      const items = []
      while (i + 1 < entries.length) {
        const next = entries[i + 1]
        if (/^\s*#/.test(next)) {
          i++
          continue
        }
        const nextIndent = next.match(/^\s*/)[0].length
        if (nextIndent <= keyIndent) break
        const item = next.match(/^\s*-\s*(.*)$/)
        if (!item) break
        items.push(scalar(item[1]))
        i++
      }
      config[key] = items
      continue
    }

    config[key] = scalar(rawValue)
  }
  return { ok: true, config }
}

/* --------------------------------- CLI --------------------------------- */

async function main() {
  const tgzPath = process.argv[2] ? process.argv[2] : DEFAULT_TGZ
  if (!existsSync(tgzPath)) {
    console.error(`[x] 找不到 tgz：${tgzPath}`)
    console.error('    先在 plugin/ 下跑一次：node <pnpm> pack --pack-destination dist')
    process.exit(1)
  }

  const raw = await readFile(tgzPath)
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
    console.error('[x] 这不是一个 gzip 文件（缺 1f 8b 魔数）')
    process.exit(1)
  }

  const entries = parseTar(gunzipSync(raw))
  const tempDir = await mkdtemp(join(tmpdir(), 'dcom-verify-'))
  const packageDir = join(tempDir, 'package')
  const problems = []

  try {
    // npm 打出来的 tar，每个条目都带 `package/` 前缀（这是约定，不是可选的）。
    // 所以解到 tempDir、而不是 packageDir —— 否则会在 tempDir/package/package/ 下多一层。
    const written = await extractTar(entries, tempDir)
    console.log(`解包 ${written.length} 个文件 → ${packageDir}`)

    // 1. package.json 必须能被解析，且是我们要的那个包
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    if (pkg.name !== 'dsh-plugin-community') problems.push(`包名不对：${pkg.name}`)
    if (!pkg.dsh?.bundle?.patch) problems.push('package.json 里没有 dsh.bundle.patch')
    if (!pkg.dsh?.client) problems.push('package.json 里没有 dsh.client')

    // 2. cordis.patch.yml 要在包里（它是 host 半边的入口声明）
    const patchPath = join(packageDir, 'cordis.patch.yml')
    if (!existsSync(patchPath)) {
      problems.push('包里没有 cordis.patch.yml')
    }

    // 2b. 用**安装时真正生效的那份配置**去 apply，而不是空对象 ——
    //     这才是 DSH 装载插件时走的路径（patch 会插进层栈）。
    let patchConfig = {}
    if (existsSync(patchPath)) {
      const parsed = parsePatchConfig(await readFile(patchPath, 'utf8'))
      if (!parsed.ok) {
        problems.push(`cordis.patch.yml 的 config 段解析失败：${parsed.reason}`)
      } else {
        patchConfig = parsed.config
        // 这里必须与 `lib/index.js` 的 `export const Config` 逐字对齐。
        // 少列一个键就会把**合法的配置**报成拼写错误 —— 那种假警报会训练人
        // 直接忽略这条检查，比不查更糟。所以下面每次给 Config 加键都要同步这里。
        const known = [
          'owner',
          'repo',
          'allowRemote',
          'cacheTtlMinutes',
          'sources',
          'userAgent',
          'prewarm',
          'frameworks',
          'excludeRepos',
          'clientId',
          'scope',
        ]
        for (const key of Object.keys(patchConfig)) {
          if (!known.includes(key)) {
            // 未知键不一定致命（normalizeConfig 会忽略），但几乎总是拼写错误
            problems.push(`cordis.patch.yml 里有未知配置键：${key}`)
          }
        }
        if (typeof patchConfig.owner !== 'string' || patchConfig.owner === '') {
          problems.push('cordis.patch.yml 的 owner 不是非空字符串')
        }
        if (typeof patchConfig.repo !== 'string' || patchConfig.repo === '') {
          problems.push('cordis.patch.yml 的 repo 不是非空字符串')
        }
        console.log(`cordis.patch.yml → owner=${patchConfig.owner} repo=${patchConfig.repo} sources=${JSON.stringify(patchConfig.sources)}`)
      }
    }

    // 3. 从**解出来的副本**真的 import + apply 一次（用 patch 里的真实配置）
    let loaded
    try {
      loaded = await loadHostHalf(packageDir, patchConfig)
    } catch (error) {
      problems.push(`从解包目录 import/apply 失败：${error && error.stack ? error.stack : error}`)
    }

    if (loaded) {
      const { mod, registered } = loaded

      if (typeof mod.apply !== 'function') problems.push('host 半边没有导出 apply')
      if (!Array.isArray(mod.inject)) problems.push('host 半边没有导出 inject 数组')

      // 路由：预期 4 条（两个前缀 + 两个 exact）
      const paths = registered.routes.map((route) => route.path).filter(Boolean)
      for (const expected of ['/community', '/api/v1/community']) {
        if (!paths.includes(expected)) problems.push(`没有注册路由：${expected}`)
      }
      if (registered.routes.length < 4) {
        problems.push(`路由只注册了 ${registered.routes.length} 条，预期至少 4 条`)
      }

      // Agent 工具：预期恰好 4 个，且名字必须是 community_*
      const toolNames = registered.tools.map((tool) => tool.name).sort()
      const expectedTools = ['community_plugin', 'community_post', 'community_search', 'community_triage']
      if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
        problems.push(`Agent 工具对不上：拿到 ${JSON.stringify(toolNames)}，预期 ${JSON.stringify(expectedTools)}`)
      }

      for (const tool of registered.tools) {
        if (typeof tool.execute !== 'function') problems.push(`工具 ${tool.name} 没有 execute`)
        if (!tool.parameters || typeof tool.parameters !== 'object') {
          problems.push(`工具 ${tool.name} 没有 parameters`)
        }
      }

      console.log(`注册路由 ${registered.routes.length} 条、Agent 工具 ${toolNames.length} 个（${toolNames.join(', ')}）`)
      console.log(`effect 回调 ${registered.effects} 个`)
    }

    // 4. client 半边在包里，且是 __ModuleLoader__ 形态（不能 import，它要 window）
    const clientPath = join(packageDir, 'lib', 'client.js')
    if (!existsSync(clientPath)) {
      problems.push('包里没有 lib/client.js（client 半边）')
    } else {
      const clientSource = await readFile(clientPath, 'utf8')
      if (!clientSource.includes('__ModuleLoader__')) {
        problems.push('lib/client.js 不是 __ModuleLoader__ bundle')
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  console.log('')
  if (problems.length > 0) {
    console.error(`[x] 解包验证发现 ${problems.length} 个问题：`)
    for (const problem of problems) console.error(`    - ${problem}`)
    process.exit(1)
  }
  console.log('[ok] 真实 tgz 解包后可以加载：路由与 Agent 工具都注册成功。')
}

// 只在作为 CLI 直接运行时才跑 main；被 import 时只导出函数（方便测试复用）。
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  await main()
}
