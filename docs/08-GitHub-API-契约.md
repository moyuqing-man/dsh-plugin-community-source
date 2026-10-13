# 08 · GitHub API 契约（实测）

> 本文件记录**实际调 API 验证过**的 GitHub 能力边界。
> 每条都标注了验证方式：✅ **本次实测**（附真实返回值）｜📄 官方文档原文。
>
> **为什么单独建一份**：社区的全部后端都在 GitHub 上。「哪些能免登录读、哪些必须要 token、限额卡在哪」直接决定缓存策略、登录时机与整体架构。这些是一手实测值，不是推断。

---

## 1. 最重要的一条结论（且它推翻了一个常见误解）

**GitHub Discussions 有 REST 读接口，而且完全免登录。**

| 操作 | 接口 | 免登录 |
|---|---|---|
| **列讨论** | `GET /repos/{owner}/{repo}/discussions` | ✅ **实测 200** |
| **读单个讨论** | `GET /repos/{owner}/{repo}/discussions/{number}` | ✅ **实测 200** |
| **读讨论的评论** | `GET /repos/{owner}/{repo}/discussions/{number}/comments` | ✅ **实测 200** |
| 建讨论 | `POST /repos/{owner}/{repo}/discussions` | ❌ 实测 **404** |
| 发评论 | `POST /repos/{owner}/{repo}/discussions/{n}/comments` | ❌ 实测 **404** |
| 改讨论 | `PATCH /repos/{owner}/{repo}/discussions/{n}` | ❌ 实测 **404** |
| 替换讨论 | `PUT /repos/{owner}/{repo}/discussions/{n}` | ❌ 实测 **404** |
| 删讨论 | `DELETE /repos/{owner}/{repo}/discussions/{n}` | ❌ 实测 **404** |
| 列分类 | `GET /repos/{owner}/{repo}/discussions/categories` | ❌ 实测 **404**（分类只能走 GraphQL） |

**所以架构上是一条干净的切分：**

> **读 = REST + 免登录；写 = GraphQL + 必须 token。**

这条结论的意义：

1. **[04](04-身份与登录.md) 的「匿名可读」是成立的**，而且不需要任何变通手段（不需要静态快照、不需要服务端代理）。
2. 常见的「读 Discussions 必须 GraphQL，而 GraphQL 必须登录」这个说法**是错的**——它把「写」的限制误推广到了「读」。
3. 社区在**未登录状态**下就能展示论坛内容，搜索引擎也能索引公开仓库的 Discussion 页面。

> ✅ **这个判定已被对照实验钉死，不再是推断**（POC-2 完成）。
>
> 关键判据：**未认证时，「端点存在但需要鉴权」返回 `401`，「端点不存在」才返回 `404`。** 用一组已知端点做夹逼：
>
> | 未认证请求 | 结果 | 角色 |
> |---|---|---|
> | `POST` `/repos/giscus/giscus/issues` | **401** `{"message":"Requires authentication"}` | 对照组 A —— 端点确实存在、需鉴权 |
> | `PATCH` `/repos/giscus/giscus/issues/1` | **401** | 对照组 A2 —— 换一个方法，依然 401 |
> | `POST` `/repos/giscus/giscus/discussions` | **404** `{"message":"Not Found"}` | 待判定 |
> | `POST` `/repos/giscus/giscus/discussions/1/comments` | **404** `{"message":"Not Found"}` | 待判定 |
> | `PATCH` `/repos/giscus/giscus/discussions/1` | **404** `{"message":"Not Found"}` | 待判定 |
> | `PUT` `/repos/giscus/giscus/discussions/1` | **404** `{"message":"Not Found"}` | 待判定 |
> | `DELETE` `/repos/giscus/giscus/discussions/1` | **404** `{"message":"Not Found"}` | 待判定 |
> | `POST` `/repos/giscus/giscus/nonexistent-xyz-123` | **404** `{"message":"Not Found"}` | 对照组 B —— 端点不存在 |
>
> **对照组拿到 401，而 discussions 的三个写方法全是 404** —— 行为相反 → **REST 整族不提供 discussions 写接口**（不只是 `POST` 缺失）。这也解释了为什么 `read:discussion` / `write:discussion` 从来不是 OAuth scope（§4.1）：那套名字属于 GitHub App permission，与这条 REST 路径无关。
>
> ⚠️ 排除掉一个可能的误判来源：**同仓库的 `GET /repos/giscus/giscus/discussions` 实测返回 200**（POC-0），所以 `404` 不是「仓库没开 Discussions」导致的。
>
> 📌 **这个判定不需要 token**，任何人在未登录状态下都能复现（见 `poc/run.mjs` 的 `probe`，已包含该对照实验）。

---

## 2. 免登录（未认证）能读什么

### 2.1 限额实测

`GET https://api.github.com/rate_limit`（未带任何凭据）：

```json
{
  "core":                 { "limit": 60,   "remaining": 51, "used": 9 },
  "search":               { "limit": 10,   "remaining": 10, "used": 0 },
  "code_search":          { "limit": 60,   "remaining": 51, "used": 9 },
  "graphql":              { "limit": 0,    "remaining": 0,  "used": 0 },
  "integration_manifest": { "limit": 5000, "remaining": 5000, "used": 0 }
}
```

**关键读数：**

| 项 | 值 | 说明 |
|---|---|---|
| REST core | **60 / 小时，按来源 IP** | 📄 注意是 **按 IP**，不是按用户、按应用 |
| search | **10 / 分钟** | 比 core 更严，插件广场的排行榜走这条路要格外省 |
| **graphql** | **0** | ✅ **未认证时 GraphQL 配额就是 0** —— 必须认证 |
| 认证后 core | **5,000 / 小时** | PAT / OAuth App / GitHub App user token **共享同一池** |
| `GET /rate_limit` | **不消耗配额** | ✅ 实测连续两次查询 `remaining` 差值为 **0** → 这是**免费的预算探针** |

> **按 IP 计费意味着**：公司、学校、家庭 NAT 后面多个用户会共用这 60 次。缓存不是优化项，是必需品。
>
> **`/rate_limit` 免费**这一点很有用：插件可以在每次批量请求前先探一次预算，超阈值就降级为纯缓存渲染，而**不需要为了「检查自己还剩多少额度」再花掉额度**。这应当成为配额调速器的标准动作。

### 2.2 免登录可读的数据（全部 ✅ 实测 200）

| 数据 | 接口 | 示例值（`octocat/Hello-World`） |
|---|---|---|
| 仓库元数据 | `GET /repos/{owner}/{repo}` | `stargazers_count 3843`、`forks_count 7085`、`subscribers_count 1736`、`open_issues_count 7442` |
| 最近提交时间 | `GET /repos/{o}/{r}/commits?per_page=1` | `commit.committer.date 2012-03-06T23:06:50Z` |
| 版本 | `GET /repos/{o}/{r}/releases?per_page=1` | `[]` ← **没有 release 时返回空数组，不报错** |
| 讨论列表 | `GET /repos/{o}/{r}/discussions` | 见 2.3 |
| 是否开了 Discussions | 仓库对象里的 `has_discussions` 布尔字段 | `giscus/giscus` → `true` |
| 贡献者 / 语言 | `/contributors`、`/languages` | ✅ |
| 按 topic 搜索 | `GET /search/repositories?q=topic:dsh-plugin&sort=stars` | ✅ |

**可用的免登录元数据字段**：`archived`、`disabled`、`license`、`topics`、`default_branch`、`created_at`、`updated_at`、`pushed_at`、`subscribers_count`、`forks_count`、`has_discussions`、`open_issues_count`。

> ⚠️ **坑：`open_issues_count` 包含 PR。** 要得到「纯 issue 数」需要减去 PR 数，或改用 search API。

### 2.3 Discussions 实测返回的完整字段

`GET /repos/giscus/giscus/discussions?per_page=2` → **200**，数组，每条包含：

```
repository_url, category, answer_html_url, answer_chosen_at, answer_chosen_by,
html_url, id, node_id, number, title, user, labels, state, state_reason,
locked, comments, created_at, updated_at, author_association,
active_lock_reason, body, reactions, timeline_url
```

实测样例（节选）：

```json
{
  "number": 62,
  "title": "Welcome to giscus!",
  "state": "open",
  "state_reason": null,
  "comments": 1686,
  "created_at": "2021-05-14T22:53:53Z",
  "html_url": "https://github.com/giscus/giscus/discussions/62",
  "category": {
    "id": 32796575,
    "name": "General",
    "slug": "general",
    "emoji": ":speech_balloon:",
    "is_answerable": false
  }
}
```

**这批字段直接够用了：**

| 社区要的功能 | 对应字段 | 判定 |
|---|---|---|
| 标题 / 正文 | `title` / `body` | ✅ 直接拿 |
| 作者 | `user` | ✅ 直接拿 |
| 是否已解决 | `answer_chosen_at` / `answer_html_url` / `answer_chosen_by` | ✅ **「已解决」徽章免登录可判** |
| 版块（板块） | `category.name` / `category.slug` / `category.emoji` | ✅ category 直接内联在每条讨论里 |
| 热度 | `comments`（评论数）/ `reactions` | ✅ |
| 收录时间排序 | `created_at` / `updated_at` | ✅ |
| 作者身份（是否维护者） | `author_association` | ✅ **能直接标「作者回复」「维护者」** |
| 帖子是否可答 | `category.is_answerable` | ✅ **建帖时可用它做校验** |
| 状态 | `state`（open/closed）/ `state_reason` | ✅ |

单条详情 `GET .../discussions/62` → 200，字段同上（`body` 是完整正文，实测长度 108）。

评论 `GET .../discussions/62/comments?per_page=1` → 200，每条字段：

```
id, node_id, html_url, parent_id, child_comment_count, repository_url,
discussion_id, author_association, user, created_at, updated_at, body, reactions
```

> **`parent_id` + `child_comment_count` 说明 GitHub 已支持嵌套回复**，社区可以直接渲染二级评论。

---

## 3. 必须有 token 才能做的

| 能力 | 原因 |
|---|---|
| **一切写操作**（建讨论、发评论、投票 reaction） | 需要用户身份 |
| **一切 GraphQL 操作** | ✅ 实测未认证配额为 **0** |
| **读讨论分类列表** | `GET .../discussions/categories` 实测 **404** → 分类只能走 GraphQL `Repository.discussionCategories` |
| **突破 60 /小时/IP** | 认证后 5,000/hr |
| 读私有仓库的讨论 | 公开仓库免登录即可 |

> **重要**：建帖必须带 `categoryId`，而分类只能从 GraphQL 拿。所以**发帖这条路径一定需要 token**（这也合理——发帖本来就要登录）。分类 ID 可以在登录后取一次并长期缓存。

### 3.1 GraphQL 写路径的完整契约（📄 官方文档逐字核实）

来源：[Using the GraphQL API for Discussions](https://raw.githubusercontent.com/github/docs/main/content/graphql/guides/using-the-graphql-api-for-discussions.md)（GitHub 官方文档仓库的原始 markdown，不带网页壳）。

**官方原文对 scope 的表述**：

> Access tokens require the `repo` scope for private repositories and the `public_repo` scope for public repositories.

✅ **这一句直接确认了 §4.2 的结论**：公开仓库只需 `public_repo`，全程没出现过 `read:discussion` / `write:discussion`。

**`createDiscussion`** —— 输入字段（官方逐条列出，无遗漏）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `repositoryId` | `ID!` | 仓库的 **node ID**（不是 `owner/name`） |
| `categoryId` | `ID!` | `DiscussionCategory` 的 node ID |
| `title` | `String!` | 标题 |
| `body` | `String!` | 正文（Markdown） |
| `clientMutationId` | `String` | 可选，追踪/幂等用 |

返回：`CreateDiscussionPayload { clientMutationId: String, discussion: Discussion }`

```graphql
mutation {
  createDiscussion(input: {
    repositoryId: "R_kgDO…", categoryId: "DIC_kwDO…",
    title: "标题", body: "正文"
  }) { discussion { id number url } }
}
```

**`addDiscussionComment`**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `discussionId` | `ID!` | 讨论的 node ID |
| `body` | `String!` | 评论正文 |
| `replyToId` | `ID` | **填了就变成嵌套回复**，不填是顶层评论 |
| `clientMutationId` | `String` | 可选 |

返回：`{ comment: DiscussionComment }`

> ⚠️ **关键细节**：两个写 mutation 要的都是 **node ID**（形如 `R_kgDO…` / `DIC_kwDO…`），不是 `owner/name`，也不是讨论的 `number`。而 `repositoryId` **未认证拿不到**（GraphQL 配额 = 0）——
> 所以写路径的顺序被锁死为：**token → 查 `repository.id` → 查 `discussionCategories.nodes[].id` → `createDiscussion`**。

**其余已核实的 mutation**：`updateDiscussion`、`deleteDiscussion`、`updateDiscussionComment`、`deleteDiscussionComment`、`markDiscussionCommentAsAnswer`、`unmarkDiscussionCommentAsAnswer`。

**查询字段**：

- `Repository.discussionCategories(first:)` —— 每仓库**最多 25 个分类**
- `Repository.discussionCategories` 拿到的 `DiscussionCategory` 有 `id` `name` `emoji` `emojiHTML` `description` `isAnswerable`
- `Repository.discussion(number: Int!)`
- `Repository.discussions(categoryId:, answered:, orderBy:{field,direction})`
- ⚠️ 官方文档把 `Repository.discussions` 的返回类型写成 `: Discussion`，**这是文档笔误**——实际是 `DiscussionConnection`（文档自己的示例就在用 `edges` / `nodes` / `totalCount`）

**`Discussion` 类型可用字段**（UI 直接能用的）：`id` `number` `title` `body` `bodyHTML` `bodyText` `url` `resourcePath` `category{id,name,emoji}` `author` `authorAssociation` `createdAt` `updatedAt` `isAnswered` `answer` `answerChosenAt` `answerChosenBy` `comments` `reactions` `reactionGroups` `locked` `viewerCanUpdate` `viewerDidAuthor`。

**`DiscussionComment`**：`body` `bodyHTML` `replyTo` `replies` `isAnswer` `discussion` `viewerCanMarkAsAnswer` …（**`replyTo` + `replies` 再次印证嵌套回复可用**，与 §2 的 REST 字段 `parent_id` / `child_comment_count` 一致）

**🔍 补上一个之前漏掉的能力：讨论可以被搜索。** 官方原文：

> Discussion may be returned from the top-level `search` field. To search for discussion, specify `type` as `DISCUSSION`.

`SearchResultItemConnection` 上还返回 `discussionCount`。→ **社区可以做全局搜索**，不必只靠本地缓存。这条要补进 [03](03-插件实现规格.md) 的搜索设计。

**用户维度查询**（做「我的发帖 / 我的回答」）：`RepositoryDiscussionAuthor.repositoryDiscussions(repositoryId:, answered:)`、`RepositoryDiscussionCommentAuthor.repositoryDiscussionComments(onlyAnswers:, repositoryId:)`。

**`PinnedDiscussion`** 类型存在 → 「置顶帖」可以做。

---

## 4. Scope：一个必须纠正的常见错误

### 4.1 `read:discussion` / `write:discussion` 不存在

**它们不是 OAuth scope。** 核对官方 scope 全表（`repo`/`public_repo`/`admin:repo_hook`/`gpg_key`/`workflow`/`offline_access`…）**没有任何 discussion 相关项**。

它们是 **GitHub App 的 permission（权限）名**，和 OAuth scope 是两套不同的体系。写进 `scope` 参数会被忽略或报错。

📄 [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)

### 4.2 正确的 scope 表

| Scope | 用途 | 是否必须 |
|---|---|---|
| **（不传 scope）** | 只读公开信息（列仓库、数星星、**读公开 discussions**） | 读路径足够 |
| **`public_repo`** | **在公开仓库建讨论 / 发评论 / 加 reaction** | ✅ **写路径必须** |
| `read:user` | 读自己的 `login` / `avatar_url` | ✅ 建议（否则头像要另外拿） |
| `offline_access` | 拿 refresh token（access token 8h、refresh 6 个月） | 可选 |
| `repo` | ❌ **不要**。私有仓库才需要，会吓退用户 |
| ~~`read:discussion`~~ / ~~`write:discussion`~~ | ❌ **不存在** | — |

📄 官方原文（Discussions GraphQL 指南）：
> *Access tokens require the `repo` scope for private repositories and the **`public_repo` scope for public repositories**.*

**所以社区请求的 scope 是：`read:user public_repo`。**

> 这与 [04](04-身份与登录.md) 原先写的 `read:user read:discussion write:discussion` 不同——**原文是错的，已修正**。
> 值得注意：按 4.1，即使当时写对了概念，那两个 scope 也不会生效。

### 4.3 OAuth App 与 GitHub App 的 scope 语义完全不同（重要陷阱）

| | OAuth App | GitHub App |
|---|---|---|
| 权限由什么决定 | `scope` 参数（`public_repo` 等） | App 上配置的 **permissions** |
| device flow 传 `scope` | ✅ 有效 | ⚠️ **只接受 `offline_access`** |
| 官方原文 | — | *This parameter does not control permissions for the user access token.* |

→ **本项目选 OAuth App**。理由：配置最简（只要一个 client_id）、scope 语义直观、`public_repo` 一项即可覆盖写需求。

---

## 5. Device Flow：实测确认的关键点

📄 [Authorizing OAuth apps · Device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)

| 项 | 值 | 备注 |
|---|---|---|
| 设备码端点 | `POST https://github.com/login/device/code` | form: `client_id`、可选 `scope` |
| 返回 | `device_code`（40 字符）、`user_code`、`verification_uri`、`expires_in`、`interval` | — |
| `expires_in` | **900 秒（15 分钟）** | 用户不操作就要重来 |
| `interval` | **5 秒（默认）** | 轮询必须 ≥ 它，否则 `slow_down`（每次 +5s） |
| `verification_uri` | `https://github.com/login/device` | 用户在这里输码 |
| 换 token | `POST https://github.com/login/oauth/access_token`，`grant_type=urn:ietf:params:oauth:grant-type:device_code` | — |
| **`client_secret`** | ✅ **不需要** | 📄 原文：*The `client_secret` is not needed for the device flow.* |
| 验证码提交限额 | **50 次 / 小时 / 应用** | 全局共享，别做无谓重试 |
| token 有效期 | 默认不过期；带 `offline_access` 或开了 expiring tokens → access **8 小时** / refresh **6 个月** | refresh 用后旧 token 作废 |

**官方明确推荐桌面/CLI 用 Device Flow**（这是我们方案的权威背书）：

> *If your app is headless or does not have access to a browser, you should use the device flow to generate a user access token. For example, CLI tools, simple Raspberry Pis, and **desktop applications** should use the device flow.*

**必须手动开启**：在 OAuth App 设置里勾 **Enable Device Flow**，否则报 `device_flow_disabled`。

**一个方案收益**：因为不需要 `client_secret`，社区插件**不持有任何服务端秘密** → 可以完全开源、任何人都能自建实例。这是 [04](04-身份与登录.md) 第 5 节的依据。

---

## 6. 次级限流：写操作真正的天花板

📄 官方 reusable 源文件 `secondary-rate-limit-rest-graphql.md`：

| 限制 | 值 |
|---|---|
| 并发请求 | **≤ 100**（REST 与 GraphQL **共享**） |
| REST 单端点 | ≤ 900 points / 分钟 |
| GraphQL 单端点 | ≤ 2,000 points / 分钟 |
| CPU | ≤ 90 秒 CPU / 60 秒真实时间 |
| **内容创建** | **≤ 80 次/分钟 且 ≤ 500 次/小时**，且「**网页界面操作 + REST + GraphQL 全部计入**」 |

**触发后的行为**：403 / 429；有 `retry-after` 就按它等；`x-ratelimit-remaining: 0` 就等到 `x-ratelimit-reset`；否则**至少等 1 分钟**再指数退避。📄 **持续重试可能导致 integration 被封禁。**

**官方 best practice**：mutative 请求之间**间隔 ≥ 1 秒**、避免并发。

**对本方案的含义**：
- 「网页界面操作也计入」意味着**社区本身刷得太勤会拖累用户在 GitHub 网页上的正常使用**。宁可提示「操作太快，请稍等」，也不要硬打。发帖按钮要有节流与防重复提交。
- 反垃圾的第一道是 GitHub 的 abuse detection，但 📄 **审核责任仍在仓库维护者**（giscus README 原文："You can moderate the comments on GitHub"）。**托管到 GitHub ≠ 有人替你审贴。**

---

## 7. 生态健康度信号

### 7.1 npm 周下载量：有公开 API，且**不吃 GitHub 配额**

📄 [npm download-counts](https://github.com/npm/registry/blob/main/docs/download-counts.md) —— 这是评估插件真实使用量的**最有价值信号**（星数会被刷，下载量不会）。

| 端点 | 说明 |
|---|---|
| `GET https://api.npmjs.org/downloads/point/{period}/{package}` | period ∈ `last-day`/`last-week`/`last-month`/`YYYY-MM-DD`/`YYYY-MM-DD:YYYY-MM-DD` |
| `GET https://api.npmjs.org/downloads/range/{period}/{package}` | 按天序列，适合画趋势 |
| `GET https://api.npmjs.org/versions/{package}/last-week` | 按版本拆分 |
| 批量 | `/downloads/point/last-day/a,b,c` |

> ⚠️ **scoped 包（`@scope/name`）不支持批量**，只能单查。DSH 插件里 scoped 包很常见（`@deepseek-ai/*`、`@xmanrui/dsh-im`、`@changfenhuang/dsh-genui`…），**这意味着批量优化对最重要的那批包无效**，必须逐个请求 + 强缓存。

**建议评分公式里 npm 下载量的权重应当高于 stars**，并显式展示两者的差异。

### 7.2 拿不到的

| 数据 | 结论 |
|---|---|
| **dependents 数（被依赖数）** | ✅ 实测 `GET /repos/octocat/Hello-World/dependents` → **404**；仓库对象无该字段；dependency-graph API 是「本仓库的依赖」而非「被谁依赖」→ **无公开 API**，只有网页。不要把它列入设计。 |
| community profile 得分 | **无公开 API**，checklist 只在网页 UI。→ 插件需自己用 contents API 探测文件存在性来复刻（见 8） |
| 304 / ETag 是否计入配额 | ✅ **实测：计入**（`delta = 1`，3/3 次复现）——条件请求省带宽，**不省配额**。详见 §9.2 与 POC-6。这与网络上广泛流传的「304 不计入配额」说法相反 |

---

## 8. 两个可直接复用的社区功能

### 8.1 投稿向导（读 `ISSUE_TEMPLATE`）

📄 [Configuring issue templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)

插件的「提 issue / 提需求」流程**不需要自己设计表单**——直接读插件仓库已有的模板并复刻即可：

| 文件 | 作用 |
|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` | Issue form（GitHub form schema：text / dropdown / checkbox / file upload） |
| `.github/ISSUE_TEMPLATE/*.md` | Markdown 模板，frontmatter 支持 `title` / `labels` / `type` / `assignees` |
| `.github/ISSUE_TEMPLATE/config.yml` | `blank_issues_enabled: false` + `contact_links: [{name, url, about}]` |

**实测过的约束（踩坑点）**：
- `name` **必须 > 3 个字符**，否则模板**不显示**
- 按**文件名字母序**排列，且 YAML 排在 Markdown 之前
- 想控序就用 `1-bug.yml` / `2-feature.yml`；**≥ 10 个时要用 `01-` / `11-` 防止错序**
- 组织级 `.github` 仓库有「默认社区健康文件」fallback 机制——插件要考虑这层继承

> **这条极大降低了实现成本**：社区不需要教育作者写模板，作者本来就在用 GitHub。

### 8.2 社区健康度清单（复刻 checklist）

📄 官方 checklist 有 README / LICENSE / CODE_OF_CONDUCT / CONTRIBUTING 等。
**没有得分 API** → 插件用 `GET /repos/{o}/{r}/contents/{path}` 逐个探测文件存在性，自己算一个「健康度」百分比。

**这对社区的核心价值**：把「这个插件靠谱吗」变成一个**可视、可比较**的数字，而这正是评分（stars）做不到的事。

---

## 9. 对架构的影响

### 9.1 读路径改回 REST（简化）

[02](02-总体架构.md) 原本把「取讨论」放在 `github/graphql`。按实测应改为：

| 模块 | 职责 |
|---|---|
| `github/rest` | **所有的读**：仓库元数据、releases、commits、**讨论列表 / 讨论详情 / 评论**、search |
| `github/graphql` | **只有两件事**：① 写（`createDiscussion` / `addDiscussionComment` / reaction）② 取 `discussionCategories` |

**好处**：未登录时**完全不碰 GraphQL**（配额本来就是 0），读路径的失败面大幅缩小，也不再需要为「匿名用户」设计 GraphQL 降级。

### 9.2 缓存 TTL 必须更保守

60/hr/IP 是硬墙。把 `x-ratelimit-remaining` / `x-ratelimit-reset` 当**一等公民**：

- 每次响应都读这两个头，写进缓存元数据
- `remaining` 低于阈值（如 10）时**自动延长 TTL 并停止后台刷新**
- 优先保证「用户主动点开的页面」有配额可用，后台预取让路

| 数据 | 建议 TTL | 依据 |
|---|---|---|
| repo 元数据（stars / issues） | 1h | 变化慢 |
| Discussions 列表 | 10–15min | 活跃但不必实时 |
| 单帖 + 评论 | 3–5min | 发帖后要能立刻看到 |
| npm 下载量 | 6–24h | 变化极慢，且不吃 GH 配额 |
| 讨论分类 ID | 24h | 登录后取一次 |

**✅ 已实测，结论与预期相反：304 条件请求照样计入配额。**

原始数据（未认证，同一 URL 连续打两次，间隔 1.2s）：

```
rep1  200:rem=36  304:rem=35  delta=1
rep2  200:rem=34  304:rem=33  delta=1
rep3  200:rem=32  304:rem=31  delta=1
```

3 次重复全部 `delta = 1`，且整段序列严格单调递减（37→36→35→34→33→32→31，**6 次请求恰好扣 6 次**），排除偶发误差。对照组：`GET /rate_limit` 连打两次 `delta = 0`。

> ⚠️ **这条推翻了「304 不计入配额」的常见说法**（该说法常被归因于 GitHub 文档关于条件请求的表述，并有 [Stack Overflow 上的同名提问](https://stackoverflow.com/questions/60885496) 记录同一现象）。本次未能重新抓到该文档原文段落，但**测量本身是决定性的**，且 6/6 请求全部计费不存在歧义。

**对缓存策略的实际影响（重要）：**

| 原计划 | 修正后 |
|---|---|
| 用 `If-None-Match` 提高轮询频率，「反正 304 免费」 | ❌ 不成立。**每次 304 也扣 1 次**，轮询频率必须按配额预算倒推 |
| ETag 用于配额优化 | ✅ 仍然值得做，但收益是 **省带宽/省传输**，不是省配额 |
| TTL 可以更激进 | ❌ 不能。§9.2 的 TTL 表保持保守 |
| 预算检查 | ✅ 改用**免费的 `/rate_limit`** 探针，而不是靠条件请求兜底 |

**推论**：未认证 60/hr 是**硬墙**，无法用条件请求绕过。因此「配额调速器」必须以 `/rate_limit` 的 `remaining` 为唯一依据做门控，并优先保障「打开插件详情页」这一条最关键路径的预算。

### 9.3 一个可选的「零配额」加成

社区仓库可以用 GitHub Actions 定时把 Discussions 导出成**静态 JSON**（挂在 `gh-pages` 或 release asset 上）。

- 读静态 JSON **不吃任何 GitHub API 配额**，匿名用户也不消耗 60/hr
- 代价：有延迟（等于用一个 CI 周期换配额）；需要维护一个 Action

**建议**：**P1 再做，先不做。** 因为 §1 已经解决了「匿名可读」，这个只是把 60/hr 的压力进一步降低。在用户量上来之前不值得引入额外组件。

---

## 10. M0 验证清单（可直接执行）

| # | 验证项 | 方法 | 通过判据 |
|---|---|---|---|
| **POC-0** | 匿名读讨论 | ✅ **已完成** | `/repos/giscus/giscus/discussions` 返回 200 与完整字段 |
| **POC-1** | Device Flow 跑通 | 建测试 OAuth App → 开 Device Flow → `device/code` → 用户授权 → 轮询 → 拿 token | 拿到 `access_token`；实测 15 分钟窗口与 `interval` 轮询行为 |
| **POC-2** | **写接口到底是 REST 还是 GraphQL** | ✅ **已完成 —— 不需要 token**：未认证 `POST`，用 `/issues`(→401) 和 `/nonexistent`(→404) 两组对照夹逼 `/discussions` | ✅ **结论：REST 不提供 discussions 写接口**（`/discussions` → `404 Not Found`，而 `/issues` → `401 Requires authentication`；见 §1） |
| **POC-3** | `createDiscussion` 全流程 | ⏸️ **契约已核实**（字段级契约见 §3.1，来自官方文档原文），仅剩「亲手发一个帖」 | 帖子和评论出现在仓库里。**已降级**：契约逐字核实后，剩余风险只到「仓库设置/权限」这类环境问题 |
| **POC-4** | `scope` 实测 | ✅ **官方文档已确认，无需实跑**：原文「Access tokens require the `repo` scope for private repositories and the **`public_repo`** scope for public repositories」 | `read:user public_repo` 正确；`read:discussion` 确实不存在（见 §4.1） |
| **POC-5** | 匿名真实体验 | 清空缓存，用 60/hr 浏览一遍，含 search | 记录实际能撑几次页面刷新，据此定 TTL |
| **POC-6** | ETag 是否吃配额 | 同一请求带 `If-None-Match` 重复打，观察 `x-ratelimit-remaining` 是否下降 | ✅ **已完成 —— 结果：吃配额**（`delta=1`，3/3 复现；见 §9.2） |
| **POC-7** | 【最高风险，独立于 API】 | 用**非协作者的普通账号**在社区仓库尝试建 Discussion | 见 [04](04-身份与登录.md) 第 8 节 |

> ✅ **POC-0 / 1 / 2 / 3 / 4 / 6 已实现为可直接运行的脚本** —— 见 [`poc/README.md`](../poc/README.md)。
>
> | 命令 | 覆盖 |
> |---|---|
> | `node run.mjs probe [--etag]` | POC-0（匿名探测）+ **POC-2（免 token 的 401/404 对照实验）** + POC-6（带 `--etag`） |
> | `node run.mjs poc2` | POC-2 认证版交叉验证（**可选**，结论已由 `probe` 给出） |
> | `node run.mjs login` | POC-1（Device Flow 全流程） |
> | `node run.mjs poc3 [--yes]` | POC-3（建讨论 → 评论 → REST 回读；**默认只预演**） |
> | `node run.mjs poc4` | POC-4 ✅ **已由官方文档定论，无需实跑**（保留命令仅作交叉验证） |
> | `node run.mjs status` | 身份 + 配额 + 门控是否放行 |
>
> 脚本零依赖（只用 Node 内置 `fetch`），不 import 任何 `@deepseek-ai/*`，token 落盘时自动脱敏。
>
> ⚠️ **只剩 POC-1 和 POC-3 需要身份凭证，且都不需要 OAuth App** —— 贴一个 Personal Access Token 就能跑：`node run.mjs token <PAT>`（30 秒，见 poc/README 第 2 节「路线 A」）。**只有 POC-1（验证 Device Flow 本身）必须建 OAuth App**，且务必勾选 `Enable Device Flow`，否则会拿到 `device_flow_disabled`。POC-4 已由官方文档定论（§4.2）；POC-3 的字段级契约也已核实（§3.1），实跑只是为了确认「仓库设置/权限」这类环境问题。POC-5 需要真人浏览一遍，脚本只负责提供配额数字。POC-7 需要一个第二个普通账号，属人工步骤。

---

## 附：来源汇总

[REST 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [GraphQL 限额](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) · [次级限流源文件](https://github.com/github/docs/blob/main/data/reusables/rest-api/secondary-rate-limit-rest-graphql.md) · [Discussions GraphQL 指南](https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions) · [OAuth scope 表](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) · [Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) · [GitHub App user token（Device Flow 推荐）](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) · [npm downloads](https://github.com/npm/registry/blob/main/docs/download-counts.md) · [giscus SELF-HOSTING](https://github.com/giscus/giscus/blob/main/SELF-HOSTING.md) · [开启 Discussions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/enabling-or-disabling-github-discussions-for-a-repository) · [ISSUE_TEMPLATE](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository) · [社区档案](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories)

→ 下一步读 [04 · 身份与登录](04-身份与登录.md)。
