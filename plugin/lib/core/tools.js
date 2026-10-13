/**
 * M4 · 四个 Agent 工具
 *
 * 这些工具让 Agent 能「自己去找插件、自己去查社区、自己发帖」。
 * 它们的形状完全照抄 `dsh-find-plugins/lib/index.js`（已验证可用的实例）：
 *
 *   ctx.tools.register(defineTool({
 *     name, description,
 *     parameters: { key: { type, required?, description } },
 *     output: { schema, render: (args, value) => [{ type: 'text', text }] },
 *     execute: async (args) => value,
 *     timeoutMs,
 *   }))
 *
 * 这里**故意只用普通对象描述工具，不 import `@deepseek-ai/dsh-tools`**：
 * `defineTool` 在 dsh-find-plugins 里是静态 import 的，但本插件的红线是
 * 「`lib/` 不静态依赖任何 `@deepseek-ai/*`」，这样 host 半边才能用假 ctx 在本地全测。
 * 接线处（lib/index.js）会**尝试**拿真的 `defineTool`，拿不到就用恒等函数 ——
 * 两种情况下注册进去的定义是一样的。
 *
 * 三个跨工具的约定：
 * 1. **读不到要说读不到。** GitHub 未认证时 GraphQL 配额是 0，讨论就是读不到；
 *    返回空列表会让 Agent 得出「这个插件没人讨论」的错误结论。所以一律显式带
 *    `available` / `reason`。
 * 2. **写操作绝不说谎。** 没登录就返回 `ok:false` 加一句该怎么办的话，绝不假装成功。
 * 3. **工具的输出是给模型看的**，不是给终端看的：去掉 HTML、去掉装饰性字符、
 *    每条控制在一行内，并且**把「下一步能干什么」明确写出来**。
 */

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8

const oneLine = (value, max = 160) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const pickText = (description) => {
  if (!description) return ''
  if (typeof description === 'string') return description
  return description.zh || description.en || ''
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)))
}

/** 卡片 → 一行摘要 + 可选细节行。 */
function cardLines(card, { detail = false } = {}) {
  const lines = []
  const stars = card.stars === null || card.stars === undefined ? '?' : card.stars
  lines.push(`${card.repo}  ★${stars}${card.archived ? '  [已归档]' : ''}`)
  const desc = oneLine(pickText(card.description))
  if (desc) lines.push(`  用途：${desc}`)
  if (card.npm) lines.push(`  npm：${card.npm}`)
  if (detail) {
    if (card.install) lines.push(`  安装：${card.install}`)
    if (card.license) lines.push(`  许可证：${card.license}`)
    if (card.openIssues !== null && card.openIssues !== undefined) lines.push(`  未关 issue：${card.openIssues}`)
    if (card.pushedAt) lines.push(`  最近推送：${card.pushedAt}`)
    if (card.capabilityRedLines?.length) lines.push(`  ⚠️ ${card.capabilityRedLines.join('；')}`)
    if (card.capabilities?.length) lines.push(`  说明：${card.capabilities.slice(0, 4).join('；')}`)
    if (card.sources?.length) lines.push(`  索引来源：${card.sources.join(', ')}`)
  }
  return lines
}

const FOOTER =
  '索引数据来自第三方目录，会过期；装之前请自己看一眼源码，并固定版本。'

export function createToolDefinitions({ indexService, github, writer, auth, config }) {
  const communityUrl = `https://github.com/${config?.owner ?? ''}/${config?.repo ?? ''}`

  const requireLogin = () => {
    const ok = typeof auth?.configured === 'function' ? auth.configured() : false
    const loggedIn = typeof github?.hasToken === 'function' ? github.hasToken() : false
    if (loggedIn) return null
    return {
      ok: false,
      reason: 'NOT_LOGGED_IN',
      message: ok
        ? '这个动作需要先登录 GitHub。请在 DSH 的社区设置页（或 /community/login 页面）完成一次 8 位验证码登录。'
        : '这个动作需要登录 GitHub，但插件还没有配 clientId。请按 /community/login 页面上列出的步骤建一个 OAuth App（必须勾上 Enable Device Flow），把 Client ID 填进 cordis.patch.yml 的 config.clientId。',
      communityUrl,
    }
  }

  /* ------------------------------- 1. 搜索 ------------------------------- */

  const search = {
    name: 'community_search',
    description:
      '在 DSH 插件社区索引里搜索插件。索引聚合了多个社区目录（awesome-dsh-plugin、dsh.so、dsh.works、岚叔目录、GitHub 的 dsh-plugin topic），' +
      '并按 star / 下载量合并成统一卡片。用它回答「有没有插件能做 X」。\n\n' +
      'QUERY 用法：可以给多个空格分隔的词，**词多通常更好**。中英混写、写同义词都可以，' +
      '例如 `terminal 终端 tui`、`微信 通知 notification`、`截图 screenshot`。\n\n' +
      '注意：star 排序会把几个**恰好也打了 dsh-plugin 标签的大仓库**（例如框架本体）顶到前面，' +
      '这是标签自我声明的固有问题，不是查询出错。结果里带 `archived` 或「已归档」的不要推荐。',
    parameters: {
      query: { type: 'string', required: true, description: '要搜的能力，一个或多个空格分隔的词。' },
      category: { type: 'string', description: '可选的分类 slug（例如 ui / tools / memory）。' },
      sort: { type: 'string', description: '排序：stars（默认）/ downloads / name / recent。' },
      limit: { type: 'number', description: `返回条数，默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}。` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    timeoutMs: 120_000,
    execute: async (args) => {
      const list = await indexService.list({
        q: String(args.query ?? ''),
        category: String(args.category ?? ''),
        sort: ['stars', 'downloads', 'name', 'recent'].includes(String(args.sort)) ? String(args.sort) : 'stars',
        perPage: normalizeLimit(args.limit),
      })
      return {
        ok: true,
        query: String(args.query ?? ''),
        total: list.filteredTotal,
        items: (list.items ?? []).map((card) => ({
          repo: card.repo,
          name: card.name,
          description: oneLine(pickText(card.description), 200),
          stars: card.stars,
          npm: card.npm,
          install: card.install,
          archived: card.archived,
          category: card.category,
          sources: card.sources,
          communityUrl: `${communityUrl}/discussions`,
        })),
        sources: (list.sources ?? []).map((s) => ({ id: s.id, state: s.state, stale: s.stale })),
        errors: list.errors ?? [],
        footer: FOOTER,
      }
    },
  }

  /* ---------------------------- 2. 单个插件 ---------------------------- */

  const plugin = {
    name: 'community_plugin',
    description:
      '查一个插件在社区里的情况：索引卡片（star / 许可证 / 最近推送 / 归档状态）、GitHub 上的开放 issue、' +
      '以及社区讨论列表。\n\n' +
      'repo 与 pkg 二选一：`repo` 给 `owner/name`；只有 npm 包名时用 `pkg`（插件详情页里通常只有包名）。\n\n' +
      '**讨论列表在未登录时读不到**（GitHub 未认证的 GraphQL 配额是 0，REST 侧没有 discussions 接口）。' +
      '那时返回值里 `discussions.available` 是 false —— 这不等于「这个插件没有讨论」，别当成结论。',
    parameters: {
      repo: { type: 'string', description: '仓库坐标 owner/name。' },
      pkg: { type: 'string', description: 'npm 包名（只在没有 repo 时用）。' },
      discussionLimit: { type: 'number', description: `讨论条数，默认 ${DEFAULT_LIMIT}。` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderPlugin(value) }],
    },
    timeoutMs: 60_000,
    execute: async (args) => {
      const repo = String(args.repo ?? '').trim()
      const pkg = String(args.pkg ?? '').trim()
      if (!repo && !pkg) {
        return { ok: false, reason: 'BAD_INPUT', message: '必须给 repo（owner/name）或 pkg（npm 包名）其中之一。' }
      }

      let slug = repo
      if (!slug) {
        const list = await indexService.list({ q: pkg, perPage: 50, sort: 'stars' })
        const needle = pkg.toLowerCase()
        const hit = (list.items ?? []).find(
          (c) => String(c.npm ?? '').toLowerCase() === needle || String(c.name ?? '').toLowerCase() === needle,
        )
        if (!hit) {
          return { ok: false, reason: 'NOT_FOUND', message: `索引里找不到 npm 包 ${pkg}。可以先用 community_search 搜一下。` }
        }
        slug = hit.repo
      }

      const detail = await indexService.details(slug)
      if (!detail?.card) {
        return { ok: false, reason: 'NOT_FOUND', message: `索引里没有 ${slug}。这个仓库可能没打过 dsh-plugin 标签。` }
      }

      const card = detail.card
      const limit = normalizeLimit(args.discussionLimit)
      const [issues, discussions] = await Promise.all([
        github.issues(card.repo, { perPage: limit }).catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [] })),
        github.discussions({ first: limit }).catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [] })),
      ])

      return {
        ok: true,
        repo: card.repo,
        card: {
          name: card.name,
          description: oneLine(pickText(card.description), 400),
          stars: card.stars,
          npm: card.npm,
          install: card.install,
          license: card.license,
          archived: card.archived,
          pushedAt: card.pushedAt,
          openIssues: card.openIssues,
          capabilities: card.capabilities,
          warnings: card.capabilityRedLines,
          sources: card.sources,
        },
        issues: { available: issues.available !== false, items: (issues.items ?? []).slice(0, limit).map((i) => ({ number: i.number, title: oneLine(i.title), url: i.url })) },
        discussions,
        communityUrl: `${communityUrl}/discussions`,
      }
    },
  }

  /* ------------------------------ 3. 发帖 ------------------------------ */

  const post = {
    name: 'community_post',
    description:
      '在 DSH 插件社区里发一条讨论，或在已有讨论下发一条评论。**这会真的公开到 GitHub 上**，' +
      '所以：只在用户明确要求时用；发之前把标题和正文给用户看一眼。\n\n' +
      '必须已经登录 GitHub；没登录会返回 `ok:false` 并告诉你该怎么登录，不会假装成功。\n\n' +
      '重复保护：60 秒内提交完全相同的标题+正文，只会产生一条帖（返回里会带 `deduped: true`）。' +
      '写操作之间强制间隔 1.2 秒，且**永不自动重试**。',
    parameters: {
      title: { type: 'string', description: '讨论标题。给 discussionId 时不要传。' },
      body: { type: 'string', required: true, description: '正文（GitHub Flavored Markdown）。' },
      categorySlug: { type: 'string', description: '分类 slug，例如 ask-for-help / plugin-showcase / ideas / known-issues / general。默认 general。' },
      discussionId: { type: 'string', description: '给这个讨论发评论（GraphQL node id）。给了就不新建讨论。' },
      replyToId: { type: 'string', description: '回复某条评论（node id），只在发评论时有意义。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderPost(value) }],
    },
    timeoutMs: 60_000,
    execute: async (args) => {
      const gate = requireLogin()
      if (gate) return gate

      const body = String(args.body ?? '').trim()
      if (!body) return { ok: false, reason: 'BAD_INPUT', message: '正文不能为空。' }

      const discussionId = String(args.discussionId ?? '').trim()
      if (discussionId) {
        if (typeof writer.addComment !== 'function') {
          return { ok: false, reason: 'UNSUPPORTED', message: '这个版本还不支持评论。' }
        }
        const result = await writer.addComment({
          discussionId,
          body,
          replyToId: String(args.replyToId ?? '') || undefined,
        })
        return { ok: true, kind: 'comment', url: result.url ?? null, deduped: result.deduped === true, communityUrl }
      }

      const title = String(args.title ?? '').trim()
      if (!title) return { ok: false, reason: 'BAD_INPUT', message: '新建讨论必须给标题。' }

      const result = await writer.createDiscussion({
        title,
        body,
        categorySlug: String(args.categorySlug ?? 'general').trim() || 'general',
      })
      return {
        ok: true,
        kind: 'discussion',
        number: result.number,
        title: result.title,
        url: result.url,
        category: result.category,
        deduped: result.deduped === true,
      }
    },
  }

  /* ----------------------------- 4. 分诊 ----------------------------- */

  const triage = {
    name: 'community_triage',
    description:
      '看社区现在有什么待办：**没被标为答案的求助帖**、**没有回复的帖**、以及开放着的插件 issue。' +
      '用它回答「社区里有什么我能帮上的」。\n\n' +
      '求助列表需要登录才能读（未认证 GraphQL 配额为 0）；issue 列表未登录也能读（算 REST 的 60 次/小时）。' +
      '读不到的部分会显式标 `available: false`，不会伪装成「没有待办」。',
    parameters: {
      limit: { type: 'number', description: `每类最多几条，默认 ${DEFAULT_LIMIT}。` },
      repo: { type: 'string', description: '可选：只看某个插件的 open issue。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderTriage(value) }],
    },
    timeoutMs: 60_000,
    execute: async (args) => {
      const limit = normalizeLimit(args.limit)
      const repo = String(args.repo ?? '').trim()

      const discussions = await github
        .discussions({ first: Math.min(50, limit * 3) })
        .catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [] }))

      const unanswered = (discussions.items ?? []).filter((d) => d.isAnswered !== true).slice(0, limit)

      let issues = { available: false, reason: 'NO_REPO', message: '没给 repo，跳过 issue。', items: [] }
      if (repo) {
        issues = await github
          .issues(repo, { perPage: limit })
          .catch((error) => ({ available: false, reason: 'UPSTREAM_FAILED', message: String(error?.message ?? error), items: [] }))
      }

      const missing = []
      if (discussions.available === false) missing.push('讨论列表')
      if (repo && issues.available === false) missing.push('issue 列表')

      return {
        ok: true,
        repo: repo || null,
        unanswered: unanswered.map((d) => ({
          number: d.number,
          title: oneLine(d.title),
          category: d.category,
          url: d.url,
          comments: d.comments,
          updatedAt: d.updatedAt,
        })),
        discussionsAvailable: discussions.available !== false,
        discussionsReason: discussions.reason ?? null,
        issues: {
          available: issues.available !== false,
          items: (issues.items ?? []).slice(0, limit).map((i) => ({ number: i.number, title: oneLine(i.title), url: i.url, comments: i.comments })),
        },
        missing,
        communityUrl,
        footer: missing.length
          ? `注意：${missing.join('、')}这次没读到，返回的「没有」不代表真的没有。`
          : FOOTER,
      }
    },
  }

  return [search, plugin, post, triage]
}

/* ------------------------------- 文本渲染 ------------------------------- */

function renderSearch(value) {
  if (!value?.ok) return `搜索失败：${value?.message ?? '未知原因'}`
  const lines = [`搜「${value.query}」命中 ${value.total} 条，显示 ${value.items.length} 条：`]
  if (!value.items.length) {
    lines.push('（没有结果）换个说法再试，多给几个同义词通常比减少词更有效。')
  }
  value.items.forEach((item, i) => {
    lines.push('')
    lines.push(`${i + 1}. ${item.repo}  ★${item.stars ?? '?'}${item.archived ? '  [已归档]' : ''}`)
    if (item.description) lines.push(`   用途：${item.description}`)
    if (item.npm) lines.push(`   npm：${item.npm}`)
    if (item.install) lines.push(`   装它：${item.install}`)
    if (item.sources?.length) lines.push(`   来源：${item.sources.join(', ')}`)
  })
  if (value.errors?.length) {
    lines.push('')
    lines.push(`有 ${value.errors.length} 个索引源这次没取到：${value.errors.map((e) => e.id).join(', ')}`)
  }
  lines.push('')
  lines.push(value.footer)
  return lines.join('\n')
}

function renderPlugin(value) {
  if (!value?.ok) return `查不到：${value?.message ?? '未知原因'}`
  const lines = cardLines(
    {
      repo: value.card.repo ?? value.repo,
      name: value.card.name,
      description: value.card.description,
      stars: value.card.stars,
      npm: value.card.npm,
      install: value.card.install,
      license: value.card.license,
      archived: value.card.archived,
      pushedAt: value.card.pushedAt,
      openIssues: value.card.openIssues,
      capabilities: value.card.capabilities,
      capabilityRedLines: value.card.warnings,
      sources: value.card.sources,
    },
    { detail: true },
  )
  lines.push('')
  if (value.issues.available) {
    lines.push(`开放 issue（${value.issues.items.length} 条）：`)
    if (!value.issues.items.length) lines.push('  （没有）')
    for (const issue of value.issues.items) lines.push(`  #${issue.number} ${issue.title}`)
  } else {
    lines.push('开放 issue：这次没读到。')
  }
  lines.push('')
  if (value.discussions?.available === false) {
    lines.push(`讨论：读不到 —— ${value.discussions.message ?? '需要登录 GitHub。'}`)
    lines.push('  （「读不到」不等于「没有讨论」，别当成结论。）')
  } else {
    const items = value.discussions?.items ?? []
    lines.push(`社区讨论（${items.length} 条）：`)
    if (!items.length) lines.push('  （没有）')
    for (const d of items) lines.push(`  #${d.number ?? '?'} ${oneLine(d.title)}${d.isAnswered ? '  [已有答案]' : ''}`)
  }
  lines.push('')
  lines.push(`社区地址：${value.communityUrl}`)
  return lines.join('\n')
}

function renderPost(value) {
  if (!value?.ok) return `没能发出：${value.message}`
  if (value.kind === 'comment') {
    return `评论已发出${value.deduped ? '（重复提交，返回的是刚发的那条）' : ''}：${value.url ?? '(没有返回链接)'}`
  }
  return [
    `讨论已发出${value.deduped ? '（重复提交，返回的是刚发的那条）' : ''}：`,
    `#${value.number} ${value.title}`,
    value.url,
  ].join('\n')
}

function renderTriage(value) {
  if (!value?.ok) return `分诊失败：${value?.message ?? '未知原因'}`
  const lines = []
  if (!value.discussionsAvailable) {
    lines.push(`求助帖：读不到 —— ${value.discussionsReason === 'TOKEN_REQUIRED' ? '需要登录 GitHub 才能读讨论。' : '上游这次没取到。'}`)
  } else {
    lines.push(`没有答案的讨论（${value.unanswered.length} 条）：`)
    if (!value.unanswered.length) lines.push('  （都标了答案，或者确实没有新帖）')
    for (const d of value.unanswered) lines.push(`  #${d.number} ${d.title}${d.category ? `  [${d.category}]` : ''}`)
  }
  lines.push('')
  if (value.repo) {
    if (value.issues.available) {
      lines.push(`${value.repo} 的开放 issue（${value.issues.items.length} 条）：`)
      if (!value.issues.items.length) lines.push('  （没有）')
      for (const i of value.issues.items) lines.push(`  #${i.number} ${i.title}`)
    } else {
      lines.push(`${value.repo} 的开放 issue：这次没读到。`)
    }
  } else {
    lines.push('（没给 repo，跳过 issue 检查。想查某个插件的 issue 就带上 repo。）')
  }
  lines.push('')
  lines.push(value.footer)
  return lines.join('\n')
}
