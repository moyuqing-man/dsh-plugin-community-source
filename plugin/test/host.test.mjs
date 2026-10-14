import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject, Config } from '../lib/index.js'

const SEARCH_ITEM = {
  full_name: 'AnonyJcy/dsh-j-space',
  description: 'A panel plugin',
  stargazers_count: 4,
  open_issues_count: 0,
  pushed_at: '2026-10-12T00:00:00Z',
  archived: false,
  license: { spdx_id: 'MIT' },
  topics: ['dsh-plugin'],
}

function makeCtx() {
  const routes = []
  const effects = []
  const warnings = []
  return {
    logger: {
      info() {}, debug() {},
      warn: (message) => warnings.push(String(message)),
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { route.disposed = true }
      },
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    routes,
    effects,
    warnings,
  }
}

function makeReq({ method = 'GET', url = '/community', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3220', ...headers },
    socket: { remoteAddress, encrypted: false },
    on() {},
    destroy() {},
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(body) { this.body = body ?? '' },
  }
}

async function withStubbedFetch(fn) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('search/repositories')) {
      return new Response(
        JSON.stringify({ total_count: 1, incomplete_results: false, items: [SEARCH_ITEM] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('manifest：name / inject / Config 的形状就是 DSH 插件契约要求的', () => {
  assert.equal(name, 'dsh-plugin-community')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(Config.allowRemote, false)
  assert.deepEqual(Config.sources, ['github-topic', 'awesome'])
  assert.equal(Config.owner, 'moyuqing-man')
  assert.equal(Config.repo, 'dsh-plugin-community')
})

/*
 * 这两条是**真机跑出来的** bug 的回归测试，不是凭空补的覆盖率。
 * 它们守的东西用假 ctx 手写测试永远碰不到，因为假 ctx 是个普通对象，
 * 而真机上 `ctx` 是 cordis 的 Proxy、`Config` 会被加载器当成 Standard Schema 解析。
 */

test('Config 必须是 Standard Schema：真实加载器会调 Config[\'~standard\'].validate 后才挂载', () => {
  // 真机症状：Config 只是普通对象时，resolveConfig 里这句抛
  //   TypeError: Cannot read properties of undefined (reading 'validate')
  // 整个插件静默不激活，启动日志只留一行 `warning: 1 entry did not activate`，
  // 所有页面 404 —— 本地测试全绿也照样发不出去。
  const standard = Config['~standard']
  assert.ok(standard, "Config 上必须有 '~standard'，否则真实加载器读 .validate 时会抛")
  assert.equal(standard.version, 1)
  assert.equal(typeof standard.validate, 'function')

  // validate 拿到合法配置要原样放行
  const good = standard.validate({ owner: 'o', repo: 'r', sources: ['github-topic'] })
  assert.equal(good.value.owner, 'o')
  assert.equal(good.value.repo, 'r')

  // 拿到垃圾也不能抛 —— 配置写错一个字段不该让插件加载失败，应退化成默认值
  for (const bad of [undefined, null, 'nope', 42, [], { sources: 'not-an-array' }]) {
    const result = standard.validate(bad)
    assert.ok(result && typeof result === 'object', `validate(${JSON.stringify(bad)}) 应返回对象`)
    assert.equal(result.value.owner, Config.owner)
    assert.ok(Array.isArray(result.value.sources))
    assert.deepEqual(result.value.sources, Config.sources)
  }

  // 非枚举：不能污染 Object.keys（否则「patch 里的键必须与 Config 对得上」那条测试会被带偏），
  // 也不能被 { ...Config } 展开成一个配置项
  assert.ok(!Object.keys(Config).includes('~standard'))
  assert.equal({ ...Config }['~standard'], undefined)
})

test('ctx 是 Proxy、未 inject 的服务访问会抛错时，apply 不能因此挂掉', async () => {
  // 真机症状：cordis 的 ctx Proxy 对**没写进 inject 的服务名一律抛**
  //   Error: cannot get property "credentials" without inject
  // （app.asar 内 @deepseek-ai/cordis/lib/index.js:676 的 get 陷阱）
  // 于是过去写的 `ctx.credentials ?? null` 直接炸掉整个插件的激活。
  const inner = makeCtx()
  const ctx = new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver)
      // 未 inject 的普通 JSON 属性 —— 模仿真机，抛。
      if (['credentials', 'tools', 'slash'].includes(String(prop))) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  // get() 才是安全查询接口，真机上它同样对未注册服务返回 undefined（不抛）
  ctx.get = () => undefined

  let api = null
  await withStubbedFetch(async () => {
    api = apply(ctx, { sources: ['github-topic'], prewarm: false })
  })

  // 页面照常注册 —— 少两个可选服务不该拖垮核心能力
  assert.equal(ctx.routes.length, 4)
  // 可选服务退化到 null / 默认行为，而不是抛出去
  assert.equal(api.tokenStore.accessToken(), null)
  assert.equal(api.toolDefinitions.length, 4)
})

test('注册 4 条路由：两条 prefix 覆盖子路径，两条 exact 保证裸路径', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
  })

  const signatures = ctx.routes.map((r) => `${r.kind} ${r.path}`).sort()
  assert.deepEqual(signatures, [
    'exact /api/v1/community',
    'exact /community',
    'prefix /api/v1/community',
    'prefix /community',
  ])
  for (const route of ctx.routes) assert.equal(typeof route.handler, 'function')
})

test('apply 返回可用的调试面，并把 prewarm 挂进 effect', async () => {
  const ctx = makeCtx()
  let api = null
  await withStubbedFetch(async () => {
    api = apply(ctx, { sources: ['github-topic'], prewarm: false })
  })
  assert.equal(typeof api.router.api, 'function')
  assert.equal(typeof api.indexService.list, 'function')
  assert.deepEqual(ctx.effects.map((e) => e.label), [
    'dsh-plugin-community: routes',
    'dsh-plugin-community: prewarm',
  ])
})

test('effect 的 disposer 会把路由全部卸载', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
  })
  for (const { disposer } of ctx.effects) disposer?.()
  assert.deepEqual(ctx.routes.map((r) => r.disposed), [true, true, true, true])
})

test('allowRemote 默认关闭：非本机来源直接 403，并给出怎么打开', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
  })
  const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === '/community')
  const res = makeRes()
  await route.handler(makeReq({ remoteAddress: '203.0.113.5' }), res)

  assert.equal(res.statusCode, 403)
  const body = JSON.parse(res.body)
  assert.equal(body.reason, 'FORBIDDEN')
  assert.match(body.hint, /allowRemote/)
})

test('本机访问 /community：返回真正渲染出来的 HTML', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
    const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === '/community')
    const res = makeRes()
    await route.handler(makeReq({ url: '/community' }), res)

    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.match(res.body, /DSH 插件社区/)
    assert.match(res.body, /anonyjcy\/dsh-j-space/i)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })
})

test('prefix 路由能吃子路径：/api/v1/community/plugins 返回 JSON', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
    const route = ctx.routes.find((r) => r.kind === 'prefix' && r.path === '/api/v1/community')
    const res = makeRes()
    await route.handler(makeReq({ url: '/api/v1/community/plugins?perPage=5' }), res)

    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.data.items[0].slug, 'anonyjcy/dsh-j-space')
    assert.equal(body.data.perPage, 5)
  })
})

test('prefix 路由吃到未知子路径时给出 404 信封而不是崩', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
    const route = ctx.routes.find((r) => r.kind === 'prefix' && r.path === '/api/v1/community')
    const res = makeRes()
    await route.handler(makeReq({ url: '/api/v1/community/nope' }), res)
    assert.equal(res.statusCode, 404)
    assert.equal(JSON.parse(res.body).reason, 'NOT_FOUND')
  })
})

test('拿不到 webServer 时只告警、不抛错，但 Agent 工具照旧注册（少一个依赖不该拖垮另一个能力）', () => {
  const warnings = []
  const ctx = { logger: { warn: (m) => warnings.push(String(m)), info() {}, debug() {} }, effect() {} }
  const out = apply(ctx, { prewarm: false })
  // 以前这里断言 `undefined`（直接 return 掉）。改成返回 exposed() 是有意的：
  // webServer 只管页面，Agent 工具跟 HTTP 无关，不该跟着一起消失。
  assert.ok(out && typeof out === 'object', 'apply 仍应返回暴露对象')
  assert.equal(out.toolDefinitions.length, 4, 'Agent 工具定义必须照旧产出')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /webServer/)
})

test('allowRemote=true 时本机以外的来源也放行', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false, allowRemote: true })
    const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === '/community')
    const res = makeRes()
    await route.handler(makeReq({ remoteAddress: '192.168.1.20' }), res)
    assert.equal(res.statusCode, 200)
  })
})

test('IPv4-mapped 形式的回环地址也算本机', async () => {
  const ctx = makeCtx()
  await withStubbedFetch(async () => {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
    const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === '/community')
    const res = makeRes()
    await route.handler(makeReq({ remoteAddress: '::ffff:127.0.0.1' }), res)
    assert.equal(res.statusCode, 200)
  })
})

test('上游整个挂掉时，页面仍然渲染（显示索引源失败提示）而不是白屏', async () => {
  const ctx = makeCtx()
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('网络全断了') }
  try {
    apply(ctx, { sources: ['github-topic'], prewarm: false })
    const route = ctx.routes.find((r) => r.kind === 'exact' && r.path === '/community')
    const res = makeRes()
    await route.handler(makeReq({ url: '/community' }), res)

    assert.equal(res.statusCode, 200)
    assert.match(res.body, /DSH 插件社区/)
    assert.match(res.body, /有索引源没取到数据/)
  } finally {
    globalThis.fetch = original
  }
})
