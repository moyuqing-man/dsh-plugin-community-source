/**
 * GitHub 元数据层。
 *
 * 配额现实（docs/08 实测）：未认证 60 请求/小时/IP，`search` 是独立桶只有 10/分钟，
 * 未认证 GraphQL 配额是 **0**。所以这一层的每条读路径都必须：
 *   1. 懒加载（只在插件详情页真的被打开时才拉）
 *   2. 长 TTL + stale 降级
 *   3. 能不用就不去用 —— 列表页只吃索引源，详情页才补元数据
 *
 * ⚠️ Discussions 的读也**必须走 GraphQL** —— POC-2 用对照实验确认过：
 *    `POST /repos/{o}/{r}/discussions` 返回 404 而 `/issues` 返回 401，
 *    REST 侧根本没有 discussions 接口。所以未登录时这一项只能是「不可用」而不是「空」。
 */

import { rateLimited, upstreamFailed } from './errors.js'
import { parseRepo } from './text.js'

const API = 'https://api.github.com'
const GRAPHQL_ENDPOINT = `${API}/graphql`

export const REPO_TTL = 30 * 60_000
export const ISSUES_TTL = 15 * 60_000

const DISCUSSIONS_QUERY = `query CommunityDiscussions($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    id
    hasDiscussionsEnabled
    discussionCategories(first: 25) { nodes { id name slug emoji } }
    discussions(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number
        title
        url
        createdAt
        updatedAt
        isAnswered
        author { login avatarUrl }
        category { name slug emoji }
        comments { totalCount }
        reactionGroups { content users { totalCount } }
      }
    }
  }
}`

export function createGithub({ http, cache, logger, getToken = () => null }) {
  function authHeaders() {
    const token = getToken()
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  function hasToken() {
    return Boolean(getToken())
  }

  async function repoMeta(repo, { force = false } = {}) {
    const full = parseRepo(repo)
    if (!full) return null
    const outcome = await cache.wrap(
      `gh:repo:${full.toLowerCase()}`,
      async () => {
        const response = await http.json(`${API}/repos/${full}`, {
          timeoutMs: 12_000,
          resource: 'core',
          accept: 'application/vnd.github+json',
          label: `仓库元数据 ${full}`,
        })
        if (response.status === 404) return { found: false }
        if (!response.ok) {
          throw upstreamFailed(`GitHub 仓库接口返回 ${response.status}`, { status: response.status })
        }
        const data = response.json ?? {}
        return {
          found: true,
          stars: Number(data.stargazers_count) || 0,
          openIssues: Number(data.open_issues_count) || 0,
          forks: Number(data.forks_count) || 0,
          pushedAt: data.pushed_at ?? null,
          archived: data.archived === true,
          license: data.license?.spdx_id ?? null,
          description: typeof data.description === 'string' ? data.description : '',
          homepage: data.homepage ?? null,
          topics: Array.isArray(data.topics) ? data.topics : [],
          defaultBranch: data.default_branch ?? null,
          hasDiscussions: data.has_discussions === true,
        }
      },
      { ttlMs: REPO_TTL, staleTtlMs: REPO_TTL * 24, force },
    )
    return outcome.value
  }

  async function issues(repo, { force = false, state = 'open', perPage = 10 } = {}) {
    const full = parseRepo(repo)
    if (!full) return { available: false, items: [], totalCount: 0 }
    const limit = Math.min(Math.max(Number(perPage) || 10, 1), 30)

    const outcome = await cache.wrap(
      `gh:issues:${full.toLowerCase()}:${state}:${limit}`,
      async () => {
        const url = `${API}/repos/${full}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`
        const response = await http.json(url, {
          timeoutMs: 12_000,
          resource: 'core',
          accept: 'application/vnd.github+json',
          label: `Issue 列表 ${full}`,
        })
        if (response.status === 404) return { available: false, items: [], totalCount: 0 }
        if (!response.ok) {
          throw upstreamFailed(`GitHub Issue 接口返回 ${response.status}`, { status: response.status })
        }
        const items = (Array.isArray(response.json) ? response.json : [])
          // GitHub 的 issues 接口会把 PR 混进来，必须剔掉
          .filter((item) => !item.pull_request)
          .map((item) => ({
            number: item.number,
            title: item.title,
            url: item.html_url,
            state: item.state,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            comments: item.comments ?? 0,
            labels: (Array.isArray(item.labels) ? item.labels : [])
              .map((l) => (typeof l === 'string' ? l : l?.name))
              .filter(Boolean),
            author: item.user?.login ?? null,
          }))
        return { available: true, items, totalCount: items.length }
      },
      { ttlMs: ISSUES_TTL, staleTtlMs: ISSUES_TTL * 24, force },
    )
    return outcome.value ?? { available: false, items: [], totalCount: 0 }
  }

  async function graphql(query, variables) {
    if (!hasToken()) return null
    const response = await http.json(GRAPHQL_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'content-type': 'application/json', ...authHeaders() },
      timeoutMs: 15_000,
      retries: 0, // 写操作/计点请求不做自动重试
      label: 'GraphQL 查询',
    })
    if (response.status === 401 || response.status === 403) {
      const remaining = response.headers?.get?.('x-ratelimit-remaining')
      if (remaining === '0') throw rateLimited('GraphQL 配额已用尽', 0)
      throw upstreamFailed(`GraphQL 返回 ${response.status}`, { status: response.status })
    }
    if (!response.ok) throw upstreamFailed(`GraphQL 返回 ${response.status}`, { status: response.status })
    const payload = response.json
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      throw upstreamFailed(payload.errors.map((e) => e.message).join('; '))
    }
    return payload?.data ?? null
  }

  async function discussions(repo, { force = false, first = 20 } = {}) {
    const full = parseRepo(repo)
    if (!full) return { available: false, reason: 'NOT_FOUND', items: [], totalCount: 0, categories: [] }
    if (!hasToken()) {
      return {
        available: false,
        reason: 'TOKEN_REQUIRED',
        message: '讨论列表需要登录 GitHub 后才能读取（未认证时 GraphQL 配额为 0）',
        items: [],
        totalCount: 0,
        categories: [],
      }
    }

    const [owner, name] = full.split('/')
    const limit = Math.min(Math.max(Number(first) || 20, 1), 50)
    const outcome = await cache.wrap(
      `gh:discussions:${full.toLowerCase()}:${limit}`,
      async () => {
        const data = await graphql(DISCUSSIONS_QUERY, { owner, name, first: limit })
        const repository = data?.repository
        if (!repository) return { available: false, reason: 'NOT_FOUND', items: [], totalCount: 0, categories: [] }
        if (repository.hasDiscussionsEnabled === false) {
          return { available: false, reason: 'NOT_ENABLED', items: [], totalCount: 0, categories: [] }
        }
        return {
          available: true,
          reason: null,
          repositoryId: repository.id,
          totalCount: repository.discussions?.totalCount ?? 0,
          categories: (repository.discussionCategories?.nodes ?? []).map((c) => ({
            id: c.id, name: c.name, slug: c.slug, emoji: c.emoji ?? null,
          })),
          items: (repository.discussions?.nodes ?? []).map((d) => ({
            number: d.number,
            title: d.title,
            url: d.url,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            answered: d.isAnswered === true,
            author: d.author?.login ?? null,
            avatarUrl: d.author?.avatarUrl ?? null,
            category: d.category
              ? { name: d.category.name, slug: d.category.slug, emoji: d.category.emoji ?? null }
              : null,
            comments: d.comments?.totalCount ?? 0,
            reactions: (d.reactionGroups ?? []).reduce((sum, g) => sum + (g.users?.totalCount ?? 0), 0),
          })),
        }
      },
      { ttlMs: 5 * 60_000, staleTtlMs: 6 * 3600_000, force },
    )
    return outcome.value
  }

  async function viewer() {
    if (!hasToken()) return null
    const response = await http.json(`${API}/user`, {
      headers: authHeaders(),
      timeoutMs: 10_000,
      resource: 'core',
      label: '当前用户',
    })
    if (!response.ok) return null
    const data = response.json ?? {}
    return {
      login: data.login,
      name: data.name ?? null,
      avatarUrl: data.avatar_url ?? null,
      htmlUrl: data.html_url ?? null,
    }
  }

  return { repoMeta, issues, discussions, viewer, hasToken, graphql }
}
