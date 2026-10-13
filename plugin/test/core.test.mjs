import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, safeUrl, truncate, oneLine, formatCount, relativeTime, parseRepo, repoSlug, ownerOf } from '../lib/core/text.js'
import { createCard, mergeCards, applyCategories, normalizeDescription, SORTS, MAX_DESCRIPTION } from '../lib/core/normalize.js'
import { ApiError, Reason, badRequest, rateLimited, envelopeOf, envelope } from '../lib/core/errors.js'

test('escapeHtml 挡住全部五个危险字符', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;')
  assert.equal(escapeHtml(null), '')
})

test('safeUrl 只放行 http(s)', () => {
  assert.equal(safeUrl('javascript:alert(1)'), '')
  assert.equal(safeUrl('data:text/html,<script>'), '')
  assert.equal(safeUrl('  '), '')
  assert.equal(safeUrl('https://github.com/a/b?a=1&b=2'), 'https://github.com/a/b?a=1&amp;b=2')
})

test('truncate / oneLine', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(oneLine('  a\n\n b\tc  '), 'a b c')
  assert.equal(oneLine('x'.repeat(MAX_DESCRIPTION + 50), 10).length, 10)
})

test('formatCount 的口径', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1234), '1.2k')
  assert.equal(formatCount(12_345), '12k')
  assert.equal(formatCount(1_500_000), '1.5M')
  assert.equal(formatCount('nope'), '—')
})

test('relativeTime 用中文单位', () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  assert.equal(relativeTime('2026-10-13T09:00:00Z', now), '3 小时前')
  assert.equal(relativeTime('2026-10-11T12:00:00Z', now), '2 天前')
  assert.equal(relativeTime('not-a-date', now), '—')
})

test('parseRepo 认各种写法，但只认 github.com', () => {
  assert.equal(parseRepo('foo/bar'), 'foo/bar')
  assert.equal(parseRepo('https://github.com/foo/bar'), 'foo/bar')
  assert.equal(parseRepo('https://github.com/foo/bar/tree/main'), 'foo/bar')
  assert.equal(parseRepo('git+https://github.com/foo/bar.git'), 'foo/bar')
  assert.equal(parseRepo('github:foo/bar'), 'foo/bar')
  assert.equal(parseRepo('https://gitlab.com/foo/bar'), null)
  assert.equal(parseRepo('https://evil.com/github.com/foo/bar'), null)
  assert.equal(parseRepo(''), null)
  assert.equal(repoSlug('https://github.com/Foo/Bar'), 'foo/bar')
  assert.equal(ownerOf('foo/bar'), 'foo')
})

test('normalizeDescription 同时接受字符串与双语对象', () => {
  assert.deepEqual(normalizeDescription('hello'), { en: 'hello', zh: '' })
  assert.deepEqual(normalizeDescription({ en: 'a', zh: 'b' }), { en: 'a', zh: 'b' })
  assert.deepEqual(normalizeDescription(null), { en: '', zh: '' })
})

test('createCard 丢掉没有合法仓库坐标的条目', () => {
  assert.equal(createCard({ name: 'x' }, 'src'), null)
  assert.equal(createCard(null, 'src'), null)

  const card = createCard({ repo: 'Foo/Bar', description: { zh: '说明' }, stars: '12' }, 'awesome')
  assert.equal(card.slug, 'foo/bar')
  assert.equal(card.repo, 'Foo/Bar')
  assert.equal(card.owner, 'Foo')
  assert.equal(card.name, 'Bar')
  assert.equal(card.url, 'https://github.com/Foo/Bar')
  assert.equal(card.stars, 12)
  assert.deepEqual(card.sources, ['awesome'])
  assert.equal(card.archived, false)
})

test('mergeCards：数值取大、数组取并集、sources 累积', () => {
  const a = createCard({ repo: 'a/b', stars: 3, capabilities: ['x'], npm: 'p', archived: false }, 'one')
  const b = createCard({ repo: 'a/b', stars: 9, capabilities: ['y'], downloads: 5, archived: true }, 'two')
  const [merged] = mergeCards([a, b])

  assert.equal(merged.stars, 9)
  assert.equal(merged.downloads, 5)
  assert.equal(merged.npm, 'p')
  assert.equal(merged.archived, true)
  assert.deepEqual(merged.capabilities.sort(), ['x', 'y'])
  assert.deepEqual(merged.sources.sort(), ['one', 'two'])
  assert.equal(mergeCards([a, b]).length, 1)
})

test('mergeCards 保留 0 这类有效值', () => {
  const a = createCard({ repo: 'a/b', stars: 0 }, 'one')
  const b = createCard({ repo: 'a/b', stars: null }, 'two')
  assert.equal(mergeCards([a, b])[0].stars, 0)
})

test('applyCategories 补中英文标签', () => {
  const card = createCard({ repo: 'a/b', category: 'ui' }, 'awesome')
  const [out] = applyCategories([card], { ui: { en: 'UI', zh: '界面' } })
  assert.deepEqual(out.categoryLabel, { en: 'UI', zh: '界面' })
  const [unchanged] = applyCategories([card], {})
  assert.deepEqual(unchanged.categoryLabel, { en: '', zh: '' })
})

test('SORTS 可比较', () => {
  const a = { slug: 'a', stars: 1, downloads: 5, added: '2026-01-01' }
  const b = { slug: 'b', stars: 3, downloads: 2, added: '2026-02-01' }
  assert.deepEqual([a, b].sort(SORTS.stars).map((c) => c.slug), ['b', 'a'])
  assert.deepEqual([a, b].sort(SORTS.downloads).map((c) => c.slug), ['a', 'b'])
  assert.deepEqual([a, b].sort(SORTS.recent).map((c) => c.slug), ['b', 'a'])
  assert.deepEqual([a, b].sort(SORTS.name).map((c) => c.slug), ['a', 'b'])
})

test('错误信封形状与 dsh-workspace 一致', () => {
  const e = envelopeOf(badRequest('缺少 repo', [{ name: 'repo', value: null }]), 'req-1')
  assert.deepEqual(e, {
    status: 400,
    reason: Reason.BAD_REQUEST,
    message: '缺少 repo',
    fields: [{ name: 'repo', value: null }],
    requestId: 'req-1',
  })
  assert.equal(envelopeOf(new Error('炸了'), 'req-2').reason, Reason.INTERNAL)
  assert.equal(envelopeOf('字符串错误', 'req-3').status, 500)
})

test('rateLimited 带 retryAfterMs', () => {
  const e = rateLimited('配额没了', 1234)
  assert.ok(e instanceof ApiError)
  assert.equal(e.status, 429)
  assert.equal(e.reason, Reason.RATE_LIMITED)
  assert.equal(e.details.retryAfterMs, 1234)
  assert.deepEqual(e.fields, [{ name: 'retryAfterMs', value: 1234 }])
})

test('envelope 不带 requestId 时不加这个键', () => {
  assert.equal('requestId' in envelope(500, 'INTERNAL', 'x'), false)
})
