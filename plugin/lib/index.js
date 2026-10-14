/**
 * dsh-plugin-community —— host 半边。
 *
 * 这一半只做一件事：把社区页面和 JSON API 挂到 DSH 自己的 webServer 上。
 * 它**不 import 任何 @deepseek-ai/\* 包**，也不依赖 schemastery ——
 * 这样在没有 DSH 环境的情况下也能用假 ctx 完整跑一遍（见 test/host.test.mjs）。
 *
 * 为什么非要走 host 侧 HTTP 而不是只做 client slot：
 * 一台没装任何 DSH 插件的手机，用普通浏览器打开这个地址就该看到社区内容。
 * client slot 做不到这件事，因为它要求在 DSH 的客户端插件图里。
 */

import { createCache } from './core/cache.js'
import { createHttpClient, probeRateLimit } from './core/http.js'
import { createGithub } from './core/github.js'
import { createIndexService } from './core/index-service.js'
import { createTokenStore } from './core/credentials.js'
import { createAuthService, DEFAULT_SCOPE } from './core/auth.js'
import { createWriter } from './core/write.js'
import { createToolDefinitions } from './core/tools.js'
import { API_PREFIX, PAGE_PREFIX, createCommunityRouter } from './core/api.js'
import { envelopeOf, forbidden } from './core/errors.js'

export const name = 'dsh-plugin-community'

/**
 * 只声明真正用到的宿主服务。少声明一个依赖，就少一种加载失败的姿势。
 *
 * `credentials` **故意不写进 inject**：拿不到它时插件要能降级到内存模式继续跑
 * （只是重启后要重新登录），而不是整个插件加载失败。
 */
export const inject = ['webServer']

export const Config = {
  owner: 'moyuqing-man',
  repo: 'dsh-plugin-community',
  allowRemote: false,
  cacheTtlMinutes: 60,
  sources: ['github-topic', 'awesome'],
  userAgent: 'dsh-plugin-community/0.1.0',
  prewarm: true,
  /**
   * 综合排序（`sort=smart`）里按「框架本体」降级的仓库。
   *
   * `topic:dsh-plugin` 是**自我声明**标签，框架自己也可能打上它 —— 于是
   * `deepseek-ai/deepseek-harness`（24 万 star）会把整个索引压平。
   * 这里列出来的仓库**不删除只降级**：仍然能搜到、仍出现在列表里，
   * 只是不占前排，并标上「框架本体」说明为什么它排得靠后。
   */
  frameworks: ['deepseek-ai/deepseek-harness'],
  /** 直接从索引里剔除的仓库（比降级更狠）。默认空 —— 删掉一个插件应该是显式决定。 */
  excludeRepos: [],
  /** GitHub OAuth App 的 Client ID。**这是公开值，不是秘密**（Device Flow 不需要 secret）。留空则登录功能关闭。 */
  clientId: '',
  /** Device Flow 申请的 scope。公开仓库发帖用 public_repo 就够了。 */
  scope: DEFAULT_SCOPE,
}

/**
 * 让 `Config` 同时是一个 **Standard Schema v1**。
 *
 * 为什么非加不可（这是真机跑出来的，不是推测）：
 * 真实 cordis 加载器在挂载前会调用
 *     runtime.Config['~standard'].validate(config)
 * （见 app.asar 内 `@deepseek-ai/cordis/lib/index.js:956-961` 的 `resolveConfig`）。
 * `Config` 只是个普通对象时，这一行直接抛
 *     TypeError: Cannot read properties of undefined (reading 'validate')
 * 整个插件**静默不激活**（启动日志只留一行 `warning: 1 entry did not activate`，
 * 页面全部 404）。本地假 ctx 测试永远发现不了这一点，因为那只调 `apply()`，
 * 不经过加载器的配置解析。真机验证脚本 `scripts/verify-tarball.mjs` 当时也没覆盖。
 *
 * 实现故意的两个选择：
 *   1. **不 import schemastery**。本插件的硬约束是零依赖 + 不 import
 *      `@deepseek-ai/*`（否则没有 DSH 环境时本地跑不了测试）。Standard Schema
 *      只是一个 `{version, vendor, validate}` 的对象，手写 10 行就够。
 *   2. **非枚举属性**。`Object.defineProperty` 默认 `enumerable: false`，
 *      所以 `Object.keys(Config)` 仍然只返回配置键 —— 现有的
 *      「patch 里的键必须与 Config 对得上」那条测试不会被这个元数据带偏，
 *      `{...Config}` 展开时也不会把它当成一个配置项。
 *
 * `validate` **永不抛错**：配置写错一个字段不该让整个插件加载失败，
 * 应该退化成默认值继续跑（`normalizeConfig` 就是这么做的）。
 */
Object.defineProperty(Config, '~standard', {
  value: {
    version: 1,
    vendor: 'dsh-plugin-community',
    validate: (value) => ({ value: normalizeConfig(value) }),
  },
})

/**
 * 只注册 4 条路由。
 *
 * 契约来自 cordis_inspect_query → host / Service / webServer：
 *   register(route: WebRoute): () => void
 *   WebRoute = { kind: 'exact' | 'prefix', path: string, handler: (req, res) => void | Promise<void> }
 *   —— 重复的 (kind, path) 会直接抛错（duplicate throws），所以刻意不用
 *   「每个子路径注册一条 exact」那种写满 15 条的写法。
 *
 * 两条 prefix 覆盖所有子路径，两条 exact 保证裸路径 `/community` 一定命中
 * （不同 kind 不算重复，所以这四条能共存）。
 */
const ROUTES = [
  { kind: 'prefix', path: PAGE_PREFIX, area: 'page' },
  { kind: 'prefix', path: API_PREFIX, area: 'api' },
  { kind: 'exact', path: PAGE_PREFIX, area: 'page' },
  { kind: 'exact', path: API_PREFIX, area: 'api' },
]

function subPathOf(pathname, prefix) {
  return String(pathname ?? '').slice(prefix.length).replace(/^\/+|\/+$/g, '')
}

const MAX_BODY_BYTES = 64 * 1024

function normalizeConfig(raw = {}) {
  const config = { ...Config, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (!Array.isArray(config.sources) || config.sources.length === 0) config.sources = [...Config.sources]
  // 这两个是用户会手写的名单，写错成字符串（`frameworks: 'a/b'`）比写错成数组常见得多
  if (!Array.isArray(config.frameworks)) config.frameworks = [...Config.frameworks]
  if (!Array.isArray(config.excludeRepos)) config.excludeRepos = [...Config.excludeRepos]
  const ttl = Number(config.cacheTtlMinutes)
  config.cacheTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl * 60_000 : 60 * 60_000
  return config
}

/**
 * 读一个**可选**宿主服务。拿不到就返回 null，绝不抛错。
 *
 * 这是真机跑出来的教训，值得写清楚：
 * cordis 的 `ctx` 是 Proxy，**没写进 `inject` 的服务名一律抛错** ——
 *     Error: cannot get property "credentials" without inject
 * （见 app.asar 内 `@deepseek-ai/cordis/lib/index.js:676` 的 Proxy get 陷阱）
 * 所以过去写的 `ctx.credentials ?? null` 这种「拿不到就是 null」的写法在真机上
 * 是**直接抛异常**，整个插件不激活。`ctx.get(name)` 才是安全的查询接口。
 *
 * 注意顺序：`ctx.get` 在前，属性访问只作为老版本 ctx 的兜底，
 * 且**必须包在 try/catch 里**（有些 ctx 实现连属性访问都会抛）。
 */
function optionalService(ctx, name) {
  if (ctx && typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value) return value
    } catch {
      /* 没这个服务，正常 */
    }
  }
  try {
    return ctx?.[name] ?? null
  } catch {
    // 未 inject 的 Proxy 陷阱会走到这里 —— 这不是错误，只是「没有」
    return null
  }
}

/** loopback 判定沿用 dsh-workspace 的做法（含 IPv4-mapped 形式）。 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function writeResponse(res, result) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(result?.headers ?? {}),
  }
  res.writeHead(result?.status ?? 200, headers)
  res.end(result?.body ?? '')
}

function requestIdOf(req) {
  const header = req?.headers?.['x-request-id']
  if (typeof header === 'string' && header.length && header.length <= 64) return header
  return Math.random().toString(36).slice(2, 10)
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} rawConfig 来自 cordis.patch.yml 的 config
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console

  const cache = createCache({})
  const http = createHttpClient({ logger, userAgent: config.userAgent })

  // credentials 是**可选**依赖：拿不到就退到内存模式（重启后要重新登录），
  // 而不是让整个插件加载失败。
  const credentials = optionalService(ctx, 'credentials')

  const tokenStore = createTokenStore({ credentials, logger })
  const github = createGithub({ http, cache, logger, getToken: () => tokenStore.accessToken() })
  const indexService = createIndexService({ http, cache, github, logger, config })
  const auth = createAuthService({
    http,
    tokenStore,
    github,
    cache,
    logger,
    clientId: String(config.clientId ?? '').trim(),
    scope: config.scope ?? DEFAULT_SCOPE,
  })
  const writer = createWriter({ http, cache, github, tokenStore, logger, config })
  const router = createCommunityRouter({
    indexService,
    github,
    cache,
    config,
    logger,
    tokenStore,
    auth,
    writer,
  })

  // github 的 getToken 是**同步**的，所以已存的授权必须在第一次读之前就进内存，
  // 否则会出现「明明登录过，但第一次读讨论仍然说没登录」这种最难查的 bug。
  void tokenStore.hydrate().catch((error) => {
    logger.warn?.(`[community] 读取已存凭据失败：${error?.message ?? error}`)
  })

  /* ----------------------------- Agent 工具（M4） -----------------------------
   * 工具定义在 core/tools.js 里是**普通对象**，这里直接交给 `tools.register`。
   * 参考实现（dsh-find-plugins）写的是 `ctx.tools.register(defineTool({...}))`，
   * 但 `defineTool` 只是一个给 TypeScript 推断用的透传包装 —— 注册进去的还是同一个
   * 对象。本插件不静态 import `@deepseek-ai/*`（那样本地就跑不了），所以这里传普通
   * 对象，形状与那边逐字一致。万一将来宿主真要 `defineTool` 做校验，改这一行即可。
   */
  const toolDefinitions = createToolDefinitions({ indexService, github, writer, auth, config })

  const tools = optionalService(ctx, 'tools')

  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => {
      const disposers = toolDefinitions.map((definition) => {
        try {
          return tools.register(definition)
        } catch (error) {
          logger.warn?.(`[community] 注册工具 ${definition.name} 失败：${error?.message ?? error}`)
          return undefined
        }
      })
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* 卸载失败不该影响别的工具 */
          }
        }
      }
    }, 'dsh-plugin-community: agent tools')
    logger.info?.(
      `[community] 已注册 ${toolDefinitions.length} 个 Agent 工具：${toolDefinitions.map((d) => d.name).join(', ')}`,
    )
  } else {
    logger.debug?.('[community] 拿不到 tools 服务，Agent 工具未注册（社区页面与 API 不受影响）。')
  }

  function buildContext(req, wantsHtml) {
    const host = req?.headers?.host ?? `127.0.0.1`
    const proto = req?.socket?.encrypted ? 'https' : 'http'
    const origin = `${proto}://${host}`
    const url = new URL(req?.url ?? '/', origin)
    return {
      method: String(req?.method ?? 'GET').toUpperCase(),
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      origin,
      requestOrigin: req?.headers?.origin,
      contentType: req?.headers?.['content-type'],
      // 服务端渲染的页面按它挑语言（`?lang=` 优先，其次就是这个头）
      acceptLanguage: req?.headers?.['accept-language'],
      requestId: requestIdOf(req),
      wantsHtml,
      readBody: () => readBody(req),
    }
  }

  function handlerFor(route) {
    return async (req, res) => {
      try {
        if (!config.allowRemote && !isLoopback(req)) {
          const payload = envelopeOf(forbidden('这个地址只允许本机访问'), requestIdOf(req))
          writeResponse(res, {
            status: 403,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: false, ...payload, hint: '想让手机访问，请在 cordis.patch.yml 里把 allowRemote 设为 true。' }),
          })
          return
        }
        const context = buildContext(req, route.area === 'page')
        const sub = subPathOf(context.pathname, route.path)
        const result = route.area === 'page'
          ? await router.page(sub, context)
          : await router.api(sub, context)
        writeResponse(res, result)
      } catch (error) {
        logger.warn?.(`[community] 处理请求失败：${error?.stack ?? error}`)
        const payload = envelopeOf(error, requestIdOf(req))
        writeResponse(res, {
          status: payload.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ok: false, ...payload }),
        })
      }
    }
  }

  // webServer 写在 inject 里，正常一定拿得到；但仍走同一条安全路径，
  // 免得将来有人把它从 inject 里去掉时又踩一次「未 inject 即抛错」。
  const webServer = optionalService(ctx, 'webServer')

  function register(route) {
    return typeof webServer.register === 'function' ? webServer.register(route) : undefined
  }

  /** 暴露给测试与调试用（不注册成宿主服务，避免污染）。 */
  const exposed = () => ({
    config,
    cache,
    http,
    github,
    indexService,
    router,
    tokenStore,
    auth,
    writer,
    toolDefinitions,
    probeRateLimit: () => probeRateLimit(http),
  })

  if (!webServer || typeof webServer.register !== 'function') {
    // 注意：这里**不能**直接 return 掉工具。拿不到 webServer 只说明页面挂不上，
    // Agent 工具跟 HTTP 一点关系都没有，没理由一起失效。
    logger.warn?.('[community] 拿不到 webServer 服务，社区页面与 API 未挂载。')
    return exposed()
  }

  ctx.effect(() => {
    const disposers = ROUTES.map((route) =>
      register({ kind: route.kind, path: route.path, handler: handlerFor(route) }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch (error) {
          logger.debug?.(`[community] 卸载路由失败：${error?.message ?? error}`)
        }
      }
    }
  }, 'dsh-plugin-community: routes')

  ctx.effect(
    () => (config.prewarm === false ? () => {} : indexService.prewarm()),
    'dsh-plugin-community: prewarm',
  )

  logger.info?.(
    `[community] 已挂载：${PAGE_PREFIX}（页面）与 ${API_PREFIX}（JSON API）；` +
      `索引源 ${indexService.sources.join(' + ')}；allowRemote=${config.allowRemote}`,
  )

  // 暴露给测试与调试用（不注册成宿主服务，避免污染）
  return exposed()
}

export default { name, inject, Config, apply }
