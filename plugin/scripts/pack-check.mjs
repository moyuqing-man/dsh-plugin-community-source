/**
 * 发布前自检：把 `npm pack` 会打进包里的文件算出来，然后证明它自洽。
 *
 * 为什么要有这个脚本：本机 npm registry 不可达，跑不了 `npm pack` / `npm publish`。
 * 但「发布出去能不能用」这件事不该等到有网络时才发现——尤其是本项目的工作区里
 * 还躺着 `m0/`、`poc/`、`docs/` 这些兄弟目录，`lib/` 里只要有人写一句
 * `import ... from '../../m0/xxx.js'`，本地测试全绿、发到 npm 上直接炸。
 *
 * 所以这里用 Node 自己重算一遍 npm 的打包规则（`files` + 永远包含的那几个文件），
 * 再沿着相对 import 图走一遍，确认每个被 import 的文件都在包里。
 *
 * 它证明不了的：真实 npm 的 glob 细节、`.npmignore` 交互、registry 端校验。
 * 那些只能等有网络时用 `npm pack --dry-run` 复核。
 */

import { readFile, stat } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** npm 无论 `files` 怎么写都会带上的东西。 */
const ALWAYS_INCLUDED = [
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'LICENCE',
  'CHANGELOG.md',
  'CHANGELOG',
  'npm-shrinkwrap.json',
]

/** 永远不进包的东西。 */
const NEVER_INCLUDED = [/^node_modules\//, /^\.git\//, /^\.github\//, /\.orig$/, /\.bak$/]

/** 把 `files` 里的 glob 转成正则。只支持 npm 文档里常见的 *, **, ?。 */
function globToRegExp(pattern) {
  const normalized = pattern.split(sep).join('/').replace(/\/+$/, '')
  let out = '^'
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1
        // `**/` 匹配零层或多层目录
        if (normalized[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}(?:/.*)?$`)
}

function listFiles(root, dir = root, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      listFiles(root, full, acc)
    } else if (entry.isFile()) {
      acc.push(relative(root, full).split(sep).join('/'))
    }
  }
  return acc
}

/** 从一段 JS 源码里抠出相对 import/require 的目标。 */
function relativeImports(source) {
  const found = new Set()
  const patterns = [
    /(?:^|[\s;{}()])import\s+[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|[\s;{}()])import\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{}()])export\s+[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/**
 * @param {string} root 包根目录
 * @returns {Promise<{problems: string[], notes: string[], files: {path: string, size: number}[], totalBytes: number}>}
 */
export async function checkPublish(root = dirname(fileURLToPath(import.meta.url)) + sep + '..') {
  root = resolve(root)
  const problems = []
  const notes = []

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

  /* ---------------------------- 1. 清单必备字段 ---------------------------- */
  for (const field of ['name', 'version', 'license', 'main', 'exports', 'publishConfig']) {
    if (!pkg[field]) problems.push(`package.json 缺 ${field}`)
  }
  if (pkg.private === true) problems.push('package.json 里 private: true —— 发不出去')
  if (pkg.publishConfig && pkg.publishConfig.access !== 'public') {
    problems.push(`publishConfig.access 是 ${JSON.stringify(pkg.publishConfig.access)}，应该是 'public'`)
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    problems.push('package.json 没有 files 字段 —— 那会把整个工作区发出去')
  }
  if (!pkg.engines || !pkg.engines.node) notes.push('没有声明 engines.node')
  if (!pkg.repository) {
    notes.push('没有 repository 字段（npm 页面上看不到源码入口）—— 源码托管到哪里只有作者能定，见 PUBLISHING.md')
  }

  /* ----------------------------- 2. 零运行时依赖 ----------------------------- */
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = pkg[field]
    if (value && Object.keys(value).length > 0) {
      problems.push(`${field} 不是空的：${JSON.stringify(value)}—— 这是本项目的红线`)
    }
  }

  /* ------------------------------ 3. 打包文件集 ------------------------------ */
  const all = listFiles(root)
  const matchers = (pkg.files ?? []).map(globToRegExp)
  const included = new Set()
  for (const file of all) {
    if (NEVER_INCLUDED.some((pattern) => pattern.test(file))) continue
    if (ALWAYS_INCLUDED.includes(file)) {
      included.add(file)
      continue
    }
    if (matchers.some((matcher) => matcher.test(file))) included.add(file)
  }
  // npm 保证 main 指向的文件一定在包里
  if (pkg.main) included.add(pkg.main.replace(/^\.\//, ''))

  for (const file of included) {
    if (!all.includes(file)) problems.push(`清单里有 ${file}，但磁盘上不存在`)
  }

  const exported = []
  if (typeof pkg.main === 'string') exported.push(pkg.main)
  const walkExports = (value) => {
    if (typeof value === 'string') exported.push(value)
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) walkExports(inner)
  }
  walkExports(pkg.exports)
  if (pkg.dsh?.bundle?.patch) exported.push(pkg.dsh.bundle.patch)
  if (pkg.dsh?.client?.publish) exported.push(pkg.dsh.client.publish)

  for (const target of exported) {
    const rel = String(target).replace(/^\.\//, '')
    if (!included.has(rel)) {
      problems.push(`${target} 被 main/exports/dsh 指向，但它不在打包文件集里 —— 装包的人会 404`)
    }
  }

  /* --------------------- 4. 顺着相对 import 图走一遍（关键） --------------------- */
  const queue = exported.map((target) => String(target).replace(/^\.\//, '')).filter((f) => f.endsWith('.js'))
  const seen = new Set()
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (!included.has(file)) {
      problems.push(`${file} 被 import 到了，但它不在打包文件集里`)
      continue
    }
    const source = await readFile(join(root, file), 'utf8')
    for (const spec of relativeImports(source)) {
      const target = resolve(dirname(join(root, file)), spec)
      let rel = relative(root, target).split(sep).join('/')
      if (!rel || rel.startsWith('..')) {
        problems.push(`${file} import 了包外的 ${spec} —— 本地能跑，装包的人跑不了`)
        continue
      }
      try {
        if (statSync(target).isFile()) {
          // 已经带扩展名
        } else {
          rel += '.js'
        }
      } catch {
        rel += '.js'
      }
      queue.push(rel)
    }
  }
  notes.push(`从入口沿相对 import 走到 ${seen.size} 个文件，全部在打包文件集内`)

  /* --------------------------- 5. 不该发出去的东西 --------------------------- */
  for (const file of included) {
    if (/\.test\.mjs$/.test(file)) problems.push(`${file} 混进包里了（测试不该发布）`)
    if (/^scripts\//.test(file)) notes.push(`${file} 会被发布（如果那不是有意的，把它从 files 里去掉）`)
    // 凭据判据只对「数据文件」生效。`lib/core/credentials.js` 是 token store 源码，
    // 按文件名含 credential 就拦下来，只会训练人去忽略这条告警。
    if (/\.(js|mjs|cjs|json|md|ts)$/i.test(file)) continue
    if (/(^|\/)(\.env|\.npmrc|id_rsa|id_ed25519)/i.test(file) || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(file) || /credential/i.test(file)) {
      problems.push(`${file} 看起来是凭据文件，绝不能进包`)
    }
  }

  /* -------------------------------- 6. 体积 -------------------------------- */
  const files = []
  let totalBytes = 0
  for (const file of [...included].sort()) {
    const info = await stat(join(root, file))
    files.push({ path: file, size: info.size })
    totalBytes += info.size
  }

  return { problems, notes, files, totalBytes, pkg }
}

/* --------------------------------- CLI --------------------------------- */

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const root = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url)) + sep + '..'
  const { problems, notes, files, totalBytes, pkg } = await checkPublish(root)

  console.log(`包名：${pkg.name}@${pkg.version}`)
  console.log(`会发布 ${files.length} 个文件，合计 ${(totalBytes / 1024).toFixed(1)} KB\n`)
  for (const file of files) {
    console.log(`  ${String(file.size).padStart(8)}  ${file.path}`)
  }
  console.log()
  for (const note of notes) console.log(`  · ${note}`)

  if (problems.length > 0) {
    console.log('\n❌ 发布前自检不通过：')
    for (const problem of problems) console.log(`  - ${problem}`)
    process.exit(1)
  }
  console.log('\n✅ 发布前自检通过（注意：本脚本复算 npm 的打包规则，不能替代有网络时的 npm pack --dry-run）')
}
