/**
 * M2 写路径的测试。
 *
 * 这里盯的是「会不会把用户的帖子发两遍」和「会不会被 GitHub 限流封掉」——
 * 两件事都不是靠读代码能确认的，必须拿假 HTTP 打一遍看请求数。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { GRAPHQL_ENDPOINT, REACTIONS, createWriter } from '../lib/core/write.js'
import { createCache } from '../lib/core/cache.js'

const REPO_DATA = {
  data: {
    repository: {
      id: 'R_kgDOabc',
      nameWithOwner: 'moyuqing-man/dsh-plugin-community',
      hasDiscussionsEnabled: true,
      discussionCategories: {
        nodes: [
          { id: 'DIC_ask', name: '🙋 求助', slug: 'ask-for-help', isAnswerable: true },
          { id: 'DIC_ideas', name: '💡 想法', slug: 'ideas', isAnswerable: false },
        ],
      },
    },
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-10-13T01:00:00Z' },
  },
}

const discussionPayload = (over = {}) => ({
  data: {
    createDiscussion: {
      discussion: {
        id: 'D_kwDOnew',
        number: 7,
        title: '求助：装了之后起不来',
        url: 'https://github.com/moyuqing-man/dsh-plugin-community/discussions/7',
        createdAt: '2026-10-13T00:00:00Z',
        ...over,
      },
    },
  },
})

function setup({ script = [], token = 'FAKE-TOKEN-A' } = {}) {
  const calls = []
  const queue = [...script]
  const clock = { t: 1_000_000 }
  const sleeps = []

  const http = {
    calls,
    async json(url, options = {}) {
      calls.push({ url, options })
      const reply = queue.shift()
      if (reply instanceof Error) throw reply
      if (reply === undefined) throw new Error(`测试脚本用完了：${url}`)
      return { ok: true, status: 200, headers: new Headers(), text: '', url, durationMs: 1, json: reply }
    },
  }

  const tokenStore = {
    accessToken: () => token,
    publicView: () => ({ authenticated: Boolean(token) }),
  }

  const cache = createCache({})
  const writer = createWriter({
    http,
    cache,
    github: {},
    tokenStore,
    logger: { debug() {} },
    config: { owner: 'moyuqing-man', repo: 'dsh-plugin-community' },
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock.t += ms
    },
  })

  return { writer, http, cache, clock, sleeps }
}

const graphqlVariables = (call) => JSON.parse(call.options.body).variables

test('未登录 → 401，且一次 GitHub 请求都不发', async () => {
  const { writer, http } = setup({ token: null })
  await assert.rejects(
    () => writer.createDiscussion({ title: 't', body: 'b' }),
    (error) => error.status === 401 && error.reason === 'UNAUTHORIZED',
  )
  assert.equal(http.calls.length, 0)
})

test('发帖：先把 owner/repo 换成 node ID，再发 mutation', async () => {
  const { writer, http } = setup({ script: [REPO_DATA, discussionPayload()] })
  const created = await writer.createDiscussion({
    title: '求助：装了之后起不来',
    body: '正文',
    categorySlug: 'ask-for-help',
  })

  assert.equal(http.calls.length, 2)
  assert.equal(http.calls[0].url, GRAPHQL_ENDPOINT)
  // 第一次是解析 node ID，变量里是 owner/name
  assert.deepEqual(graphqlVariables(http.calls[0]), { owner: 'moyuqing-man', name: 'dsh-plugin-community' })

  // 第二次才是 createDiscussion，变量里是 node ID 而不是 owner/repo
  const vars = graphqlVariables(http.calls[1])
  assert.equal(vars.repositoryId, 'R_kgDOabc')
  assert.equal(vars.categoryId, 'DIC_ask')
  assert.equal(vars.title, '求助：装了之后起不来')
  assert.equal(vars.body, '正文')
  assert.match(JSON.parse(http.calls[1].options.body).query, /createDiscussion/)

  assert.equal(created.number, 7)
  assert.match(created.url, /discussions\/7$/)
  assert.equal(created.category, 'ask-for-help')
})

test('写操作一律 retries:0（绝不硬重试，否则可能被封 integration）', async () => {
  const { writer, http } = setup({ script: [REPO_DATA, discussionPayload()] })
  await writer.createDiscussion({ title: 't', body: 'b' })
  for (const call of http.calls) {
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.retries, 0)
  }
  assert.match(http.calls[1].options.headers.authorization, /^Bearer /)
})

test('幂等：同样的标题正文 60 秒内再提交一次，不会发第二条帖', async () => {
  const { writer, http } = setup({ script: [REPO_DATA, discussionPayload()] })
  const first = await writer.createDiscussion({ title: 't', body: 'b' })
  const second = await writer.createDiscussion({ title: 't', body: 'b' })

  assert.equal(http.calls.length, 2, '重复提交应该被本地拦下')
  assert.equal(second.deduped, true)
  assert.equal(second.number, first.number)
})

test('幂等：只差空白字符算同一条帖（正文会被 trim，避免手抖重复提交）', async () => {
  const { writer, http } = setup({ script: [REPO_DATA, discussionPayload()] })
  const first = await writer.createDiscussion({ title: 't', body: 'b' })
  const second = await writer.createDiscussion({ title: 't', body: '  b\n' })
  assert.equal(http.calls.length, 2)
  assert.equal(second.deduped, true)
  assert.equal(second.number, first.number)
})

test('幂等：正文不一样就是两条帖，不能误判成重复', async () => {
  const { writer, http } = setup({ script: [REPO_DATA, discussionPayload(), discussionPayload({ id: 'D_2', number: 8 })] })
  await writer.createDiscussion({ title: 't', body: 'b' })
  const second = await writer.createDiscussion({ title: 't', body: 'b2' })
  assert.equal(http.calls.length, 3)
  assert.equal(second.number, 8)
  assert.notEqual(second.deduped, true)
  assert.equal(http.calls.filter((c) => /createDiscussion/.test(c.options.body ?? '')).length, 2)
})

test('限速：两次不同的写之间强制隔够 minWriteIntervalMs，且只 sleep 一次', async () => {
  const { writer, http, sleeps, clock } = setup({
    script: [REPO_DATA, discussionPayload(), discussionPayload({ id: 'D_2', number: 8 })],
  })
  await writer.createDiscussion({ title: 't1', body: 'b1' })
  assert.deepEqual(sleeps, [], '第一次写之前不该 sleep（很久没写过了）')

  const before = clock.t
  await writer.createDiscussion({ title: 't2', body: 'b2' })
  assert.equal(sleeps.length, 1)
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 1_200, `sleep 时长不合理：${sleeps[0]}`)
  assert.equal(clock.t - before, sleeps[0])
  assert.equal(http.calls.length, 3)
})

test('repository node ID 会被缓存：第二次发帖不再重复解析', async () => {
  const { writer, http, cache } = setup({
    script: [REPO_DATA, discussionPayload(), discussionPayload({ id: 'D_2', number: 8 })],
  })
  await writer.createDiscussion({ title: 't1', body: 'b1' })
  assert.equal(cache.peek('gh:repo-node:moyuqing-man/dsh-plugin-community').state, 'fresh')

  await writer.createDiscussion({ title: 't2', body: 'b2' })
  assert.equal(http.calls.length, 3, '第二次发帖不该再解析一次 node ID')
})

test('写完帖子会清讨论缓存，但**不会**把 node ID 缓存一起清掉', async () => {
  const { writer, cache } = setup({ script: [REPO_DATA, discussionPayload()] })
  cache.set('gh:discussions:moyuqing-man/dsh-plugin-community', { a: 1 }, { ttlMs: 60_000 })
  cache.set('source:awesome', { a: 2 }, { ttlMs: 60_000 })
  await writer.createDiscussion({ title: 't', body: 'b' })

  assert.equal(cache.peek('gh:discussions:moyuqing-man/dsh-plugin-community').state, 'miss')
  assert.equal(cache.peek('gh:repo-node:moyuqing-man/dsh-plugin-community').state, 'fresh')
  assert.equal(cache.peek('source:awesome').state, 'fresh')
})

test('分类 slug 不存在 → 404，并把可用分类列出来', async () => {
  const { writer, http } = setup({ script: [REPO_DATA] })
  await assert.rejects(
    () => writer.createDiscussion({ title: 't', body: 'b', categorySlug: 'nope' }),
    (error) => {
      assert.equal(error.status, 404)
      assert.match(error.message, /ask-for-help/)
      assert.deepEqual(error.fields.find((f) => f.name === 'availableCategories')?.value, ['ask-for-help', 'ideas'])
      return true
    },
  )
  assert.equal(http.calls.length, 1, '分类都不对就不该去发帖')
})

test('仓库没开 Discussions → 403 且告诉管理员怎么开', async () => {
  const off = {
    data: {
      repository: {
        id: 'R_1',
        nameWithOwner: 'a/b',
        hasDiscussionsEnabled: false,
        discussionCategories: { nodes: [] },
      },
    },
  }
  const { writer } = setup({ script: [off] })
  await assert.rejects(
    () => writer.createDiscussion({ title: 't', body: 'b' }),
    (error) => error.status === 403 && /Settings/.test(error.message),
  )
})

test('仓库不存在 → 404', async () => {
  const { writer } = setup({ script: [{ data: { repository: null } }] })
  await assert.rejects(
    () => writer.resolveRepository(),
    (error) => error.status === 404,
  )
})

test('GraphQL 把错误藏在 200 里：RATE_LIMITED → 429，FORBIDDEN → 403', async () => {
  const limited = setup({
    script: [REPO_DATA, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }],
  })
  await assert.rejects(
    () => limited.writer.createDiscussion({ title: 't', body: 'b' }),
    (error) => error.status === 429 && error.reason === 'RATE_LIMITED',
  )

  const denied = setup({
    script: [REPO_DATA, { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }],
  })
  await assert.rejects(
    () => denied.writer.createDiscussion({ title: 't', body: 'b' }),
    (error) => error.status === 403,
  )
})

test('GraphQL 返回了没见过的错误也必须显式失败，不能假装成功', async () => {
  const { writer } = setup({ script: [REPO_DATA, { errors: [{ type: 'WEIRD', message: '???' }] }] })
  await assert.rejects(() => writer.createDiscussion({ title: 't', body: 'b' }), (error) => error.status >= 500)
})

test('addComment：评论与嵌套回复', async () => {
  const reply = {
    data: { addDiscussionComment: { comment: { id: 'DC_1', url: 'https://github.com/x#discussioncomment-1', createdAt: '2026-10-13T00:00:00Z' } } },
  }
  const { writer, http } = setup({ script: [reply] })
  const comment = await writer.addComment({ discussionId: 'D_1', body: '试试把日志打开' })

  assert.equal(http.calls.length, 1)
  const vars = graphqlVariables(http.calls[0])
  assert.equal(vars.discussionId, 'D_1')
  assert.equal(vars.replyToId, null)
  assert.equal(comment.id, 'DC_1')

  const nested = setup({
    script: [
      { data: { addDiscussionComment: { comment: { id: 'DC_2', url: 'u', createdAt: '2026-10-13T00:00:00Z' } } } },
    ],
  })
  await nested.writer.addComment({ discussionId: 'D_1', body: '回复', replyToId: 'DC_1' })
  assert.equal(graphqlVariables(nested.http.calls[0]).replyToId, 'DC_1')
})

test('addReaction：只接受 GitHub 认得的那 8 种', async () => {
  const { writer, http } = setup({ script: [{ data: { addReaction: { reaction: { id: 'R_1', content: 'THUMBS_UP' } } } }] })
  const result = await writer.addReaction({ subjectId: 'D_1', content: 'thumbs_up' })
  assert.equal(result.content, 'THUMBS_UP')
  assert.equal(graphqlVariables(http.calls[0]).content, 'THUMBS_UP')

  const bad = setup({ script: [] })
  await assert.rejects(
    () => bad.writer.addReaction({ subjectId: 'D_1', content: 'SHRUG' }),
    (error) => error.status === 400,
  )
  assert.equal(bad.http.calls.length, 0)
  assert.equal(REACTIONS.length, 8)
})

test('canWrite / stats：给界面看的状态', async () => {
  const { writer } = setup({ script: [REPO_DATA, discussionPayload()] })
  assert.equal(writer.canWrite(), true)
  await writer.createDiscussion({ title: 't', body: 'b' })
  assert.equal(writer.stats().recent, 1)

  const anon = setup({ token: null })
  assert.equal(anon.writer.canWrite(), false)
})
