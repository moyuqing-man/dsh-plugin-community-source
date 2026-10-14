import test from 'node:test'
import assert from 'node:assert/strict'

import { createCommunityRouter, API_PREFIX, PAGE_PREFIX } from '../lib/core/api.js'
import { createCard } from '../lib/core/normalize.js'
import { renderIndex } from '../lib/core/render.js'
import { createCache } from '../lib/core/cache.js'
import { ApiError, badRequest, unauthorized } from '../lib/core/errors.js'

const ORIGIN = 'http://127.0.0.1:3220'

const card = createCard(
  {
    repo: 'AnonyJcy/dsh-j-space',
    category: 'ui',
    description: { en: 'A panel plugin', zh: '一个面板插件' },
    stars: 4,
    downloads: 1982,
    npm: '@anonyjcy/dsh-j-space',
    install: 'dsh plugin --profile web add @anonyjcy/dsh-j-space',
    capabilities: ['添加自定义面板'],
  },
  'awesome',
)

function makeList(overrides = {}) {
  return {
    items: [card],
    total: 1,
    filteredTotal: 1,
    page: 1,
    pages: 1,
    perPage: 30,
    sort: 'stars',
    query: '',
    category: '',
    facets: { categories: [{ slug: 'ui', count: 1 }], archived: 0, withNpm: 1 },
    sources: [{ id: 'awesome', label: 'awesome-dsh-plugin', state: 'fresh', stale: false, ageMs: 0, meta: {}, error: null }],
    errors: [],
    stale: false,
    loadedAt: '2026-10-13T00:00:00.000Z',
    knownTotal: 1,
    ...overrides,
  }
}

function makeRouter({ token = false, list = makeList(), detail = null, calls = [] } = {}) {
  const indexService = {
    // 把调用参数回填进返回值：真实的 indexService 会这么做，假件不回填的话
    // 渲染层拿到的永远是构造时写死的那份，测「按 query 切换」就会测了个寂寞。
    list: async (options = {}) => {
      calls.push({ what: 'list', options })
      const merged = { ...list }
      if (options.sort !== undefined) merged.sort = options.sort
      if (options.kind !== undefined) merged.kind = options.kind
      if (options.category !== undefined) merged.category = options.category
      if (options.q !== undefined) merged.query = options.q
      return merged
    },
    details: async () => detail,
    get: async () => ({ card }),
    stats: () => ({ sources: [{ id: 'awesome' }], known: 1, cache: 0 }),
    sorts: ['smart', 'stars', 'downloads', 'recent', 'name'],
    smart: 'smart',
  }
  const github = {
    hasToken: () => token,
    viewer: async () => (token ? { login: 'moyuqing-man', name: null, avatarUrl: null, htmlUrl: 'https://github.com/moyuqing-man' } : null),
    issues: async () => ({ available: true, items: [], totalCount: 0 }),
    discussions: async () => ({ available: false, reason: 'TOKEN_REQUIRED', message: '需要登录', items: [], totalCount: 0, categories: [] }),
    /**
     * 单条讨论：未登录时**和 discussions 一样**必须是「不可用 + 原因」，
     * 而不是空正文 —— 否则页面会显示成「这条帖子没有内容」。
     */
    thread: async (repo, number) => {
      calls.push({ what: 'thread', repo, number })
      if (!token) {
        return { available: false, reason: 'TOKEN_REQUIRED', message: '需要登录', comments: [] }
      }
      return {
        available: true,
        reason: null,
        discussion: { id: 'D_1', number, title: '示例讨论', url: 'https://github.com/x/y/discussions/1', body: '正文', author: 'moyuqing-man' },
        comments: [{ id: 'DC_1', url: 'https://github.com/x/y/discussions/1#c1', body: '一条评论', author: 'someone', reactions: 2 }],
      }
    },
    /** 作者资料走 REST，所以**未登录也读得到** —— 这是与讨论列表的关键区别。 */
    userProfile: async (login) => {
      calls.push({ what: 'userProfile', login })
      if (String(login).toLowerCase() === 'ghost') return { found: false, login }
      return {
        found: true,
        login,
        name: '示例用户',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        htmlUrl: `https://github.com/${login}`,
        type: 'User',
        bio: '写插件的',
        repos: 12,
        followers: 34,
        createdAt: '2026-08-04T00:00:00Z',
      }
    },
  }

  const TOKEN = 'FAKE-TOKEN-C'
  const publicView = () =>
    token
      ? { authenticated: true, login: 'moyuqing-man', avatarUrl: null, scopes: ['public_repo'] }
      : { authenticated: false, login: null, avatarUrl: null, scopes: [] }

  const tokenStore = {
    accessToken: () => (token ? TOKEN : null),
    get: () => (token ? { accessToken: TOKEN } : null),
    publicView,
    hydrate: async () => {},
    save: async () => {},
    updateProfile: async () => {},
    clear: async () => {},
  }

  const requireToken = () => {
    if (!token) throw unauthorized('这一步需要先登录 GitHub。点页面上的「用 GitHub 登录」就行。')
    return TOKEN
  }

  const auth = {
    start: async () => ({
      status: 'ok',
      flowId: 'flow-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    }),
    poll: async (flowId) => {
      if (!flowId) throw badRequest('缺少 flowId', ['flowId'])
      return {
        status: 'pending',
        reason: 'authorization_pending',
        message: '还没在 GitHub 上完成授权，继续等。',
        interval: 5,
        retryAfterMs: 3_000,
        expiresIn: 800,
      }
    },
    status: async () => publicView(),
    logout: async () => ({ authenticated: false }),
    describeFlow: (id) =>
      String(id) === 'flow-1'
        ? {
            flowId: 'flow-1',
            userCode: 'ABCD-1234',
            verificationUri: 'https://github.com/login/device',
            expiresIn: 900,
            interval: 5,
            slowDowns: 0,
          }
        : null,
    configured: () => true,
    liveFlows: () => 1,
  }

  const writer = {
    requireToken,
    createDiscussion: async (input = {}) => {
      requireToken()
      if (!String(input.title ?? '').trim()) throw badRequest('标题不能为空', ['title'])
      return {
        id: 'D_kwDOtest',
        number: 1,
        title: String(input.title),
        url: 'https://github.com/moyuqing-man/dsh-plugin-community/discussions/1',
        createdAt: '2026-10-13T00:00:00Z',
        category: input.categorySlug ?? 'general',
        repo: 'moyuqing-man/dsh-plugin-community',
      }
    },
    addComment: async (input = {}) => {
      requireToken()
      calls.push({ what: 'addComment', input })
      if (!String(input.discussionId ?? '').trim()) throw badRequest('缺少 discussionId', ['discussionId'])
      if (!String(input.body ?? '').trim()) throw badRequest('评论不能为空', ['body'])
      return {
        id: 'DC_kwDOtest',
        url: 'https://github.com/moyuqing-man/dsh-plugin-community/discussions/1#discussioncomment-1',
        createdAt: '2026-10-14T00:00:00Z',
        replyToId: input.replyToId ?? null,
      }
    },
    addReaction: async (input = {}) => {
      requireToken()
      return { id: 'R_1', content: String(input.content ?? '') }
    },
    canWrite: () => token,
    stats: () => ({ lastWriteAt: 0, recent: 0, minWriteIntervalMs: 1_200 }),
    resolveRepository: async () => {
      requireToken()
      return { id: 'R_kgDOtest', categories: [] }
    },
  }

  const router = createCommunityRouter({
    indexService,
    github,
    cache: createCache({}),
    config: { owner: 'moyuqing-man', repo: 'dsh-plugin-community' },
    logger: { debug() {}, warn() {}, info() {} },
    tokenStore,
    auth,
    writer,
  })
  return router
}

const ctx = (extra = {}) => ({
  method: 'GET',
  query: {},
  origin: ORIGIN,
  requestId: 'test-1',
  ...extra,
})

/** 写操作必须带 application/json（CSRF 防护），所以测试里也得带上。 */
const writeCtx = (payload, extra = {}) =>
  ctx({
    method: 'POST',
    contentType: 'application/json',
    readBody: async () => JSON.stringify(payload ?? {}),
    ...extra,
  })

test('GET /plugins 返回 JSON，带上 meta.sources', async () => {
  const router = makeRouter()
  const res = await router.api('plugins', ctx())
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')

  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.data.items.length, 1)
  assert.equal(body.data.items[0].slug, 'anonyjcy/dsh-j-space')
  assert.equal(body.meta.requestId, 'test-1')
  assert.equal(body.meta.sources[0].id, 'awesome')
})

test('查询参数被透传（q / category / sort / page / perPage）', async () => {
  let seen = null
  const router = makeRouter()
  router.list = null
  const captured = createCommunityRouter({
    indexService: { list: async (o) => { seen = o; return makeList() }, details: async () => null, stats: () => ({}) },
    github: { hasToken: () => false },
    cache: createCache({}),
    config: {},
    logger: { debug() {} },
  })
  await captured.api('plugins', ctx({ query: { q: 'tts', category: 'ui', sort: 'downloads', page: '3', perPage: '10' } }))
  assert.equal(seen.q, 'tts')
  assert.equal(seen.category, 'ui')
  assert.equal(seen.sort, 'downloads')
  assert.equal(seen.page, 3)
  assert.equal(seen.perPage, 10)
  assert.equal(router.list, null)
})

test('未知接口 → 404 信封', async () => {
  const router = makeRouter()
  const res = await router.api('nope', ctx())
  assert.equal(res.status, 404)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'NOT_FOUND')
})

test('方法不对 → 405 并带 allow 字段', async () => {
  const router = makeRouter()
  const res = await router.api('plugins', ctx({ method: 'POST' }))
  assert.equal(res.status, 405)
  const body = JSON.parse(res.body)
  assert.equal(body.reason, 'METHOD_NOT_ALLOWED')
  assert.deepEqual(body.fields, [{ name: 'allow', value: 'GET' }])
})

test('未登录发帖 → 401，并且不产生任何写入', async () => {
  const router = makeRouter({ token: false })
  const res = await router.api('discussion', writeCtx({ title: '求助', body: '正文' }))
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).reason, 'UNAUTHORIZED')
})

test('已登录发帖 → 201，并返回 GitHub 上的链接', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api('discussion', writeCtx({ title: '求助：装了之后起不来', body: '正文', category: 'ask-for-help' }))
  assert.equal(res.status, 201)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.match(body.data.url, /^https:\/\/github\.com\//)
  assert.equal(body.data.category, 'ask-for-help')
})

test('发帖缺标题 → 400（在打 GitHub 之前就拦住）', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api('discussion', writeCtx({ body: '只有正文' }))
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).reason, 'BAD_REQUEST')
})

test('写操作不带 Content-Type: application/json → 403（CSRF 防护）', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api(
    'discussion',
    ctx({ method: 'POST', contentType: 'application/x-www-form-urlencoded', readBody: async () => '{}' }),
  )
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).reason, 'FORBIDDEN')
})

test('跨站 Origin 不允许写操作', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api('reaction', writeCtx({ subjectId: 'D_1', content: 'THUMBS_UP' }, { requestOrigin: 'https://evil.example' }))
  assert.equal(res.status, 403)
})

test('auth/start 只给验证码，绝不返回 device_code', async () => {
  const router = makeRouter()
  const res = await router.api('auth/start', writeCtx({}))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.data.userCode, 'ABCD-1234')
  assert.equal(body.data.expiresIn, 900)
  assert.equal(body.data.interval, 5)
  assert.equal(res.body.includes('device_code'), false)
  assert.equal(res.body.includes('deviceCode'), false)
})

test('auth/poll 还没授权完 → 202 + pending（不是错误）', async () => {
  const router = makeRouter()
  const res = await router.api('auth/poll', writeCtx({ flowId: 'flow-1' }))
  assert.equal(res.status, 202)
  const body = JSON.parse(res.body)
  assert.equal(body.data.status, 'pending')
  assert.equal(body.data.reason, 'authorization_pending')
  assert.ok(body.data.retryAfterMs > 0)
})

test('auth/poll 缺 flowId → 400', async () => {
  const router = makeRouter()
  const res = await router.api('auth/poll', writeCtx({}))
  assert.equal(res.status, 400)
})

test('auth/logout 清除登录态', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api('auth/logout', writeCtx({}))
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body).data, { authenticated: false })
})

test('plugin 接口缺 repo → 400', async () => {
  const router = makeRouter({ detail: { card, meta: null, issues: null, discussions: null } })
  const res = await router.api('plugin', ctx({ query: {} }))
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).reason, 'BAD_REQUEST')
})

test('plugin 接口查不到 → 404', async () => {
  const router = makeRouter({ detail: null })
  const res = await router.api('plugin', ctx({ query: { repo: 'a/b' } }))
  assert.equal(res.status, 404)
})

test('me 接口未登录时 authenticated:false，登录后给 login，但永不回 token', async () => {
  const router = makeRouter({ token: false })
  const res = await router.api('me', ctx())
  const data = JSON.parse(res.body).data
  assert.equal(data.authenticated, false)
  assert.equal(data.login, null)

  const authed = makeRouter({ token: true })
  const res2 = await authed.api('me', ctx())
  const data2 = JSON.parse(res2.body).data
  assert.equal(data2.login, 'moyuqing-man')
  // DoD：token 绝不能出现在任何响应体里
  assert.equal(res2.body.includes('FAKE-TOKEN-C'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(data2, 'accessToken'), false)
})

test('登录页：大号验证码 + meta refresh 推进轮询 + 不执行 JS', async () => {
  const router = makeRouter()
  const res = await router.page('login', ctx())
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /ABCD-1234/)
  assert.match(res.body, /http-equiv="refresh"/)
  assert.match(res.body, /user-select:all/)
  assert.doesNotMatch(res.body, /<script/i)
  // 页面本身不能泄漏 device_code
  assert.equal(res.body.includes('device_code'), false)
})

test('登录页在未配置 clientId 时给出可操作的说明，而不是白屏', async () => {
  const indexService = { list: async () => makeList(), details: async () => null, stats: () => ({}) }
  const auth = {
    status: async () => ({ authenticated: false, login: null, scopes: [] }),
    start: async () => {
      throw new ApiError(503, 'NOT_CONFIGURED', '还没配置 Client ID', [
        { name: 'howto', value: '1. 打开 github.com/settings/developers' },
      ])
    },
  }
  const router = createCommunityRouter({
    indexService,
    github: { hasToken: () => false },
    cache: createCache({}),
    config: {},
    logger: { debug() {} },
    auth,
    writer: {},
  })
  const res = await router.page('login', ctx())
  // 页面**渲染成功了**（它就是在教你怎么配），所以是 200。
  // 503 只留给 JSON API，免得浏览器里弹一个「服务器错误」红页。
  assert.equal(res.status, 200)
  assert.match(res.body, /Client ID/)
  assert.match(res.body, /settings\/developers/)
  assert.ok(!/<script/i.test(res.body))
  assert.ok(!/\*\*/.test(res.body), 'HTML 里不能出现 markdown 的星号粗体')
})

test('未配置 clientId 时 JSON API 仍然如实回 503（脚本要能测出来）', async () => {
  const router = createCommunityRouter({
    indexService: { list: async () => makeList(), details: async () => null, stats: () => ({}) },
    github: { hasToken: () => false },
    cache: createCache({}),
    config: {},
    logger: { debug() {} },
    auth: {
      status: async () => ({ authenticated: false, login: null, scopes: [] }),
      start: async () => {
        throw new ApiError(503, 'NOT_CONFIGURED', '还没配置 Client ID')
      },
    },
    writer: {},
  })
  const res = await router.api('auth/start', ctx({ method: 'POST', contentType: 'application/json', requestOrigin: ctx().origin, query: {}, payload: {} }))
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).reason, 'NOT_CONFIGURED')
})

test('页面 /community 是服务端渲染的 HTML，关掉 JS 也能看', async () => {
  const router = makeRouter()
  const res = await router.page('', ctx())
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.body, /^<!doctype html>/)
  assert.match(res.body, /DSH 插件社区/)
  assert.match(res.body, /anonyjcy\/dsh-j-space/i)
  // 搜索与翻页必须是普通表单与链接，不能依赖脚本
  assert.match(res.body, /<form class="bar" method="get"/)
  assert.doesNotMatch(res.body, /<script/i)
})

test('页面 /community/plugin 渲染详情，且讨论不可用时如实说明', async () => {
  const detail = {
    card,
    meta: { found: true, stars: 5, openIssues: 2, pushedAt: '2026-10-01T00:00:00Z', license: 'MIT' },
    issues: { available: true, items: [], totalCount: 0 },
    discussions: { available: false, reason: 'TOKEN_REQUIRED', message: '需要登录 GitHub 后才能读取', items: [], totalCount: 0, categories: [] },
  }
  const router = makeRouter({ detail })
  const res = await router.page('plugin', ctx({ query: { repo: 'AnonyJcy/dsh-j-space' } }))
  assert.equal(res.status, 200)
  assert.match(res.body, /需要登录 GitHub 后才能读取/)
  assert.match(res.body, /dsh plugin --profile web add @anonyjcy\/dsh-j-space/)
})

test('页面 /community/plugin 参数非法时给搜索入口而不是错误页', async () => {
  const router = makeRouter()
  const res = await router.page('plugin', ctx({ query: { repo: 'https://gitlab.com/x' } }))
  assert.equal(res.status, 303)
})

test('页面 /community/plugin 索引里没有 → 404 的 HTML 错误页', async () => {
  const router = makeRouter({ detail: null })
  const res = await router.page('plugin', ctx({ query: { repo: 'a/b' } }))
  assert.equal(res.status, 404)
  assert.match(res.body, /索引里没有 a\/b/)
})

test('未知页面 → 404', async () => {
  const router = makeRouter()
  const res = await router.page('whatever', ctx())
  assert.equal(res.status, 404)
})

test('/community/t 只转发到 GitHub，不二次托管讨论正文', async () => {
  const router = makeRouter()
  const res = await router.page('t', ctx({ query: { id: 'https://github.com/a/b/discussions/1' } }))
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, 'https://github.com/a/b/discussions/1')
})

test('runs 页面按 owner 过滤', async () => {
  const other = createCard({ repo: 'Someone/other', description: 'x' }, 'awesome')
  const router = makeRouter({ list: makeList({ items: [card, other] }) })
  const res = await router.page('u', ctx({ query: { login: 'AnonyJcy' } }))
  assert.equal(res.status, 200)
  assert.match(res.body, /dsh-j-space/)
  assert.doesNotMatch(res.body, /Someone\/other/)
})

test('错误处理不会把堆栈泄漏给前端', async () => {
  const router = createCommunityRouter({
    indexService: { list: async () => { throw new Error('内部实现细节不应该出现在响应里') }, details: async () => null, stats: () => ({}) },
    github: { hasToken: () => false },
    cache: createCache({}),
    config: {},
    logger: { debug() {}, warn() {} },
  })
  const res = await router.api('plugins', ctx())
  assert.equal(res.status, 500)
  const body = JSON.parse(res.body)
  assert.equal(body.reason, 'INTERNAL')
  assert.equal(body.requestId, 'test-1')
  assert.doesNotMatch(res.body, /at Object\./)
})

test('DoD 检查：30 条卡片的首页 HTML 超过 10000 字节', () => {
  const cards = Array.from({ length: 30 }, (_, i) =>
    createCard(
      {
        repo: `owner${i}/plugin-${i}`,
        category: 'tools',
        description: { en: `Plugin number ${i}`, zh: `第 ${i} 个插件，用来验证服务端渲染的体积` },
        stars: i * 7,
        downloads: i * 13,
        npm: `@owner${i}/plugin-${i}`,
      },
      'awesome',
    ),
  )
  const html = renderIndex({
    list: makeList({ items: cards, total: 30, knownTotal: 30, pages: 1 }),
    config: {},
    origin: ORIGIN,
  })
  assert.ok(Buffer.byteLength(html, 'utf8') > 10_000, `首页只有 ${Buffer.byteLength(html, 'utf8')} 字节`)
})

test('前缀常量与文档一致', () => {
  assert.equal(PAGE_PREFIX, '/community')
  assert.equal(API_PREFIX, '/api/v1/community')
})

/* --------------------------- M3：client 半边的数据面 --------------------------- */

test('GET /meta 只给公开事实，永远不含 token 或 secret', async () => {
  // 这个接口是**给浏览器里的 client 半边读的**，所以它是全项目最需要盯住
  // 「别把凭据漏出去」的一个出口。这里同时以已登录身份请求，确保登录
  // 状态不会顺手把 token 带出来。
  const router = makeRouter({ token: true })
  const res = await router.api('meta', ctx())
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')

  const body = JSON.parse(res.body)
  assert.equal(body.data.owner, 'moyuqing-man')
  assert.equal(body.data.repo, 'dsh-plugin-community')
  assert.equal(body.data.fullName, 'moyuqing-man/dsh-plugin-community')
  assert.equal(body.data.communityUrl, 'https://github.com/moyuqing-man/dsh-plugin-community')
  assert.equal(body.data.discussionsUrl, 'https://github.com/moyuqing-man/dsh-plugin-community/discussions')
  assert.equal(body.data.clientIdConfigured, false)
  assert.equal(body.data.pagePrefix, PAGE_PREFIX)
  assert.equal(body.data.apiPrefix, API_PREFIX)

  assert.doesNotMatch(res.body, /FAKE-TOKEN-C/)
  assert.doesNotMatch(res.body, /accessToken/)
  assert.doesNotMatch(res.body, /client_?secret/i)
  assert.doesNotMatch(res.body, /payload/)
})

test('GET /meta 在配好 clientId 后如实报告，别的什么都不变', async () => {
  const router = makeRouter()
  const withId = createCommunityRouter({
    indexService: { list: async () => makeList(), details: async () => null, stats: () => ({}) },
    github: { hasToken: () => false },
    cache: createCache({}),
    config: { owner: 'moyuqing-man', repo: 'dsh-plugin-community', clientId: 'Iv1.abc123' },
    logger: { debug() {}, warn() {}, info() {} },
    tokenStore: { publicView: () => ({ authenticated: false }) },
    auth: { status: async () => ({ authenticated: false }), SCOPE: 'read:user public_repo', configured: () => true, liveFlows: () => 0 },
    writer: {},
  })
  const body = JSON.parse((await withId.api('meta', ctx())).body)
  assert.equal(body.data.clientIdConfigured, true)
  // clientId 是**公开值**，但不是这个接口该广播的东西 —— 前端只需要知道「配没配」
  assert.doesNotMatch(JSON.stringify(body.data), /Iv1\.abc123/)
  void router
})

test('GET /plugin 支持用 npm 包名反查（client 半边手里只有包名，没有仓库地址）', async () => {
  // 插件详情页的 subject 只给得出 package name；「不离开详情页就能看到社区讨论」
  // 这条准出条件，前提就是这里能把包名换成仓库。
  const detail = {
    card,
    meta: { found: true, stars: 4 },
    issues: { available: true, items: [], totalCount: 0 },
    discussions: { available: false, reason: 'TOKEN_REQUIRED', message: '需要登录', items: [], totalCount: 0, categories: [] },
  }
  const router = makeRouter({ detail })
  const res = await router.api('plugin', ctx({ query: { pkg: '@anonyjcy/dsh-j-space' } }))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.data.card.repo, 'AnonyJcy/dsh-j-space')
  // 读不到讨论时必须如实说读不到 —— 空列表会被误读成「这个插件没人讨论」
  assert.equal(body.data.discussions.available, false)
  assert.equal(body.data.discussions.reason, 'TOKEN_REQUIRED')
})

test('GET /plugin 的 pkg 大小写不敏感', async () => {
  const router = makeRouter({ detail: { card, meta: {}, issues: { items: [] }, discussions: { available: false } } })
  const res = await router.api('plugin', ctx({ query: { pkg: '@ANONYJCY/DSH-J-SPACE' } }))
  assert.equal(res.status, 200)
})

test('GET /plugin 的 pkg 查不到时明确报错，而不是拿一张空卡片糊弄', async () => {
  const router = makeRouter({ list: makeList({ items: [], total: 0 }) })
  const res = await router.api('plugin', ctx({ query: { pkg: 'no-such-plugin-xyz' } }))
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).reason, 'BAD_REQUEST')
})

test('GET /plugin 既没有 repo 也没有 pkg → 400', async () => {
  const router = makeRouter()
  const res = await router.api('plugin', ctx())
  assert.equal(res.status, 400)
  assert.equal(JSON.parse(res.body).reason, 'BAD_REQUEST')
})

/* ------------------------------ M4：发评论 / 作者 / 单帖 ------------------------------ */

test('POST /comment 未登录 → 401，且一条 GraphQL 都不发', async () => {
  const calls = []
  const router = makeRouter({ token: false, calls })
  const res = await router.api('comment', writeCtx({ discussionId: 'D_1', body: '你好' }))
  assert.equal(res.status, 401)
  assert.equal(JSON.parse(res.body).reason, 'UNAUTHORIZED')
  assert.equal(calls.filter((c) => c.what === 'addComment').length, 0)
})

test('POST /comment 登录后把 discussionId / body / replyToId 原样交给 writer', async () => {
  const calls = []
  const router = makeRouter({ token: true, calls })
  const res = await router.api(
    'comment',
    writeCtx({ discussionId: 'D_1', body: ' 有道理 ', replyToId: 'DC_parent' }),
  )
  assert.equal(res.status, 201)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.data.id, 'DC_kwDOtest')
  const seen = calls.find((c) => c.what === 'addComment')
  assert.equal(seen.input.discussionId, 'D_1')
  assert.equal(seen.input.replyToId, 'DC_parent')
})

test('POST /comment 缺 body → 400（不能发出一句空评论）', async () => {
  const router = makeRouter({ token: true })
  const res = await router.api('comment', writeCtx({ discussionId: 'D_1', body: '   ' }))
  assert.equal(res.status, 400)
})

test('POST /comment 不要求 application/json 之外的任何东西也照样被 CSRF 挡下', async () => {
  // 跨站表单只能发 simple request —— 没有 application/json 就不放行
  const router = makeRouter({ token: true })
  const res = await router.api('comment', ctx({ method: 'POST', contentType: 'text/plain', readBody: async () => '{}' }))
  assert.equal(res.status, 403)
})

test('GET /thread 未登录 → available:false 且带原因，不是空正文', async () => {
  const router = makeRouter({ token: false })
  const res = await router.api('thread', ctx({ query: { repo: 'a/b', number: '1' } }))
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body).data
  assert.equal(data.available, false)
  assert.equal(data.reason, 'TOKEN_REQUIRED')
})

test('GET /thread 登录后返回正文与评论', async () => {
  const calls = []
  const router = makeRouter({ token: true, calls })
  const res = await router.api('thread', ctx({ query: { repo: 'a/b', number: '3' } }))
  const data = JSON.parse(res.body).data
  assert.equal(data.available, true)
  assert.equal(data.discussion.body, '正文')
  assert.equal(data.comments.length, 1)
  assert.equal(calls.find((c) => c.what === 'thread').number, 3)
})

test('GET /thread 缺 repo 或缺 number → 400', async () => {
  const router = makeRouter({ token: true })
  assert.equal((await router.api('thread', ctx({ query: { number: '1' } }))).status, 400)
  assert.equal((await router.api('thread', ctx({ query: { repo: 'a/b' } }))).status, 400)
  assert.equal((await router.api('thread', ctx({ query: { repo: 'a/b', number: '0' } }))).status, 400)
})

test('GET /user 未登录也能读到资料 —— 作者页走 REST，不吃 GraphQL 配额', async () => {
  const router = makeRouter({ token: false })
  const res = await router.api('user', ctx({ query: { login: 'moyuqing-man' } }))
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body).data
  assert.equal(data.profile.found, true)
  assert.equal(data.profile.followers, 34)
  // 隐私字段一个都不该出现
  assert.doesNotMatch(JSON.stringify(data), /email|@qq\.com/)
})

test('GET /user 会把他名下的索引条目一起算出来', async () => {
  const list = makeList({
    items: [
      { ...card, owner: 'moyuqing-man' },
      { ...card, slug: 'other/x', owner: 'someone-else' },
    ],
    total: 2,
  })
  const router = makeRouter({ list })
  const res = await router.api('user', ctx({ query: { login: 'moyuqing-man' } }))
  const data = JSON.parse(res.body).data
  assert.equal(data.count, 1)
  assert.equal(data.plugins[0].owner, 'moyuqing-man')
})

test('GET /user 的 GitHub 查不到时 found:false，但索引条目不因此消失', async () => {
  const router = makeRouter({ list: makeList({ items: [{ ...card, owner: 'ghost' }] }) })
  const res = await router.api('user', ctx({ query: { login: 'ghost' } }))
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body).data
  assert.equal(data.profile.found, false)
  assert.equal(data.count, 1)
})

test('GET /user 缺 login → 400', async () => {
  const router = makeRouter()
  assert.equal((await router.api('user', ctx())).status, 400)
})

test('GET /plugins 默认用 smart 排序，并回传排序清单与类型统计', async () => {
  const calls = []
  const list = makeList({
    facets: { categories: [], kinds: [{ kind: 'plugin', label: { zh: '插件', en: 'Plugin' }, count: 1 }], archived: 0, withNpm: 1 },
  })
  const router = makeRouter({ list, calls })
  const res = await router.api('plugins', ctx())
  const body = JSON.parse(res.body)
  assert.equal(calls[0].options.sort, 'smart')
  assert.deepEqual(body.data.sorts, ['smart', 'stars', 'downloads', 'recent', 'name'])
  assert.equal(body.data.facets.kinds[0].kind, 'plugin')
})

test('GET /plugins 的 kind 过滤被透传（空值也照样透传，交给 service 判断）', async () => {
  const calls = []
  const router = makeRouter({ calls })
  await router.api('plugins', ctx({ query: { kind: 'framework' } }))
  assert.equal(calls[0].options.kind, 'framework')
})

test('GET /community/u/:login 页面渲染作者名、资料与索引条目', async () => {
  const list = makeList({ items: [{ ...card, owner: 'moyuqing-man' }] })
  const router = makeRouter({ list })
  const res = await router.page('u', ctx({ query: { login: 'moyuqing-man' }, wantsHtml: true }))
  assert.equal(res.status, 200)
  assert.match(res.body, /moyuqing-man/)
  assert.match(res.body, /示例用户/)
  assert.match(res.body, /AnonyJcy\/dsh-j-space/)
})

test('作者页在 GitHub 资料读不到时照样 200 —— 拿不到头像不该让整页 502', async () => {
  const calls = []
  const list = makeList({ items: [{ ...card, owner: 'ghost' }] })
  const router = makeRouter({ list, calls })
  const res = await router.page('u', ctx({ query: { login: 'ghost' }, wantsHtml: true }))
  assert.equal(res.status, 200)
  assert.match(res.body, /ghost/)
  // 索引里的条目仍然在
  assert.match(res.body, /AnonyJcy\/dsh-j-space/)
  assert.equal(calls.filter((c) => c.what === 'userProfile').length, 1)
})

test('GET /community/u 缺 login → 400', async () => {
  const router = makeRouter()
  const res = await router.page('u', ctx({ wantsHtml: true }))
  assert.equal(res.status, 400)
})

test('索引页默认显示「综合排序」的说明条，切到按 star 就收起来', async () => {
  const router = makeRouter({
    list: makeList({
      sort: 'smart',
      facets: { categories: [{ slug: 'ui', count: 1 }], kinds: [{ kind: 'plugin', label: { zh: '插件', en: 'Plugin' }, count: 1 }], archived: 0, withNpm: 1 },
    }),
  })
  const smart = await router.page('', ctx({ query: {}, wantsHtml: true }))
  assert.equal(smart.status, 200)
  assert.match(smart.body, /主题标签|topic:dsh-plugin|自我声明/)

  const byStars = await router.page('', ctx({ query: { sort: 'stars' }, wantsHtml: true }))
  assert.equal(byStars.status, 200)
  assert.doesNotMatch(byStars.body, /自我声明/)
})

test('索引页把作者名链到作者页，并且类型标签只在「不是普通插件」时出现', async () => {
  const plugin = { ...card, kind: 'plugin' }
  const framework = { ...card, slug: 'deepseek-ai/deepseek-harness', owner: 'deepseek-ai', kind: 'framework', name: 'deepseek-harness' }
  const router = makeRouter({ list: makeList({ items: [plugin, framework] }) })
  const res = await router.page('', ctx({ wantsHtml: true }))
  assert.match(res.body, /\/community\/u\?login=AnonyJcy/)
  assert.match(res.body, /框架本体/)
})
