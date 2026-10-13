/**
 * 写路径（M2）：GraphQL 三个 mutation。
 *
 * 这个文件里几乎所有复杂度都来自同一件事：**写操作是花钱的、也是要负责任的**。
 *
 * 1. **绝不硬重试**。GitHub 对内容创建有「≤80 次/分钟且 ≤500 次/小时」的限制，
 *    而且**网页操作、REST、GraphQL 全部计入同一份**；持续重试可能直接封掉整个
 *    integration。`http.js` 已经保证 POST 不重试（`idempotent = method === 'GET'`），
 *    这里再补一层：每次写之间强制隔 ≥1 秒，且**同内容 60 秒内不重复发**。
 * 2. **必须先解析 node ID**。`createDiscussion` 要的是 `repositoryId` 与 `categoryId`
 *    这两个 GraphQL node ID（形如 `R_kgDO…` / `DIC_kwDO…`），不是 `owner/repo` 字符串。
 *    这条顺序是死锁的：token → repository.id → discussionCategories.nodes[].id → createDiscussion。
 * 3. **失败要让用户看懂**。GraphQL 的报错藏在 200 响应的 `errors` 数组里，
 *    不解析就会出现「请求成功但没发出去」这种最坏情况。
 */

import { ApiError, Reason, badRequest, forbidden, notFound, rateLimited, upstreamFailed } from './errors.js'

export const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql'
export const GITHUB_API_VERSION = '2022-11-28'

/** 官方 best practice：mutative 请求间隔 ≥1 秒。这里留一点余量。 */
export const MIN_WRITE_INTERVAL_MS = 1_200
/** 同内容在这个窗口内再提交一次，直接返回上一次的结果，不再打 GitHub。 */
export const IDEMPOTENCY_WINDOW_MS = 60_000

export const REACTIONS = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES']

const REPO_QUERY = `
query CommunityRepo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    hasDiscussionsEnabled
    discussionCategories(first: 25) {
      nodes { id name slug isAnswerable }
    }
  }
  rateLimit { cost remaining resetAt }
}`.trim()

const CREATE_DISCUSSION = `
mutation CommunityCreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { id number title url createdAt }
  }
}`.trim()

const ADD_COMMENT = `
mutation CommunityAddComment($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) {
    comment { id url createdAt }
  }
}`.trim()

const ADD_REACTION = `
mutation CommunityAddReaction($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) {
    reaction { id content }
  }
}`.trim()

export function createWriter({
  http,
  cache,
  github,
  tokenStore,
  logger,
  config = {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minWriteIntervalMs = MIN_WRITE_INTERVAL_MS,
  idempotencyWindowMs = IDEMPOTENCY_WINDOW_MS,
} = {}) {
  const recent = new Map() // idempotency key -> { at, result }
  let lastWriteAt = 0

  const ownerRepo = () => ({
    owner: String(config.owner ?? '').trim(),
    name: String(config.repo ?? '').trim(),
  })

  function requireToken() {
    const token = tokenStore?.accessToken?.()
    if (!token) {
      throw new ApiError(401, Reason.UNAUTHORIZED, '这一步需要先登录 GitHub。点页面上的「用 GitHub 登录」就行。')
    }
    return token
  }

  /**
   * 写完帖子之后，讨论列表缓存就旧了。
   *
   * **只清讨论相关的键**：repository node ID 与分类 ID 是永久不变的，
   * 顺手把它一起清掉等于每发一次帖都白花一次配额。
   */
  function invalidate() {
    if (!cache?.keys || !cache?.delete) return
    for (const key of cache.keys()) {
      const k = String(key)
      if (k.startsWith('gh:discussions') || k.startsWith('gh:discussion:')) cache.delete(k)
    }
  }

  /** 写之前的统一门禁：登录态 + 限速 + 幂等。 */
  async function gate(key) {
    const token = requireToken()

    const hit = recent.get(key)
    if (hit && now() - hit.at < idempotencyWindowMs) {
      if (hit.promise) return { token, replayed: await hit.promise, deduped: true }
      return { token, replayed: hit.result, deduped: true }
    }

    const wait = minWriteIntervalMs - (now() - lastWriteAt)
    if (wait > 0) await sleep(wait)

    return { token, deduped: false }
  }

  function remember(key, value) {
    lastWriteAt = now()
    recent.set(key, { at: lastWriteAt, result: value })
    if (recent.size > 200) {
      const cutoff = now() - idempotencyWindowMs
      for (const [k, v] of recent) if (v.at < cutoff) recent.delete(k)
    }
  }

  /**
   * 打 GraphQL。**POST 一律不重试**（http 层的 idempotent 判定已经保证了这点，
   * 这里显式写出来是为了读代码的人一眼看见）。
   */
  async function graphql(query, variables, { label = '写操作' } = {}) {
    const token = requireToken()
    let response
    try {
      response = await http.json(GRAPHQL_ENDPOINT, {
        method: 'POST',
        retries: 0,
        resource: 'graphql',
        label,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
      })
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw upstreamFailed(`连不上 GitHub：${error?.message ?? error}`)
    }

    const payload = response.json ?? {}
    const errors = Array.isArray(payload.errors) ? payload.errors : []
    if (errors.length > 0) {
      const first = errors[0] ?? {}
      const type = String(first.type ?? '')
      const message = String(first.message ?? '')
      if (type === 'RATE_LIMITED' || /rate limit/i.test(message)) {
        throw rateLimited('GitHub 说写得太快了，等一会儿再试。', 60_000)
      }
      if (type === 'FORBIDDEN' || /not have permission|must have/i.test(message)) {
        throw forbidden(`GitHub 拒绝了这次写入：${message}`)
      }
      if (type === 'NOT_FOUND') throw notFound(`GitHub 找不到目标：${message}`)
      throw upstreamFailed(`GitHub 报错：${message || JSON.stringify(first)}`)
    }
    return payload.data ?? {}
  }

  /** 解析并缓存 repository node ID 与分类列表（ID 不会变，TTL 给得很长）。 */
  async function resolveRepository({ force = false } = {}) {
    const { owner, name } = ownerRepo()
    if (!owner || !name) throw badRequest('插件没有配置 owner/repo，不知道要往哪个仓库写。')

    const cacheKey = `gh:repo-node:${owner}/${name}`
    if (!force && cache?.peek) {
      const hit = cache.peek(cacheKey)
      if (hit.state === 'fresh' && hit.value) return hit.value
    }

    const data = await graphql(REPO_QUERY, { owner, name }, { label: '读取仓库 node ID' })
    const repository = data.repository
    if (!repository) throw notFound(`仓库 ${owner}/${name} 不存在或读不到（私有仓库？）。`)

    const node = {
      id: String(repository.id),
      owner,
      name,
      nameWithOwner: String(repository.nameWithOwner ?? `${owner}/${name}`),
      hasDiscussionsEnabled: Boolean(repository.hasDiscussionsEnabled),
      categories: (repository.discussionCategories?.nodes ?? []).map((c) => ({
        id: String(c.id),
        name: String(c.name),
        slug: String(c.slug),
        isAnswerable: Boolean(c.isAnswerable),
      })),
      fetchedAt: now(),
    }
    if (cache?.set) cache.set(`gh:repo-node:${owner}/${name}`, node, { ttlMs: 6 * 60 * 60_000 })
    return node
  }

  /** 按 slug 找分类；找不到就给出「这个仓库有哪些分类」的候选列表。 */
  async function resolveCategory(slug) {
    const repo = await resolveRepository()
    if (!repo.hasDiscussionsEnabled) {
      throw forbidden('这个仓库还没开启 Discussions。仓库管理员去 Settings → Features 勾上。')
    }
    const wanted = String(slug ?? '').trim().toLowerCase()
    if (!wanted) {
      const fallback = repo.categories[0]
      if (!fallback) throw notFound('这个仓库没有可用的讨论分类。')
      return { repo, category: fallback }
    }
    const found = repo.categories.find((c) => c.slug.toLowerCase() === wanted)
    if (found) return { repo, category: found }

    const available = repo.categories.map((c) => c.slug).join(', ') || '(空)'
    throw notFound(`这个仓库没有叫「${slug}」的讨论分类。可用的有：${available}`, [
      { name: 'availableCategories', value: repo.categories.map((c) => c.slug) },
    ])
  }

  async function createDiscussion({ title, body, categorySlug } = {}) {
    const cleanTitle = String(title ?? '').trim()
    const cleanBody = String(body ?? '').trim()
    if (!cleanTitle) throw badRequest('标题不能为空', ['title'])
    if (!cleanBody) throw badRequest('正文不能为空', ['body'])
    if (cleanTitle.length > 200) throw badRequest('标题太长了（最多 200 字符）', ['title'])

    const { repo, category } = await resolveCategory(categorySlug)
    // 去重键用**完整正文**而不是哈希：哈希撞了会导致用户以为发出去了、
    // 实际上拿到的是上一条帖的链接。写入本身被 1.2 秒的间隔限住，
    // 一分钟最多 50 次，所以这里存全文的内存上界是可控的。
    const key = `discussion:${repo.id}:${category.id}:${cleanTitle}\u0000${cleanBody}`

    const gated = await gate(key)
    if (gated.deduped) return { ...gated.replayed, deduped: true }

    const run = (async () => {
      const data = await graphql(
        CREATE_DISCUSSION,
        { repositoryId: repo.id, categoryId: category.id, title: cleanTitle, body: cleanBody },
        { label: '发讨论帖' },
      )
      const d = data.createDiscussion?.discussion
      if (!d) throw upstreamFailed('GitHub 没有返回新建的讨论帖。')
      return {
        id: String(d.id),
        number: Number(d.number),
        title: String(d.title ?? cleanTitle),
        url: String(d.url),
        createdAt: String(d.createdAt ?? new Date(now()).toISOString()),
        category: category.slug,
        repo: repo.nameWithOwner,
      }
    })()

    recent.set(key, { at: now(), promise: run })
    try {
      const result = await run
      remember(key, result)
      invalidate()
      return result
    } catch (error) {
      recent.delete(key)
      logger?.debug?.(`[community] 发帖失败：${error?.message ?? error}`)
      throw error
    }
  }

  async function addComment({ discussionId, body, replyToId } = {}) {
    const id = String(discussionId ?? '').trim()
    const cleanBody = String(body ?? '').trim()
    if (!id) throw badRequest('缺少 discussionId', ['discussionId'])
    if (!cleanBody) throw badRequest('评论不能为空', ['body'])

    const key = `comment:${id}:${replyToId ? String(replyToId) : '-'}:${cleanBody}`
    const gated = await gate(key)
    if (gated.deduped) return { ...gated.replayed, deduped: true }

    const run = (async () => {
      const data = await graphql(
        ADD_COMMENT,
        { discussionId: id, body: cleanBody, replyToId: replyToId ? String(replyToId) : null },
        { label: '发评论' },
      )
      const c = data.addDiscussionComment?.comment
      if (!c) throw upstreamFailed('GitHub 没有返回新建的评论。')
      return {
        id: String(c.id),
        url: String(c.url ?? ''),
        createdAt: String(c.createdAt ?? new Date(now()).toISOString()),
        replyToId: replyToId ? String(replyToId) : null,
      }
    })()

    recent.set(key, { at: now(), promise: run })
    try {
      const result = await run
      remember(key, result)
      invalidate()
      return result
    } catch (error) {
      recent.delete(key)
      throw error
    }
  }

  async function addReaction({ subjectId, content } = {}) {
    const id = String(subjectId ?? '').trim()
    const reaction = String(content ?? '').trim().toUpperCase()
    if (!id) throw badRequest('缺少 subjectId', ['subjectId'])
    if (!REACTIONS.includes(reaction)) {
      throw badRequest(`不支持的 reaction：${content}。可选：${REACTIONS.join(', ')}`, ['content'])
    }

    const key = `reaction:${id}:${reaction}`
    const gated = await gate(key)
    if (gated.deduped) return { ...gated.replayed, deduped: true }

    const run = (async () => {
      const data = await graphql(ADD_REACTION, { subjectId: id, content: reaction }, { label: '点赞' })
      const r = data.addReaction?.reaction
      if (!r) throw upstreamFailed('GitHub 没有返回 reaction 结果。')
      return { id: String(r.id), content: String(r.content ?? reaction) }
    })()

    recent.set(key, { at: now(), promise: run })
    try {
      const result = await run
      remember(key, result)
      return result
    } catch (error) {
      recent.delete(key)
      throw error
    }
  }

  return {
    createDiscussion,
    addComment,
    addReaction,
    resolveRepository,
    resolveCategory,
    requireToken,
    canWrite: () => Boolean(tokenStore?.accessToken?.()),
    stats: () => ({ lastWriteAt, recent: recent.size, minWriteIntervalMs }),
  }
}
