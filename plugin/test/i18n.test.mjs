import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_LOCALE,
  LOCALES,
  htmlLang,
  localeFromAcceptLanguage,
  messageKeys,
  normalizeLocale,
  resolveLocale,
  t,
  translator,
} from '../lib/core/i18n.js'
import { renderDetail, renderError, renderIndex, renderLogin } from '../lib/core/render.js'
import { relativeTime } from '../lib/core/text.js'

/* ------------------------------- 语言判定 ------------------------------- */

test('normalizeLocale：把地区标签收敛成 zh / en，认不出返回 null', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh')
  assert.equal(normalizeLocale('zh-Hant-TW'), 'zh')
  assert.equal(normalizeLocale('ZH'), 'zh')
  assert.equal(normalizeLocale('en-US'), 'en')
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('ja'), null)
  assert.equal(normalizeLocale('*'), null)
  assert.equal(normalizeLocale(''), null)
  assert.equal(normalizeLocale(undefined), null)
})

test('Accept-Language：按 q 值排序，而不是按出现顺序', () => {
  // 顺序反着写、q 值才是真的 —— 直接取第一个词就会选错
  assert.equal(localeFromAcceptLanguage('en;q=0.8, zh;q=0.9'), 'zh')
  assert.equal(localeFromAcceptLanguage('zh;q=0.2, en;q=0.9'), 'en')
  assert.equal(localeFromAcceptLanguage('en-US,en;q=0.9,zh-CN;q=0.8'), 'en')
  assert.equal(localeFromAcceptLanguage('ja,ko;q=0.9,zh;q=0.5'), 'zh')
})

test('Accept-Language：认不出、为空、q=0 时都退到默认语言，且不抛错', () => {
  assert.equal(localeFromAcceptLanguage('ja,ko'), DEFAULT_LOCALE)
  assert.equal(localeFromAcceptLanguage(''), DEFAULT_LOCALE)
  assert.equal(localeFromAcceptLanguage(undefined), DEFAULT_LOCALE)
  assert.equal(localeFromAcceptLanguage('zh;q=0,en;q=0'), DEFAULT_LOCALE)
  assert.equal(localeFromAcceptLanguage('garbage;;;q=abc', 'en'), 'en')
})

test('resolveLocale：?lang= 压过 Accept-Language（用户点过切换就得算数）', () => {
  assert.equal(resolveLocale({ query: { lang: 'en' }, headers: { 'accept-language': 'zh-CN' } }), 'en')
  assert.equal(resolveLocale({ query: { lang: 'zh' }, headers: { 'accept-language': 'en-US' } }), 'zh')
  assert.equal(resolveLocale({ query: { lang: 'fr' }, headers: { 'accept-language': 'en-US' } }), 'en')
  assert.equal(resolveLocale({ query: {}, headers: { 'accept-language': 'en-US' } }), 'en')
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
  assert.equal(resolveLocale(), DEFAULT_LOCALE)
})

test('resolveLocale：也认 Headers 实例（不是只有普通对象）', () => {
  const headers = new Headers({ 'accept-language': 'en-GB,en;q=0.9' })
  assert.equal(resolveLocale({ query: {}, headers }), 'en')
})

/* --------------------------------- 文案 --------------------------------- */

test('t()：两种语言的 key 集合完全一致（漏翻一个就会在这里炸）', () => {
  const zh = messageKeys('zh').sort()
  const en = messageKeys('en').sort()
  const missingInEn = zh.filter((key) => !en.includes(key))
  const missingInZh = en.filter((key) => !zh.includes(key))
  assert.deepEqual(missingInEn, [], `en 里缺这些 key：${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `zh 里缺这些 key：${missingInZh.join(', ')}`)
  assert.ok(zh.length > 60, `文案量看起来太少了：${zh.length}`)
})

test('t()：占位符替换、缺参数保留原样、未知 key 返回 key 本身（永不抛错）', () => {
  assert.match(t('zh', 'error.pluginNotFound', { repo: 'a/b' }), /a\/b/)
  assert.match(t('en', 'error.pluginNotFound', { repo: 'a/b' }), /a\/b/)
  // 不传参数时占位符原样留着，而不是变成 undefined
  assert.match(t('en', 'index.titleQuery'), /\{query\}/)
  assert.equal(t('en', '这个.key.根本不存在'), '这个.key.根本不存在')
  // 认不出的语言退到默认语言
  assert.equal(t('ja', 'error.pageNotFound', { path: '/x' }), t('zh', 'error.pageNotFound', { path: '/x' }))
  assert.equal(translator(undefined)('index.all'), t(DEFAULT_LOCALE, 'index.all'))
})

test('htmlLang：跟着语言走，不是写死 zh-CN', () => {
  assert.equal(htmlLang('zh'), 'zh-CN')
  assert.equal(htmlLang('en'), 'en')
  assert.equal(htmlLang(undefined), 'zh-CN')
})

/* ------------------------------ 渲染出的页面 ------------------------------ */

const list = {
  query: '',
  category: '',
  sort: 'stars',
  page: 1,
  pages: 1,
  total: 1,
  knownTotal: 1,
  items: [
    {
      name: 'demo-plugin',
      owner: 'someone',
      repo: 'someone/demo-plugin',
      url: 'https://github.com/someone/demo-plugin',
      slug: 'someone/demo-plugin',
      stars: 12,
      downloads: 34,
      category: 'ui',
      categoryLabel: { en: 'UI', zh: '界面' },
      description: { en: 'A demo plugin', zh: '一个演示插件' },
      sources: ['github-topic'],
    },
  ],
  facets: { categories: [{ slug: 'ui', count: 1 }], archived: 0, withNpm: 0 },
  errors: [],
  stale: false,
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/

test('renderIndex：两种语言给出不同文案，且英文页里一个汉字都没有', () => {
  const zh = renderIndex({ list, origin: 'http://x', status: null, locale: 'zh' })
  const en = renderIndex({ list, origin: 'http://x', status: null, locale: 'en' })

  assert.match(zh, /DSH 插件社区/)
  assert.match(en, /DSH Plugin Community/)
  assert.match(en, /By category/)
  assert.match(en, /Search plugins/)

  // 英文页里不该混进中文界面文案（数据本身可以带中文，这里的数据是纯英文的）。
  // 语言切换器里那个「中文」是有意保留的 —— 语言名要用它自己的语言写，先摘掉再查。
  const enNoSwitcher = en.replace(/<ul class="chips lang"[\s\S]*?<\/ul>/, '')
  const stray = enNoSwitcher.search(HAN)
  assert.equal(
    stray,
    -1,
    `英文页里混进了汉字：${stray >= 0 ? enNoSwitcher.slice(Math.max(0, stray - 60), stray + 60) : ''}`,
  )
  assert.match(zh, HAN)
})

test('renderIndex：<html lang> 跟着语言走', () => {
  assert.match(renderIndex({ list, origin: 'http://x', locale: 'zh' }), /<html lang="zh-CN">/)
  assert.match(renderIndex({ list, origin: 'http://x', locale: 'en' }), /<html lang="en">/)
})

test('语言切换器：两种语言都能点，且链接带着 lang 与当前筛选条件', () => {
  const filtered = { ...list, query: 'abc', category: 'ui', sort: 'downloads' }
  const html = renderIndex({ list: filtered, origin: 'http://x', locale: 'en' })

  assert.match(html, /href="[^"]*lang=zh[^"]*"/)
  assert.match(html, /href="[^"]*lang=en[^"]*"/)
  // 切语言不能把搜索结果弄丢 —— 这是纯 <a> 方案最容易踩的坑
  assert.match(html, /lang=zh[^"]*q=abc|q=abc[^"]*lang=zh/)
  assert.match(html, /lang=zh[^"]*category=ui|category=ui[^"]*lang=zh/)
})

test('renderIndex：搜索表单把 lang 作为 hidden 一起提交（搜索后语言不能丢）', () => {
  const html = renderIndex({ list, origin: 'http://x', locale: 'en' })
  assert.match(html, /<input type="hidden" name="lang" value="en">/)
})

test('renderIndex：索引源报错时，两种语言各自的提示条都在', () => {
  const broken = { ...list, errors: [{ id: 'awesome', message: 'timeout' }], stale: true }
  const zh = renderIndex({ list: broken, origin: 'http://x', locale: 'zh' })
  const en = renderIndex({ list: broken, origin: 'http://x', locale: 'en' })
  assert.match(zh, /有索引源没取到数据/)
  assert.match(en, /Some index sources returned nothing/)
  assert.match(zh, /awesome（timeout）/)
})

/* ------------------------------- 详情 / 错误 ------------------------------- */

const detail = {
  card: {
    name: 'demo-plugin',
    owner: 'someone',
    repo: 'someone/demo-plugin',
    url: 'https://github.com/someone/demo-plugin',
    description: { en: 'A demo plugin', zh: '一个演示插件' },
    stars: 12,
    sources: ['github-topic'],
    capabilities: [],
    capabilityRedLines: [],
  },
  meta: { found: true, stars: 12, openIssues: 3, pushedAt: '2026-10-01T00:00:00Z', license: 'MIT' },
  issues: { available: true, items: [] },
  discussions: { available: false, reason: 'TOKEN_REQUIRED', message: '需要登录' },
}

test('renderDetail：英文版把「讨论读不到」如实说出来，并且时间也是英文', () => {
  const en = renderDetail({ detail, origin: 'http://x', status: null, locale: 'en' })
  assert.match(en, /Community discussions \(GitHub Discussions\)/)
  assert.match(en, /requires a GitHub sign-in/i)
  assert.match(en, /Known issues \(GitHub Issues\)/)
  assert.match(en, /Open issues/)
  // 相对时间也必须跟着语言走，不能一半英文一半「12 天前」
  assert.doesNotMatch(en, /天前|小时前|刚刚/)
  assert.match(en, /ago|just now/)
})

test('relativeTime：中英文各自的单位与复数', () => {
  const now = Date.parse('2026-10-13T00:00:00Z')
  assert.equal(relativeTime('2026-10-13T00:00:00Z', now), '刚刚')
  assert.equal(relativeTime('2026-10-13T00:00:00Z', now, 'en'), 'just now')
  assert.equal(relativeTime('2026-10-12T23:30:00Z', now, 'en'), '30 minutes ago')
  assert.equal(relativeTime('2026-10-12T23:30:00Z', now, 'zh'), '30 分钟前')
  assert.equal(relativeTime('2026-10-12T22:00:00Z', now, 'en'), '2 hours ago')
  assert.equal(relativeTime('2026-10-01T00:00:00Z', now, 'zh'), '12 天前')
  assert.equal(relativeTime('2026-10-01T00:00:00Z', now, 'en'), '12 days ago')
  // 英文要单复数正确，中文不加「s」
  assert.equal(relativeTime('2026-09-13T00:00:00Z', now, 'en'), '1 month ago')
  assert.equal(relativeTime('2025-10-01T00:00:00Z', now, 'en'), '1 year ago')
  assert.equal(relativeTime('garbage', now, 'en'), '—')
})

test('renderDetail：中文版保留原有板块名', () => {
  const zh = renderDetail({ detail, origin: 'http://x', status: null, locale: 'zh' })
  assert.match(zh, /已知问题（GitHub Issues）/)
  assert.match(zh, /社区讨论（GitHub Discussions）/)
  assert.match(zh, /← 回到插件索引/)
})

test('renderError：两种语言分别渲染，且请求编号总在', () => {
  const zh = renderError({ status: 404, reason: 'NOT_FOUND', message: '没有这个页面', origin: 'http://x', requestId: 'r-1', locale: 'zh' })
  const en = renderError({ status: 404, reason: 'NOT_FOUND', message: 'No such page', origin: 'http://x', requestId: 'r-1', locale: 'en' })
  assert.match(zh, /请求编号/)
  assert.match(en, /Request ID/)
  assert.ok(zh.includes('r-1') && en.includes('r-1'))
})

/* --------------------------------- 登录页 --------------------------------- */

const flow = {
  flowId: 'flow-1',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
}

test('renderLogin：两种语言都渲染验证码与自动刷新，且都没有 <script>', () => {
  for (const locale of LOCALES) {
    const html = renderLogin({ flow, status: null, origin: 'http://x', locale })
    assert.match(html, /ABCD-1234/)
    assert.match(html, /<meta http-equiv="refresh"/)
    assert.doesNotMatch(html, /<script/i)
    // 刷新地址必须把 flow 与 lang 都带上，否则轮询会掉线
    assert.match(html, /url=[^"]*flow=flow-1/)
    assert.match(html, /url=[^"]*lang=/)
  }
  assert.match(renderLogin({ flow, status: null, origin: 'http://x', locale: 'zh' }), /用 GitHub 登录/)
  assert.match(renderLogin({ flow, status: null, origin: 'http://x', locale: 'en' }), /Sign in with GitHub/)
})

test('renderLogin：还没配 clientId 时，两种语言的说明都不含 `**`（那是 markdown，不是纯文本）', () => {
  const error = { message: 'not configured', fields: [{ name: 'howto', value: 'step one\nstep two' }] }
  for (const locale of LOCALES) {
    const html = renderLogin({ flow: null, status: null, origin: 'http://x', error, locale })
    assert.doesNotMatch(html, /\*\*/)
    assert.match(html, /step one/)
  }
})

test('renderLogin：已登录时两种语言都显示「你已经登录」而不是继续轮询', () => {
  const signedIn = { authenticated: true, login: 'octocat', scopes: ['public_repo'] }
  const zh = renderLogin({ flow, status: signedIn, origin: 'http://x', locale: 'zh' })
  const en = renderLogin({ flow, status: signedIn, origin: 'http://x', locale: 'en' })
  assert.match(zh, /你已经是登录状态/)
  assert.match(en, /already signed in/)
  assert.doesNotMatch(zh, /http-equiv="refresh"/)
  assert.doesNotMatch(en, /http-equiv="refresh"/)
})

/* --------------------------------- 文档 --------------------------------- */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('两份 README 的章节数一致 —— 防止只更新一种语言', async () => {
  const zh = await readFile(join(packageRoot, 'README.md'), 'utf8')
  const en = await readFile(join(packageRoot, 'README.en.md'), 'utf8')
  const sections = (text) => (text.match(/^## /gm) || []).length

  assert.ok(sections(zh) >= 8, '中文 README 不该瘦成几行')
  assert.equal(
    sections(en),
    sections(zh),
    'README.md 与 README.en.md 的二级标题数量必须一致：往一边加章节就得往另一边也加',
  )
  assert.match(zh, /README\.en\.md/, '中文 README 要链到英文版')
  assert.match(en, /README\.md/, '英文 README 要链回中文版')
})

test('英文 README 会被发到 npm —— 不放 files 里等于白翻译', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('README.md'))
  assert.ok(pkg.files.includes('README.en.md'))
})
