/**
 * client 半边（`lib/client.js`）的离线测试。
 *
 * 这个文件是个 `window.__ModuleLoader__.load({ id, factory })` bundle，
 * 在 Node 里没法直接 `import` 使用 —— 所以测试自己装一个假的
 * `window.__ModuleLoader__` 把 spec 截下来，再用假的 `require`/`ctx` 跑 `apply`。
 *
 * 这样能在**不启 DSH、不启浏览器**的前提下，把「注册了哪些座位、
 * 用的是什么 id / key / order」这类最容易写错、又最难在界面上发现的问题钉住。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url)
const HOST_TOOLS_PATH = new URL('../lib/core/tools.js', import.meta.url)

async function loadBundle() {
  let captured = null
  const previous = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  try {
    await import(`${CLIENT_PATH.href}?t=${Date.now()}-${Math.random()}`)
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
  assert.ok(captured, 'client bundle 必须调用 window.__ModuleLoader__.load')
  return captured
}

/** 只实现 client 半边用得到的那几件事：不引入真 React，避免测试依赖宿主。 */
function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
}

function makeHarness() {
  const registered = []
  const removed = []
  const injected = []
  const effects = []

  const slots = {
    inject(name, callback) {
      injected.push(name)
      return callback()
    },
    register(spec, Component) {
      registered.push({ spec, Component })
      return () => removed.push(spec)
    },
  }

  let slotsAvailable = true
  const ctx = {
    get(name) {
      if (name !== 'slots') return undefined
      return slotsAvailable ? slots : undefined
    },
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on() {
      return () => {}
    },
    provide() {
      return () => {}
    },
  }

  return {
    ctx,
    registered,
    removed,
    injected,
    effects,
    hideSlots() {
      slotsAvailable = false
    },
  }
}

async function boot(react) {
  const spec = await loadBundle()
  const moduleExports = spec.factory((name) => {
    if (name === 'react') return react || makeReact()
    throw new Error(`client 半边不应该 require ${name}`)
  })
  return { spec, moduleExports }
}

test('bundle 形状：id 与工厂返回值符合 __ModuleLoader__ 契约', async () => {
  const { spec, moduleExports } = await boot()
  assert.equal(spec.id, 'dsh-plugin-community')
  assert.equal(typeof spec.factory, 'function')
  assert.equal(typeof moduleExports.apply, 'function')
  assert.deepEqual(moduleExports.inject, ['slots'])
  assert.equal(Object.prototype.toString.call(moduleExports), '[object Module]')
})

test('client 半边只 require react —— 零运行时依赖的红线', async () => {
  const spec = await loadBundle()
  const asked = []
  spec.factory((name) => {
    asked.push(name)
    return makeReact()
  })
  assert.deepEqual(asked, ['react'])
})

test('注册十个座位（六个 list/keyed 界面座位 + 四个工具卡片），且 spec.name 与所注入的 slot 名一致', async () => {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)

  assert.deepEqual(
    harness.injected,
    [
      'sidebar.panellist',
      'main',
      'plugins.detail.section',
      'plugins.detail.badge',
      'settings.section',
      'shell.overlay',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
      'tool.call.toolview',
    ],
    '六个界面座位各一次，工具卡片座位按工具各一次，顺序稳定',
  )

  assert.equal(harness.registered.length, 10)
  for (const [index, entry] of harness.registered.entries()) {
    assert.equal(entry.spec.name, harness.injected[index], `${entry.spec.name} 的 name 要与 slot 名一致`)
    assert.equal(typeof entry.Component, 'function', `${entry.spec.name} 要有一个组件`)
  }
  assert.equal(harness.effects.length, 10, '每个座位都要包在 ctx.effect 里，卸载时才收得干净')
  assert.ok(
    harness.effects.every((label) => typeof label === 'string' && label.startsWith('dsh-plugin-community:')),
    'effect 标签要能一眼看出是本插件注册的',
  )
})

test('主面板 key 与侧栏 id 同名 —— 这是「点图标切面板」能自动成立的唯一条件', async () => {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)

  const byName = Object.fromEntries(harness.registered.map((entry) => [entry.spec.name, entry.spec]))
  assert.equal(byName['main'].key, 'community')
  assert.equal(byName['sidebar.panellist'].id, byName['main'].key)
  // main 是 keyed slot：只能带 key，不能带 id，否则语义就错了
  assert.equal(byName['main'].id, undefined)
  assert.equal(byName['sidebar.panellist'].order, 30)
  assert.equal(byName['plugins.detail.badge'].order, 20)
  assert.equal(byName['plugins.detail.section'].order, 40)
  assert.equal(byName['settings.section'].order, 45)
  assert.equal(byName['shell.overlay'].id, 'community-login')
})

test('label 是 thunk（catalog 要求：每次投影重读，语言切换不用重注册）', async () => {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)

  // main 是 keyed slot，注册面只有 `key` —— 它的标题由同名侧栏条目提供；
  // shell.overlay 是点击穿透的浮动层，没有可见标题；tool.call.toolview 同样是
  // keyed slot，key 是工具名，卡片标题由组件自己画。它们都不该带 label。
  // 其余四个 list slot 才是靠 label 显示的。
  const noLabel = new Set(['main', 'shell.overlay', 'tool.call.toolview'])
  for (const entry of harness.registered) {
    if (noLabel.has(entry.spec.name)) {
      assert.equal(entry.spec.label, undefined, `${entry.spec.name} 不该带 label`)
      continue
    }
    assert.equal(typeof entry.spec.label, 'function', `${entry.spec.name} 的 label 应该是函数`)
    assert.equal(typeof entry.spec.label(), 'string')
    assert.ok(entry.spec.label().length > 0)
  }
})

test('重复 apply 不会撞 id：两次 apply 各自注册一套，卸载各自回收', async () => {
  const { moduleExports } = await boot()
  const first = makeHarness()
  const second = makeHarness()
  moduleExports.apply(first.ctx)
  moduleExports.apply(second.ctx)
  assert.equal(first.registered.length, 10)
  assert.equal(second.registered.length, 10)
  assert.notEqual(first.registered[0].spec, second.registered[0].spec)
})

test('拿不到 slots 服务时不抛错，只报错并退场（旧版 DSH 上不能把界面搞崩）', async () => {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  harness.hideSlots()

  const originalError = console.error
  const logged = []
  console.error = (...args) => logged.push(args.join(' '))
  try {
    assert.doesNotThrow(() => moduleExports.apply(harness.ctx))
  } finally {
    console.error = originalError
  }

  assert.equal(harness.registered.length, 0)
  assert.equal(harness.effects.length, 0)
  assert.equal(logged.length, 1)
  assert.match(logged[0], /community/)
  assert.match(logged[0], /slots/)
})

test('侧栏图标与活动标签在没有 subject 时渲染 null，不占版面', async () => {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)

  const icon = harness.registered.find((entry) => entry.spec.name === 'sidebar.panellist').Component
  const badge = harness.registered.find((entry) => entry.spec.name === 'plugins.detail.badge').Component
  const section = harness.registered.find((entry) => entry.spec.name === 'plugins.detail.section').Component

  const iconTree = icon({ size: 18, active: false })
  assert.equal(iconTree.type, 'span')

  // 插件详情页可能不给 subject（或给的是没有包名的 subject）——
  // 这时必须渲染 null，而不是画一个空标签把标题挤乱。
  assert.equal(badge({ subject: null }), null)
  assert.equal(badge({ subject: { kind: 'bundle', pkg: {} } }), null)
  assert.equal(section({ subject: undefined }), null)
})

/** 把渲染树摊平成一维数组，方便在测试里找某个按钮。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) flatten(child, out)
  return out
}

test('界面语言可以手动覆盖，并且被记住', async () => {
  const wrote = []
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: (key, value) => wrote.push([key, String(value)]),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
  }
  try {
    const { moduleExports } = await boot()
    const harness = makeHarness()
    moduleExports.apply(harness.ctx)

    const Settings = harness.registered.find((entry) => entry.spec.name === 'settings.section').Component
    const buttonsOf = (tree) => flatten(tree).filter((node) => node.type === 'button')

    const before = buttonsOf(Settings({ close() {} }))
    const zh = before.find((node) => node.children.includes('中文'))
    const en = before.find((node) => node.children.includes('English'))
    assert.ok(zh && en, '设置页必须给出中英两个语言按钮')

    en.props.onClick()
    assert.deepEqual(wrote.at(-1), ['dsh-plugin-community:lang', 'en'])

    zh.props.onClick()
    assert.deepEqual(wrote.at(-1), ['dsh-plugin-community:lang', 'zh'])

    // 覆盖之后重新渲染，界面语言应该立刻跟着变，不必重开应用
    const after = buttonsOf(Settings({ close() {} })).find((node) => node.children.includes('中文'))
    assert.match(after.props.className, /primary/, '选中的语言要看得出来')
  } finally {
    delete globalThis.window
  }
})

/* ----------------------- 第 7 个座位：Agent 工具卡片 ----------------------- */

async function toolViews() {
  const { moduleExports } = await boot()
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)
  return harness.registered.filter((entry) => entry.spec.name === 'tool.call.toolview')
}

/**
 * 从 host 侧源码里抠出工具名。
 * 不是为了解析 JS —— 只是给「client 的 key」和「host 的工具名」找一个共同真源：
 * 对不上时宿主会**静默**回落到官方通用卡片，界面不报错、日志也不报错，
 * 所以只能靠这条断言盯着。
 */
async function hostToolNames() {
  const source = await readFile(HOST_TOOLS_PATH, 'utf8')
  return [...source.matchAll(/\bname: '(community_[a-z_]+)'/g)].map((match) => match[1])
}

/** 只取渲染树里的文本节点（假 React 的 children 里混着元素对象）。 */
function textsOf(node) {
  return flatten(node).flatMap((item) => (item.children || []).filter((child) => typeof child === 'string'))
}

/**
 * 把界面语言钉死在英文再跑。
 *
 * 不钉的话结果取决于跑测试这台机器的 `navigator.language` —— 本机是 zh-CN，
 * CI 上可能是 en-US，断言会随环境漂移。
 *
 * 必须在 `apply()` **之前**设好：`apply()` 自己会调一次 `text()`，
 * `currentLang()` 在那一刻就把语言缓存下来了（`langLoaded`），之后再改窗口也没用。
 */
async function withEnglish(fn) {
  globalThis.window = {
    localStorage: { getItem: () => 'en', setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
  }
  try {
    return await fn()
  } finally {
    delete globalThis.window
  }
}

test('工具卡片的 key 与 host 侧工具名一一对应 —— 对不上会静默回落，只有这条能发现', async () => {
  const views = await toolViews()
  const names = await hostToolNames()

  assert.equal(names.length, 4, 'host 侧应该正好注册四个 Agent 工具')
  assert.deepEqual(
    views.map((entry) => entry.spec.key).sort(),
    names.slice().sort(),
    'client 的座位 key 必须与 host 的工具 name 完全相同',
  )
  // keyed slot 只认 key：带 id 会注册不上去
  assert.ok(
    views.every((entry) => entry.spec.id === undefined && entry.spec.label === undefined),
    'keyed 座位只能带 key',
  )
})

test('工具卡片按 phase 渲染：preparing 无参数、start 有参数、result 有输出', async () => {
  await withEnglish(async () => {
    const [view] = await toolViews()
    const draw = (props) => textsOf(view.Component(props)).join(' | ')

    // preparing：类型上就没有 argsRaw，所以只该出现「正在准备」，不该编造参数
    const preparing = draw({ phase: 'preparing', block: { phase: 'preparing', callId: 'c1', name: 'community_search' } })
    assert.match(preparing, /Preparing arguments/)
    assert.doesNotMatch(preparing, /query/)

    // start：参数已经在手上（argsRaw 是模型给的 JSON 原文）
    const started = draw({
      phase: 'start',
      block: { phase: 'start', callId: 'c1', name: 'community_search', argsRaw: '{"query":"chat","limit":3}' },
    })
    assert.match(started, /query: chat/)
    assert.match(started, /limit: 3/)

    // 流式期间可能是半截 JSON —— 解析失败要退回原文，不能吞掉
    const half = draw({ phase: 'start', block: { phase: 'start', name: 'community_search', argsRaw: '{"query":"ch' } })
    assert.match(half, /"query":"ch/)

    // result：输出在 block.content（ContentBlock[]），文本块是 {type:'text', text}
    const done = draw({
      phase: 'result',
      block: {
        kind: 'tool-result',
        callId: 'c1',
        call: { name: 'community_search', argsRaw: '{"query":"chat"}' },
        content: [{ type: 'text', text: '找到 3 个插件' }],
        isError: false,
      },
    })
    assert.match(done, /找到 3 个插件/)
    assert.match(done, /query: chat/)
  })
})

test('工具卡片的两种坏情况：参数被窗口截断、工具报错', async () => {
  await withEnglish(async () => {
    const [view] = await toolViews()
    const draw = (props) => textsOf(view.Component(props)).join(' | ')

    // call: null = 结果还在、参数已被上下文窗口截断 —— 不能假装参数是空的
    const trimmed = draw({
      phase: 'result',
      block: { kind: 'tool-result', callId: 'c1', call: null, content: [{ type: 'text', text: 'ok' }], isError: false },
    })
    assert.match(trimmed, /Arguments were trimmed/)
    assert.match(trimmed, /ok/)

    const failed = draw({
      phase: 'result',
      block: {
        kind: 'tool-result',
        callId: 'c1',
        call: null,
        content: [],
        isError: true,
        error: { name: 'Error', code: 'E_HUB', reason: 'rate limited' },
      },
    })
    assert.match(failed, /⚠/)
    assert.match(failed, /rate limited/)
  })
})

test('工具卡片遇到不认识的形状也不抛错 —— 视图层不能把整条消息搞崩', async () => {
  const [view] = await toolViews()
  for (const props of [undefined, null, {}, { phase: 'result' }, { block: null }, { block: { content: '纯字符串' } }]) {
    assert.doesNotThrow(() => view.Component(props), `props=${JSON.stringify(props)} 时不该抛错`)
  }
  // 非文本内容块要被忽略而不是渲染成 [object Object]
  const weird = textsOf(view.Component({ phase: 'result', block: { content: [{ type: 'image', source: {} }, 42, null] } }))
  assert.doesNotMatch(weird.join(' '), /object Object/)
})

/* ------------------------- 交互界面：发帖 / 评论 / 点赞 ------------------------- */

/*
 * 上面那套 makeReact 只够验「注册了哪些座位」——它的 createElement 不调用子组件，
 * useState 是空壳。发帖、评论、点赞这些**要真的点一下才知道对不对**，
 * 所以这里再搭一个够用的迷你 React：真的存 state、真的跑 effect、
 * 真的把子组件渲染下去。
 *
 * 不引真 React 是有意的：本机 npm registry 不可达，而且 client 半边的红线就是
 * 「宿主给什么就用什么」——测试同样只依赖那个最小接口。
 */
function createUI() {
  const store = new Map()
  let current = null
  let counters = new Map()

  function slot() {
    if (!store.has(current.key)) store.set(current.key, [])
    return store.get(current.key)
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const slots = slot()
      const index = current.index++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = slots[index]
      return [
        cell.value,
        (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next
        },
      ]
    },
    useEffect(effect, deps) {
      const slots = slot()
      const index = current.index++
      const prev = slots[index]
      const changed =
        !prev ||
        !deps ||
        !prev.deps ||
        deps.length !== prev.deps.length ||
        deps.some((item, i) => item !== prev.deps[i])
      if (!prev) slots[index] = { deps, cleanup: null }
      else prev.deps = deps
      if (!changed) return
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const cleanup = effect()
      slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    },
  }

  function renderNode(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderNode).filter((child) => child !== null)
    if (typeof node.type === 'function') {
      const name = node.type.name || 'anon'
      const seen = counters.get(name) || 0
      counters.set(name, seen + 1)
      const previous = current
      current = { key: `${name}#${seen}`, index: 0 }
      let out
      try {
        out = node.type(node.props || {})
      } finally {
        current = previous
      }
      return renderNode(out)
    }
    return {
      type: node.type,
      props: node.props || {},
      children: (node.children || []).map(renderNode).filter((child) => child !== null),
    }
  }

  return {
    React,
    render(Component, props) {
      counters = new Map()
      return renderNode(React.createElement(Component, props || {}))
    },
  }
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node === 'string') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) findAll(child, predicate, out)
  return out
}

function allText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) allText(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  for (const child of node.children || []) allText(child, out)
  return out
}

const buttonByText = (tree, text) =>
  findAll(tree, (node) => node.type === 'button' && allText(node).join('').includes(text))[0]

/** 让 `useAsync` 的 promise 链跑完。 */
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * 假的 fetch：按「方法 + 去掉前缀的路径」查表，并记录每一次调用。
 * 表里给函数就是动态响应；给 `{__status}` 对象就是造一个失败响应。
 */
function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace('/api/v1/community', '').split('?')[0]
    const method = options.method || 'GET'
    calls.push({ method, path, body: options.body ? JSON.parse(String(options.body)) : null })
    const handler = routes[`${method} ${path}`]
    if (!handler) throw new Error(`测试没准备这条路：${method} ${path}`)
    const value = typeof handler === 'function' ? handler(calls.length) : handler
    if (value && value.__status) {
      return {
        ok: false,
        status: value.__status,
        json: async () => ({ ok: false, reason: value.reason, message: value.message || '失败了' }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: value }) }
  }
  return calls
}

async function withWindow(lang, fn) {
  const previousFetch = globalThis.fetch
  globalThis.window = {
    localStorage: { getItem: () => lang, setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
    location: { reload() {} },
  }
  try {
    return await fn()
  } finally {
    delete globalThis.window
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
}

/**
 * 起一个真的会响应点击的主面板。
 *
 * 关键点：`boot` 必须用**上面那个迷你 React**（`ui.React`）来造模块 ——
 * 用文件开头那个空壳 `makeReact()` 的话，`useState` 是死的、`useEffect` 不跑，
 * 点按钮什么都不会发生，测出来的「通过」是假的。
 */
async function panelWith(routes) {
  const ui = createUI()
  const { moduleExports } = await boot(ui.React)
  const harness = makeHarness()
  moduleExports.apply(harness.ctx)
  const Panel = harness.registered.find((entry) => entry.spec.name === 'main').Component
  const calls = mockFetch(routes)
  ui.render(Panel, {})
  await settle()
  const draw = () => ui.render(Panel, {})
  /*
   * 一次「渲染 → 等异步 → 再渲染」。
   *
   * 必须按这个顺序：请求是在**渲染时**的 effect 里发出去的，
   * 所以光 await 不会让新页签的数据出现 —— 得先画一次让它去请求，
   * 等回来再画一次才看得到内容。少了中间这一步，拿到的是加载中的空壳。
   */
  const refresh = async () => {
    draw()
    await settle()
    return draw()
  }
  return { Panel, ui, calls, draw, refresh, current: draw }
}

const BASE_ROUTES = {
  'GET /meta': { fullName: 'moyuqing-man/dsh-plugin-community' },
  'GET /plugins': { items: [], total: 0 },
}

test('面板：插件页与讨论页两个页签，未登录时讨论页给登录入口而不是空列表', async () => {
  await withWindow('en', async () => {
    const { draw } = await panelWith({
      ...BASE_ROUTES,
      'GET /me': { authenticated: false },
    })

    const tabs = findAll(draw(), (node) => node.type === 'button' && node.props.role === 'tab')
    assert.deepEqual(
      tabs.map((tab) => allText(tab).join('')),
      ['Plugins', 'Discussions'],
      '主面板必须把索引和讨论分成两个页签',
    )

    tabs[1].props.onClick()
    const after = draw()
    const text = allText(after).join(' ')
    assert.match(text, /need a GitHub sign-in|needs a GitHub sign-in|Sign in with GitHub/i)
    // 未登录不该画发帖按钮 —— 画了就是骗人
    assert.equal(buttonByText(after, 'New post'), undefined)
    const loginLink = findAll(
      after,
      (node) => node.type === 'a' && String(node.props.href || '').includes('/community/login'),
    )[0]
    assert.ok(loginLink, '未登录的讨论页必须给出登录入口')
  })
})

test('面板：登录后能发新帖，并且真的 POST 到 /discussion', async () => {
  await withWindow('en', async () => {
    const posted = []
    const { calls, draw, current, refresh } = await panelWith({
      ...BASE_ROUTES,
      'GET /me': { authenticated: true, login: 'moyuqing-man' },
      'GET /discussions': {
        available: true,
        items: [],
        totalCount: 0,
        categories: [{ slug: 'general', name: 'General', emoji: '💬' }],
      },
      'POST /discussion': (n) => {
        posted.push(n)
        return { id: 'D_1', number: 1, url: 'https://github.com/x/y/discussions/1' }
      },
    })

    const tab = findAll(current(), (node) => node.type === 'button' && node.props.role === 'tab')[1]
    tab.props.onClick()
    // 切页签只改了状态，**渲染才会去请求**；所以必须 draw → settle → draw 走一轮
    let tree = await refresh()

    const newPost = buttonByText(tree, 'New post')
    assert.ok(newPost, '登录后应该出现发帖按钮')
    newPost.props.onClick()
    tree = draw()

    const fields = findAll(tree, (node) => node.type === 'input' || node.type === 'textarea')
    assert.ok(fields.length >= 2, '发帖表单要有标题和正文两个框')
    fields[0].props.onChange({ target: { value: '我的第一个帖子' } })
    fields[1].props.onChange({ target: { value: '正文内容' } })

    tree = draw()
    const form = findAll(tree, (node) => node.type === 'form')[0]
    await form.props.onSubmit({ preventDefault() {} })
    await settle()
    tree = draw()

    assert.equal(posted.length, 1, '提交一次表单只该发一次帖')
    const call = calls.find((item) => item.method === 'POST' && item.path === '/discussion')
    assert.ok(call, '必须打到 /api/v1/community/discussion')
    assert.equal(call.body.title, '我的第一个帖子')
    assert.equal(call.body.body, '正文内容')
    assert.equal(call.body.category, 'general')
    // 发完给个回执，不然用户不知道成没成
    assert.match(allText(tree).join(' '), /Posted/)
  })
})

test('面板：点开一条讨论能看到正文与回复，回复框 POST 到 /comment', async () => {
  await withWindow('en', async () => {
    const { calls, draw, current, refresh } = await panelWith({
      ...BASE_ROUTES,
      'GET /me': { authenticated: true, login: 'moyuqing-man' },
      'GET /discussions': {
        available: true,
        items: [{ number: 7, title: '有人测过这个插件吗', author: 'alice', comments: 1 }],
        categories: [],
      },
      'GET /thread': {
        available: true,
        discussion: {
          id: 'D_7',
          number: 7,
          title: '有人测过这个插件吗',
          url: 'https://github.com/x/y/discussions/7',
          body: '我在 Android 上跑不起来。',
          author: 'alice',
          comments: 1,
          reactions: 2,
        },
        comments: [{ id: 'DC_1', body: '试试禁用原生模块。', author: 'bob', reactions: 0 }],
      },
      'POST /comment': { id: 'DC_2', url: 'https://github.com/x/y/discussions/7#c2' },
    })

    findAll(current(), (node) => node.type === 'button' && node.props.role === 'tab')[1].props.onClick()
    let tree = await refresh()

    const item = buttonByText(tree, '有人测过这个插件吗')
    assert.ok(item, '讨论列表要能点进去')
    item.props.onClick()
    tree = await refresh()

    const text = allText(tree).join(' ')
    assert.match(text, /我在 Android 上跑不起来/)
    assert.match(text, /试试禁用原生模块/)
    assert.match(text, /@alice/)

    const areas = findAll(tree, (node) => node.type === 'textarea')
    assert.ok(areas.length, '帖子里要有回复框')
    areas[areas.length - 1].props.onChange({ target: { value: '我这边也一样。' } })
    tree = draw()
    const form = findAll(tree, (node) => node.type === 'form').pop()
    await form.props.onSubmit({ preventDefault() {} })
    await settle()
    tree = draw()

    const call = calls.find((item) => item.method === 'POST' && item.path === '/comment')
    assert.ok(call, '回复必须打到 /api/v1/community/comment')
    assert.equal(call.body.discussionId, 'D_7')
    assert.equal(call.body.body, '我这边也一样。')
    assert.match(allText(tree).join(' '), /Reply sent/)
  })
})

test('面板：点赞发 /reaction；失败时按钮要退回去，界面不许说谎', async () => {
  await withWindow('en', async () => {
    const { calls, draw, current, refresh } = await panelWith({
      ...BASE_ROUTES,
      'GET /me': { authenticated: true, login: 'moyuqing-man' },
      'GET /discussions': { available: true, items: [{ number: 7, title: '一条讨论', author: 'alice', comments: 0 }], categories: [] },
      'GET /thread': {
        available: true,
        discussion: { id: 'D_7', number: 7, title: '一条讨论', url: 'https://github.com/x/y/discussions/7', body: '正文', author: 'alice', comments: 0, reactions: 0 },
        comments: [],
      },
      // 故意失败：点赞是「锦上添花」，失败不弹错，但绝不能显示成已赞
      'POST /reaction': { __status: 403, reason: 'FORBIDDEN', message: '没权限' },
    })

    findAll(current(), (node) => node.type === 'button' && node.props.role === 'tab')[1].props.onClick()
    buttonByText(await refresh(), '一条讨论').props.onClick()
    let tree = await refresh()

    const like = buttonByText(tree, 'Like')
    assert.ok(like, '帖子上要有点赞按钮')
    assert.equal(like.props['aria-pressed'], false)
    like.props.onClick()
    await settle()
    tree = draw()

    const call = calls.find((item) => item.method === 'POST' && item.path === '/reaction')
    assert.ok(call, '点赞要打到 /api/v1/community/reaction')
    assert.equal(call.body.content, 'THUMBS_UP')
    assert.equal(call.body.subjectId, 'D_7')
    // 请求失败了，按钮就得还是「未赞」——否则界面上会留下一个假的已赞状态
    const after = buttonByText(tree, 'Like')
    assert.ok(after, '失败后按钮要回到可再次点击的状态')
    assert.equal(after.props['aria-pressed'], false)
  })
})

test('面板：讨论列表还没回来就点发帖，分类晚到时也要能选到（不能冻住空分类）', async () => {
  await withWindow('en', async () => {
    const posted = []
    // 第一次 /discussions 故意慢 —— 模拟用户手快，在列表回来之前就点了「发新帖」
    const { calls, refresh, current, draw } = await panelWith({
      ...BASE_ROUTES,
      'GET /me': { authenticated: true, login: 'moyuqing-man' },
      'GET /discussions': (n) =>
        n === 1
          ? new Promise((resolve) => setTimeout(() => resolve({ available: true, items: [], categories: [] }), 5))
          : {
              available: true,
              items: [],
              categories: [
                { slug: 'general', name: 'General', emoji: '💬' },
                { slug: 'ideas', name: 'Ideas', emoji: '💡' },
              ],
            },
      'POST /discussion': (n) => {
        posted.push(n)
        return { id: 'D_9', number: 9, url: 'https://github.com/x/y/discussions/9' }
      },
    })

    findAll(current(), (node) => node.type === 'button' && node.props.role === 'tab')[1].props.onClick()
    // 第一次渲染时 /discussions 还没回来，但「发新帖」按钮已经在了
    draw()
    await settle()
    const early = draw()
    const newPost = buttonByText(early, 'New post')
    assert.ok(newPost, '列表没回来时也该能点发帖')
    newPost.props.onClick()
    let tree = draw()

    // 分类这时才到；重画之后下拉框必须已经有选项，而不是空白
    tree = await refresh()
    const options = findAll(tree, (node) => node.type === 'option')
    assert.ok(options.length >= 2, '分类晚到时表单也要列出可选分类')

    const fields = findAll(tree, (node) => node.type === 'input' || node.type === 'textarea')
    fields[0].props.onChange({ target: { value: '晚到的分类' } })
    fields[1].props.onChange({ target: { value: '正文' } })
    tree = draw()
    await findAll(tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
    await settle()

    assert.equal(posted.length, 1)
    const call = calls.find((item) => item.method === 'POST' && item.path === '/discussion')
    // 关键：没手动选过分类时，用**第一个真实存在的分类**，而不是空串
    assert.equal(call.body.category, 'general')
  })
})

test('面板：插件行把作者链到作者页，并且只有非普通插件才挂类型标签', async () => {
  await withWindow('en', async () => {
    const { draw } = await panelWith({
      'GET /meta': { fullName: 'moyuqing-man/dsh-plugin-community' },
      'GET /me': { authenticated: false },
      'GET /plugins': {
        items: [
          { slug: 'alice/dsh-hello', repo: 'alice/dsh-hello', name: 'dsh-hello', owner: 'alice', url: 'https://github.com/alice/dsh-hello', description: { en: 'says hi' }, stars: 12, kind: 'plugin' },
          { slug: 'deepseek-ai/deepseek-harness', repo: 'deepseek-ai/deepseek-harness', name: 'deepseek-harness', owner: 'deepseek-ai', url: 'https://github.com/deepseek-ai/deepseek-harness', description: { en: 'the framework' }, stars: 248000, kind: 'framework' },
        ],
      },
    })

    const tree = draw()
    const links = findAll(tree, (node) => node.type === 'a' && String(node.props.href || '').includes('/community/u'))
    assert.equal(links.length, 2, '每一条插件都要能点到作者页')
    assert.match(String(links[0].props.href), /login=alice/)

    const text = allText(tree).join(' ')
    assert.match(text, /Framework/, '框架本体要被标出来')
    // 普通插件不挂「Plugin」标签 —— 那是噪音，标签的用处是解释排序
    assert.equal(
      findAll(tree, (node) => node.type === 'span' && allText(node).join('') === 'Plugin').length,
      0,
    )
  })
})

