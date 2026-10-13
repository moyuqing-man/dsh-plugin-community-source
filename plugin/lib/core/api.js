/**
 * 路由处理器。
 *
 * 全部是**纯函数**：吃一个描述请求的普通对象，吐一个描述响应的普通对象。
 * 这样不启 DSH、不启 HTTP 服务器也能把每条路由测一遍 —— M1 的测试就是靠这一点。
 */

import {
  badRequest,
  envelope,
  envelopeOf,
  forbidden,
  methodNotAllowed,
  notFound,
} from './errors.js'
import { renderDetail, renderError, renderIndex, renderLogin } from './render.js'
import { resolveLocale, translator } from './i18n.js'
import { parseRepo } from './text.js'

export const PAGE_PREFIX = '/community'
export const API_PREFIX = '/api/v1/community'

const MAX_BODY_BYTES = 64 * 1024

const API_ROUTES = [
  { path: 'plugins', methods: ['GET'] },
  { path: 'plugin', methods: ['GET'] },
  { path: 'discussions', methods: ['GET'] },
  { path: 'discussion', methods: ['GET', 'POST'] },
  { path: 'reaction', methods: ['POST'] },
  { path: 'issues', methods: ['GET'] },
  { path: 'meta', methods: ['GET'] },
  { path: 'me', methods: ['GET'] },
  { path: 'auth/start', methods: ['POST'] },
  { path: 'auth/poll', methods: ['POST'] },
  { path: 'auth/logout', methods: ['POST'] },
]

const NOT_IN_M1 = '这一层在 M1 只做只读。写入路径要到 M2 接入 GitHub Device Flow 之后才开放。'
void NOT_IN_M1

function json(status, payload) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(payload),
  }
}

function html(status, body) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body }
}

function intOf(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function createCommunityRouter({
  indexService,
  github,
  cache,
  config = {},
  logger,
  tokenStore,
  auth,
  writer,
}) {
  async function readJson(readBody) {
    if (typeof readBody !== 'function') return {}
    const raw = await readBody()
    if (raw === undefined || raw === null || raw === '') return {}
    if (typeof raw === 'object') return raw
    const text = String(raw)
    if (text.length > MAX_BODY_BYTES) throw badRequest('请求体过大', ['body'])
    try {
      return JSON.parse(text)
    } catch {
      throw badRequest('请求体不是合法 JSON', ['body'])
    }
  }

  /**
   * 用 npm 包名反查仓库。插件详情页只给得出包名，给不出仓库地址，
   * 所以在索引里按 `npm` / `name` / `slug` 三种键匹配。
   * 匹配不到就返回 null —— 让调用方决定怎么报错，不在这里假装成功。
   */
  async function resolvePackage(pkg) {
    const needle = pkg.trim().toLowerCase()
    if (!needle) return null
    const found = await indexService.list({ q: pkg, perPage: 50, sort: 'stars' })
    const hit = (found?.items ?? []).find(
      (card) =>
        String(card.npm ?? '').toLowerCase() === needle ||
        String(card.name ?? '').toLowerCase() === needle ||
        String(card.slug ?? '').toLowerCase() === needle,
    )
    return hit?.repo ?? null
  }

  /**
   * 写操作的 CSRF 防护（docs/04 §7）。
   *
   * 独立页面场景下，跨站表单能发出 `application/x-www-form-urlencoded` 这种
   * 「简单请求」，浏览器**不会先发预检** —— 于是恶意页面就能借你的登录态发帖。
   * 所以写操作一律要求 `content-type: application/json`：这个类型会强制浏览器
   * 先发预检，而我们不会给跨站来源放行预检。
   *
   * 注意本节自己的页面**完全不发 POST**（登录靠 `GET /community/login` +
   * `<meta refresh>` 推进轮询），所以这条限制不影响「零 JS 也能用」。
   */
  function assertWriteAllowed(ctx) {
    const contentType = String(ctx.contentType ?? '').toLowerCase()
    if (!contentType.includes('application/json')) {
      throw forbidden('写操作要求 Content-Type: application/json（这是防跨站请求伪造的必要条件）。')
    }
    const requestOrigin = String(ctx.requestOrigin ?? '').trim()
    if (requestOrigin && ctx.origin && requestOrigin.replace(/\/$/, '') !== String(ctx.origin).replace(/\/$/, '')) {
      throw forbidden('跨站来源不允许写操作。')
    }
  }

  /* ------------------------------- JSON API ------------------------------- */

  async function api(sub, ctx) {
    const { method = 'GET', query = {}, origin = '', requestId = '-' } = ctx
    const clean = String(sub ?? '').replace(/^\/+|\/+$/g, '')

    const route = API_ROUTES.find((item) => item.path === clean)
    if (!route) throw notFound(`没有这个接口：/${clean}`)
    if (!route.methods.includes(method)) throw methodNotAllowed(route.methods.join(', '))
    if (method !== 'GET') assertWriteAllowed(ctx)

    switch (clean) {
      case 'plugins': {
        const list = await indexService.list({
          q: String(query.q ?? '').trim(),
          category: String(query.category ?? '').trim(),
          sort: String(query.sort ?? 'stars').trim(),
          page: intOf(query.page, 1),
          perPage: intOf(query.perPage, 30),
          force: query.force === '1' || query.force === 'true',
        })
        return json(200, {
          ok: true,
          data: {
            items: list.items,
            total: list.total,
            page: list.page,
            pages: list.pages,
            perPage: list.perPage,
            sort: list.sort,
            facets: list.facets,
            knownTotal: list.knownTotal,
          },
          meta: {
            sources: list.sources,
            errors: list.errors,
            stale: list.stale,
            loadedAt: list.loadedAt,
            requestId,
          },
        })
      }

      case 'plugin': {
        let repo = parseRepo(String(query.repo ?? ''))
        if (!repo) {
          // 允许用 npm 包名查。client 半边手里只有 package name（插件详情页不给仓库地址），
          // 所以这条路是「不离开插件详情页就能看到社区讨论」的前提。
          const pkg = String(query.pkg ?? '').trim()
          if (pkg) repo = await resolvePackage(pkg)
        }
        if (!repo) throw badRequest('缺少或不合法的 repo / pkg 参数', ['repo'])
        const detail = await indexService.details(repo, { force: query.force === '1' })
        if (!detail) throw notFound(`索引里没有 ${repo}，可以先搜一下`)
        return json(200, { ok: true, data: detail, meta: { requestId } })
      }

      case 'issues': {
        const repo = parseRepo(String(query.repo ?? ''))
        if (!repo) throw badRequest('缺少或不合法的 repo 参数', ['repo'])
        const issues = await github.issues(repo, {
          state: String(query.state ?? 'open'),
          perPage: intOf(query.perPage, 10),
        })
        return json(200, { ok: true, data: issues, meta: { requestId } })
      }

      case 'discussions': {
        const repo = parseRepo(String(query.repo ?? ''))
        if (!repo) throw badRequest('缺少或不合法的 repo 参数', ['repo'])
        const discussions = await github.discussions(repo, { first: intOf(query.first, 20) })
        return json(200, { ok: true, data: discussions, meta: { requestId } })
      }

      case 'discussion': {
        if (method === 'POST') {
          const payload = await readJson(ctx.readBody)
          const created = await writer.createDiscussion({
            title: payload.title,
            body: payload.body,
            categorySlug: payload.category ?? payload.categorySlug,
          })
          return json(201, { ok: true, data: created, meta: { requestId } })
        }
        const id = String(query.id ?? '').trim()
        if (!id) throw badRequest('缺少 id 参数（讨论链接或编号）', ['id'])
        // 讨论正文托管在 GitHub，不在这里复制一份
        return json(200, {
          ok: true,
          data: { id, hostedAt: 'github', url: id.startsWith('http') ? id : null },
          meta: { requestId, note: '讨论内容托管在 GitHub Discussions，本接口只做转发与索引。' },
        })
      }

      case 'reaction': {
        const payload = await readJson(ctx.readBody)
        const result = await writer.addReaction({ subjectId: payload.subjectId, content: payload.content })
        return json(200, { ok: true, data: result, meta: { requestId } })
      }

      case 'meta': {
        // client 半边只拿得到「我是谁、社区在哪个仓库、登录配好没有」这类公开事实。
        // 这里**不放** client secret、token 或任何私密值 —— docs/04 §7 的硬要求。
        const fullName = `${config.owner}/${config.repo}`
        return json(200, {
          ok: true,
          data: {
            owner: config.owner,
            repo: config.repo,
            fullName,
            communityUrl: `https://github.com/${fullName}`,
            discussionsUrl: `https://github.com/${fullName}/discussions`,
            issuesUrl: `https://github.com/${fullName}/issues`,
            pagePrefix: PAGE_PREFIX,
            apiPrefix: API_PREFIX,
            clientIdConfigured: Boolean(config.clientId),
            scope: auth?.SCOPE ?? '',
            sources: typeof indexService.sources === 'function' ? indexService.sources() : (indexService.sources ?? []),
          },
          meta: { requestId },
        })
      }

      case 'me': {
        const me = await auth.status()
        return json(200, { ok: true, data: me, meta: { requestId } })
      }

      case 'auth/start': {
        const started = await auth.start()
        return json(200, { ok: true, data: started, meta: { requestId } })
      }

      case 'auth/poll': {
        const payload = await readJson(ctx.readBody)
        const result = await auth.poll(payload.flowId ?? query.flowId)
        return json(result.status === 'ok' ? 200 : 202, {
          ok: result.status === 'ok',
          data: result,
          meta: { requestId },
        })
      }

      case 'auth/logout': {
        const result = await auth.logout()
        return json(200, { ok: true, data: result, meta: { requestId } })
      }

      default:
        throw notFound()
    }
  }

  /* ------------------------------ HTML pages ------------------------------ */

  /**
   * 这一页用哪种语言：`?lang=` 优先，其次是 `Accept-Language`，最后是默认中文。
   * 放在这里统一取一次，免得每个分支各写一遍还写得不一样。
   */
  function localeOf(ctx) {
    return resolveLocale({ query: ctx?.query, headers: { 'accept-language': ctx?.acceptLanguage } })
  }

  async function page(sub, ctx) {
    const { query = {}, origin = '', requestId = '-' } = ctx
    const clean = String(sub ?? '').replace(/^\/+|\/+$/g, '')
    const status = auth ? await auth.status() : null
    const locale = localeOf(ctx)
    const T = translator(locale)

    if (clean === '') {
      const list = await indexService.list({
        q: String(query.q ?? '').trim(),
        category: String(query.category ?? '').trim(),
        sort: String(query.sort ?? 'stars').trim(),
        page: intOf(query.page, 1),
        perPage: intOf(query.perPage, 30),
      })
      return html(200, renderIndex({ list, config, origin, status, locale }))
    }

    if (clean === 'plugin') {
      const repo = parseRepo(String(query.repo ?? ''))
      if (!repo) {
        // 不带参数时给个搜索框，而不是一个错误页 —— 用户常常是手敲地址
        return html(303, '')
      }
      const detail = await indexService.details(repo)
      if (!detail) {
        return html(
          404,
          renderError({
            status: 404,
            reason: 'NOT_FOUND',
            message: T('error.pluginNotFound', { repo }),
            origin,
            requestId,
            locale,
          }),
        )
      }
      return html(200, renderDetail({ detail, origin, status, locale }))
    }

    if (clean === 'login') {
      const loggedIn = await auth.status()
      if (loggedIn.authenticated && query.force !== '1') {
        return { status: 303, headers: { location: `${PAGE_PREFIX}/` }, body: '' }
      }

      const flowId = String(query.flow ?? '').trim()
      if (flowId) {
        try {
          const result = await auth.poll(flowId)
          if (result.status === 'ok') {
            return { status: 303, headers: { location: `${PAGE_PREFIX}/` }, body: '' }
          }
          return html(
            200,
            renderLogin({
              flow: auth.describeFlow(flowId),
              status: loggedIn,
              config,
              origin,
              pending: result,
              locale,
            }),
          )
        } catch (error) {
          // 流程没了（过期/已用完）就自动重开一个，别让用户对着死页面发呆
          const payload = envelopeOf(error, requestId)
          const restarted = await auth.start().catch(() => null)
          return html(
            200,
            renderLogin({ flow: restarted, status: loggedIn, config, origin, note: payload.message, locale }),
          )
        }
      }

      try {
        const started = await auth.start()
        return html(200, renderLogin({ flow: started, status: loggedIn, config, origin, locale }))
      } catch (error) {
        const payload = envelopeOf(error, requestId)
        // 页面本身**渲染成功了**（它就是在教你怎么配置），所以这里回 200。
        // 503 那个状态码留给 JSON API —— 让脚本能测出「还没配好」，
        // 但不要让人在浏览器里看到一个「服务器错误」的红页。
        return html(200, renderLogin({ flow: null, status: loggedIn, config, origin, error: payload, locale }))
      }
    }

    if (clean === 'u') {
      const login = String(query.login ?? '').trim()
      if (!login) throw badRequest('缺少 login 参数', ['login'])
      const list = await indexService.list({ q: login, sort: 'stars', perPage: 100 })
      const owned = list.items.filter((card) => card.owner.toLowerCase() === login.toLowerCase())
      return html(
        200,
        renderIndex({
          list: { ...list, items: owned, total: owned.length, query: '', facets: { categories: [], archived: 0, withNpm: 0 } },
          config,
          origin,
          status,
          locale,
        }),
      )
    }

    if (clean === 't') {
      // 讨论正文在 GitHub 上，这里不做二次托管
      const id = String(query.id ?? '').trim()
      if (/^https:\/\/github\.com\//.test(id)) return { status: 302, headers: { location: id }, body: '' }
      return html(
        200,
        renderError({
          status: 404,
          reason: 'NOT_FOUND',
          message: T('error.discussionNotHosted'),
          origin,
          requestId,
          locale,
        }),
      )
    }

    throw notFound(T('error.pageNotFound', { path: `/community/${clean}` }))
  }

  /** 统一收口：任何 handler 抛出的异常都在这里变成协议约定好的信封。 */
  function guard(handler) {
    return async (sub, ctx) => {
      const requestId = ctx?.requestId ?? '-'
      try {
        return await handler(sub, ctx)
      } catch (error) {
        const payload = envelopeOf(error, requestId)
        logger?.debug?.(`[community] ${payload.status} ${payload.reason}: ${payload.message}`)
        if (ctx?.wantsHtml) {
          return html(
            payload.status,
            renderError({ ...payload, origin: ctx.origin ?? '', locale: localeOf(ctx) }),
          )
        }
        return json(payload.status, { ok: false, ...payload })
      }
    }
  }

  return {
    api: guard(api),
    page: guard(page),
    API_PREFIX,
    PAGE_PREFIX,
    routes: API_ROUTES,
    health: () => ({
      ok: true,
      ...indexService.stats(),
      cache: cache?.size ?? 0,
      auth: { configured: Boolean(auth?.configured?.()), liveFlows: auth?.liveFlows?.() ?? 0 },
    }),
  }
}

export { envelope }
