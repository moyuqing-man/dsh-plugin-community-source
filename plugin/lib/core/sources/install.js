/**
 * 安装目标解析 —— 三个「一条命令概括一切」的目录（dsh.so / dsh.works / 岚叔）
 * 都只给一个安装命令，仓库坐标藏在命令里。
 *
 * 为什么单独一个文件：这段逻辑有三个源的共同陷阱，**同一处写错会同时污染三个源**，
 * 所以它必须被独立测试（见 test/sources.test.mjs）。
 *
 * 陷阱清单：
 * 1. `dsh plugin --profile web add @scope/name` —— 目标是**命令行最后一个非选项 token**，
 *    不是第二个 token。
 * 2. `@scope/name` 与 `owner/name` 长得一样但含义相反（npm 包 vs GitHub 仓库）。
 *    判据：以 `@` 开头的一定是 npm 包名。
 * 3. 裸名字（`dsh-find-plugins`）没有斜杠，是 npm 包名，**不是**仓库。
 */

import { parseRepo } from '../text.js'

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** 安装命令里最后一个不是选项的 token。 */
export function targetFromCommand(command) {
  const text = str(command)
  if (!text) return ''
  const tokens = text.split(/\s+/).filter(Boolean)
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token.startsWith('-')) continue
    // 走到动词说明前面没有目标了（例：`dsh plugin install`）
    if (/^(add|install|i|use)$/i.test(token)) return ''
    return token
  }
  return ''
}

/** 目标是 npm 包名时返回它，否则返回空串。 */
export function npmFromTarget(target) {
  const text = str(target)
  if (!text) return ''
  if (text.startsWith('@')) return text
  if (text.includes('/')) return '' // 有斜杠且不带 @ → 是 owner/repo
  // 裸名字：npm 包名不允许大写字母，用这一点把 `V1ki` 这类裸仓库名挡掉
  return /^[a-z0-9][a-z0-9._-]*$/.test(text) ? text : ''
}

/** 目标是 GitHub 仓库时返回 `owner/name`，否则返回空串。 */
export function repoFromTarget(target) {
  const text = str(target)
  if (!text || text.startsWith('@')) return ''
  const cleaned = text.replace(/^git\+/, '').replace(/^github:/, '')
  // 没有斜杠的不可能是 owner/repo。这一步不能省：parseRepo 会把裸字符串
  // 当成别的东西去猜，猜出来的结果不能信。
  if (!cleaned.includes('/')) return ''
  return parseRepo(text) ?? ''
}
