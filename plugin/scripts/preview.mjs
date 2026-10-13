/**
 * 本地预览服务器 —— 让你不用把插件装进 DSH 就能先看一眼页面长什么样。
 *
 *   node scripts/preview.mjs
 *   浏览器打开 http://127.0.0.1:3221/community
 *
 * 环境变量：
 *   PORT=3221           监听端口
 *   ALLOW_REMOTE=1      允许非本机访问（想在手机上试就开这个）
 *   SOURCES=a,b         覆盖索引源，例如 SOURCES=awesome
 *
 * 这个文件不参与 npm 包发布（files 里只收 lib / cordis.patch.yml / README / LICENSE），
 * 它纯粹是开发期的手电筒：用假 ctx 把插件注册的路由接进一个最小 http server。
 */

import http from 'node:http'

import { apply } from '../lib/index.js'

const port = Number(process.env.PORT ?? 3221)
const allowRemote = process.env.ALLOW_REMOTE === '1'
const sources = process.env.SOURCES ? process.env.SOURCES.split(',').map((s) => s.trim()).filter(Boolean) : undefined

const registered = []
const ctx = {
  logger: console,
  webServer: {
    register(route) {
      registered.push(route)
      return () => {
        const index = registered.indexOf(route)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
  effect(fn) {
    return fn()
  },
}

apply(ctx, { allowRemote, sources, prewarm: false })

if (registered.length === 0) {
  console.error('没有注册任何路由 —— 插件可能没拿到 webServer。')
  process.exit(1)
}

/** 先找 exact，再找 prefix。和 DSH 的派发顺序一致：精确命中优先。 */
function pick(req) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  const exact = registered.find((route) => route.kind === 'exact' && route.path === pathname)
  if (exact) return exact
  return registered.find(
    (route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`)),
  )
}

const server = http.createServer(async (req, res) => {
  const route = pick(req)
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('这个预览服务器只挂了 4 条社区路由。试试 /community')
    return
  }
  try {
    await route.handler(req, res)
  } catch (error) {
    console.error('[preview] 处理失败：', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(error?.stack ?? error))
    }
  }
})

// 方便手机上直接看：ALLOW_REMOTE=1 时把局域网地址也打出来。
server.listen(port, allowRemote ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`[preview] 社区页面：  http://127.0.0.1:${port}/community`)
  console.log(`[preview] 社区 API：   http://127.0.0.1:${port}/api/v1/community/plugins`)
  console.log(`[preview] 已挂载 ${registered.length} 条路由：`, registered.map((r) => `${r.kind} ${r.path}`).join('、'))
  if (!allowRemote) {
    console.log('[preview] 只监听本机。想让手机访问，用 ALLOW_REMOTE=1 重启，并确认防火墙放行。')
  }
})
