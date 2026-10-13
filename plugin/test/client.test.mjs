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

async function boot() {
  const spec = await loadBundle()
  const moduleExports = spec.factory((name) => {
    if (name === 'react') return makeReact()
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

