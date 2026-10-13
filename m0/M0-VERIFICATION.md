# M0-VERIFICATION · 可行性验证报告

> **状态：进行中**。API 契约部分已全部定论（其中 4 项实跑、2 项由官方文档定论）；三个设计假设中，A 有官方原文支撑但需一次实测，B/C 依赖手机端环境尚未具备。
>
> 对应 [07-路线图与验收](../docs/07-路线图与验收.md) 第 2 节。**M0 的准出标准：三个假设都有明确结论，且假设 A 若失败时已选定备选方案。**

---

## 0. 结论摘要

| # | 要验的东西 | 状态 | 一句话结论 |
|---|---|---|---|
| POC-0 | 匿名能否读讨论 | ✅ **实测** | 能。`GET /repos/{o}/{r}/discussions` 免登录返回 200 |
| POC-2 | REST 有没有 discussions 写接口 | ✅ **实测** | **没有**。整族 404；写只能走 GraphQL mutation |
| POC-4 | OAuth scope 够不够 | ✅ **官方文档定论** | 公开仓库就是 `public_repo`，`read:discussion` 从不存在 |
| POC-6 | 304 条件请求是否吃配额 | ✅ **实测** | **吃**（反直觉）。无法用条件请求绕过 60/hr |
| 契约 | GraphQL 写路径字段级契约 | ✅ **官方文档定论** | 字段、类型、返回结构、node ID 顺序链全部核实 |
| POC-3 | 亲手发一个帖 | ⏸️ **未实跑** | 契约已知，只剩环境确认 |
| POC-1 | Device Flow 跑通 | ❌ **未做** | 需建一个 OAuth App |
| POC-5 | 匿名 60/hr 真实体感 | ❌ **未做** | 需真人浏览一遍 |
| POC-7 | 非协作者能否建帖 | ❌ **未做** | 需第二个普通账号 |
| 假设 A | 非协作者能否创建 Discussion | 🟡 **有强证据，待实测** | 官方原文支持「能」；这是最高风险项 |
| 假设 B | phone-pair 中继是否转发未知路径 | ⚪ **未开始** | 依赖手机端环境 |
| 假设 C | phone-pair 快照是否加载 client 插件 | ⚪ **未开始** | 依赖手机端环境；预期「不加载」 |

**当前判断：M0 不会推翻载体设计。** 理由：三条设计支柱里，两条（匿名可读、写走 GraphQL）已经实测站住，第三条（任何人都能发帖）有官方原文直接支撑。真正的未知量集中在**手机端两条**（假设 B/C），而它们的失败**不改变载体选择**，只影响「形态①能不能在 phone-pair 里用」——而形态②本来就为此准备着。

---

## 1. 已定论的部分（含证据）

### 1.1 设计支柱一：匿名可读 ✅

**结论**：未登录状态下，任何人都能读取公开仓库的 Discussions 列表与详情。

**证据**：POC-0 实测 `GET /repos/{owner}/{repo}/discussions` → **200**（对照：同一仓库的写端点 → 401/404，见 1.2）。

**为什么这条重要**：它是「不强迫访客登录就能浏览社区」的技术前提。如果读也要 token，整个「社区」的进入门槛会直接劝退 90% 的访客。

**但有一条硬墙**：未认证配额是 **60 请求/小时，按来源 IP**（实测 `GET /rate_limit` → `core {limit: 60}`）。这是**全机共享**的一个池子，浏览器刷新页面也吃它。

**且不能靠条件请求绕过**：POC-6 实测——带 `If-None-Match` 得到 304 时，`/rate_limit` 的 `remaining` **照样减 1**（3 次重复，每次 `delta = 1`）。对照组 `GET /rate_limit` 自身 `delta = 0`。

→ **设计后果**：插件必须有一个**配额调速器**，以 `/rate_limit` 返回的 `remaining` 为唯一门控依据；缓存 TTL 要按剩余配额动态调整，而不是固定 5 分钟。详见 [08](../docs/08-GitHub-API-契约.md) 第 7 节。

### 1.2 设计支柱二：写路径只能走 GraphQL ✅

**结论**：**REST 侧完全不提供 Discussions 的写接口**（建讨论、发评论、改、删都不行）。想发帖只有 GraphQL mutation 一条路。

**证据（决定性对照实验，全部无需 token）**——判据是「未认证时端点存在但需鉴权 → 401；端点不存在 → 404」：

| 请求 | 结果 | 含义 |
|---|---|---|
| `POST /repos/giscus/giscus/issues` | **401** `{"message":"Requires authentication"}` | 对照组 A：端点存在，只是要鉴权 |
| `POST /repos/giscus/giscus/discussions` | **404** `{"message":"Not Found"}` | 写接口**不存在** |
| `POST /repos/giscus/giscus/discussions/1/comments` | **404** | 评论写接口不存在 |
| `PATCH` / `PUT` / `DELETE /repos/giscus/giscus/discussions/1` | **404** | 改/删接口不存在 |
| `POST /repos/giscus/giscus/nonexistent-xyz-123` | **404** | 对照组 B：不存在的路径也是 404 |
| `GET /repos/giscus/giscus/discussions` | **200** | 排除误判：404 不是「仓库没开 Discussions」 |

**这条结论为什么值得单独验**：它排除了「用 REST 发帖」这个看起来更简单的方案，并且**解释了为什么 `read:discussion`/`write:discussion` 从来不是 OAuth scope**——它们是 GitHub App 的 permission 名，和 OAuth scope 是两套体系。

### 1.3 设计支柱三：scope 最小化 ✅

**结论**：公开仓库只需要 **`public_repo`**；加 `read:user` 只为拿头像和 login。

**证据**：GitHub 官方文档原文（[Using the GraphQL API for Discussions](https://github.com/github/docs/blob/main/content/graphql/guides/using-the-graphql-api-for-discussions.md)）：

> Access tokens require the `repo` scope for private repositories and the `public_repo` scope for public repositories.

**排除项**：`read:discussion` / `write:discussion` **不是 OAuth scope**（查过官方 scope 全表，无任何 discussion 项）。写进 `scope` 参数会被忽略。

→ **设计后果**：登录页只需向用户索取 `read:user public_repo` 两个 scope。**不要索取 `repo`**——它会吓退用户，而且对公开仓库是多余的。

### 1.4 GraphQL 写路径的字段级契约 ✅

**来源**：官方文档原始 markdown（见 [08 §3.1](../docs/08-GitHub-API-契约.md) 全文）。

- `createDiscussion(input: CreateDiscussionInput)` —— 必填 `repositoryId: ID!`、`categoryId: ID!`、`title: String!`、`body: String!`；返回 `CreateDiscussionPayload { discussion }`
- `addDiscussionComment(input: AddDiscussionCommentInput)` —— 必填 `discussionId: ID!`、`body: String!`；`replyToId: ID` 填了就是**嵌套回复**
- 其余：`updateDiscussion`、`deleteDiscussion`、`updateDiscussionComment`、`deleteDiscussionComment`、`markDiscussionCommentAsAnswer`、`unmarkDiscussionCommentAsAnswer`

**一个必须记住的坑**：这两个 mutation 要的是 **node ID**（`R_kgDO…` / `DIC_kwDO…`），**不是** `owner/name`，也不是讨论的 `number`。而 `repositoryId` 未认证拿不到（GraphQL 未认证配额 = 0）。

→ **写路径顺序被锁死**：`token → 查 repository.id → 查 discussionCategories.nodes[].id → createDiscussion`。分类 ID 可以在登录后取一次并**长期缓存**。

**另外两条影响设计的发现**：

1. **讨论可以被搜索**：顶层 `search` 字段支持 `type: DISCUSSION`，并返回 `discussionCount`。→ 社区可做真正的全站搜索，但**需要 token**，所以未登录用户只能搜本地缓存（已补进 [03](../docs/03-插件实现规格.md)）。
2. **每仓库最多 25 个讨论分类**。→ 分类设计必须克制，不能按插件类型无限分。

---

## 2. 三个设计假设

### 假设 A：非协作者能否创建 Discussion ⚠️ 最高风险

| 项 | 内容 |
|---|---|
| **假设** | 任何 GitHub 用户（非仓库协作者）都能在社区的公开仓库里**新建 Discussion** |
| **现有证据** | 🟢 **官方文档原文**：「*People with read access to a repository can participate in discussions and polls in the repository.*」——公开仓库的 read access 是所有人都有，字面上直接支持「能」 |
| **旁证** | 🟢 giscus / utterances 在成千上万个公开仓库上正是靠这个机制工作：**访客不是协作者**，却能发表评论（其实现就是创建 Discussion / Issue 评论）。如果非协作者不能建帖，这类工具根本无法存在 |
| **为什么仍是最高风险** | 上面两条都是**推论**，不是在我们自己的仓库上的实测。而这个假设一旦为假，「论坛」这个载体就要整体换掉，影响面是所有假设里最大的 |
| **验证方法** | 用**第二个普通 GitHub 账号**（非协作者），在已开启 Discussions 的社区仓库点「New discussion」，发一帖 |
| **判据** | 帖子成功出现在仓库的 Discussions 列表里 = **通过**；按钮不可见 / 报权限错误 = **不通过**（记录原文错误信息） |
| **若失败** | 走 [04](../docs/04-身份与登录.md) 第 8 节的**备选方案 B1**：写路径改走 Issues（任何人有 read access 就能开 Issue，这一点由 `POST /repos/{o}/{r}/issues` 的存在性与 REST 写接口的长期语义保证），再由插件同步成 Discussion |
| **状态** | 🟡 待实测 |

> **为什么这条排在最高优先级**：[07](../docs/07-路线图与验收.md) 第 11 节写明「M0 不通过就不要进 M1」。假设 A 是唯一能**推翻载体选择**的假设。

### 假设 B：`dsh-phone-pair` 的中继是否转发未知路径 ⚪

| 项 | 内容 |
|---|---|
| **假设** | 中继域名会把 `/community` 这类**产品自带之外**的路径原样转发到电脑上的 DSH 服务 |
| **为什么是风险** | phone-pair 的前端是**构建时抓取的静态快照** + 同源闸门（`AssetIndex`）。产品之外的路径很可能根本不在索引里，被同源闸门拦掉 |
| **验证方法** | 在电脑上 `webServer.register` 一个自定义路径，用手机通过中继域名访问 |
| **判据** | 手机 App 内能打开 = 通过；被拦 = 不通过 |
| **若失败** | 退路：让用户用**手机浏览器**直接打开同一 URL（浏览器没有 AssetIndex 同源闸门）。**这不改变形态②的必要性，反而加强了它** |
| **状态** | ⚪ 未开始（依赖手机端环境）。详见 [06](../docs/06-手机端兼容.md) |

### 假设 C：`dsh-phone-pair` 的构建时快照是否加载 client 插件 ⚪

| 项 | 内容 |
|---|---|
| **假设** | **不加载**。前端是构建时快照，而 client 插件是运行时由 `clientModules` 动态注入 bundle |
| **验证方法①** | 用 `dsh-android` 项目给出的字节数判据：拉电脑端 DSH 首页 HTML 并测量长度 —— **`34846` ≈ 插件图正常；`3709` ≈ 插件图为空** |
| **验证方法②** | 手机上通过 phone-pair 打开 DSH，观察一个已装的 client 插件（如 `dsh-workspace` 的侧栏用量摘要）是否出现 |
| **判据** | 报告写明**实测字节数** + 插件是否可见 |
| **若失败（= 插件确实加载了）** | 好消息：形态①可用；但**形态②仍然要做**（它服务裸浏览器与原生客户端） |
| **状态** | ⚪ 未开始（依赖手机端环境） |

---

## 3. 剩余 POC 执行清单

| POC | 要做什么 | 前置条件 | 命令 |
|---|---|---|---|
| **POC-1** | Device Flow 跑通（code → device → 轮询 → token） | 建一个 OAuth App，**务必勾 Enable Device Flow** | `node run.mjs login` |
| **POC-3** | 亲手发一个帖（建讨论 → 评论 → REST 回读） | 一个开启 Discussions 的仓库 + PAT | `node run.mjs token <PAT>` → `node run.mjs poc3 --yes` |
| **POC-5** | 匿名 60/hr 的真实体感 | 无 | `node run.mjs probe`，然后手动刷几次页面观察卡顿 |
| **POC-7** | 非协作者能否建帖（= 假设 A） | **第二个普通账号** | 人工步骤，脚本做不了 |

> 脚本与用法见 [`poc/README.md`](../poc/README.md)。**token 永远不要贴进对话**——它只在你本机使用，脚本自己存到 `poc/.token.json`（已 gitignore）。

**已下线/降级的项**：

- **POC-4**（scope）→ ✅ 官方文档已定论，无需实跑。`poc4` 命令保留仅作交叉验证。
- **POC-3** → 降级为「环境确认」。字段级契约已逐字核实，实跑只是为了确认仓库设置与权限在实际请求里生效。
- **POC-6**（ETag）→ ✅ 已实测，结论是「吃配额」，反直觉但确定。

---

## 4. 准出判定

| 准出条件 | 当前 | 说明 |
|---|---|---|
| 假设 A 有结论 | 🟡 有强证据、待实测 | 官方原文 + giscus 旁证；建议实测确认 |
| 假设 A 若失败，备选方案已选定 | ✅ 已选定 | 备选 B1（走 Issues 写入再同步），见 [04](../docs/04-身份与登录.md) 第 8 节 |
| 假设 B 有结论 | ❌ | 依赖手机端环境 |
| 假设 C 有结论 | ❌ | 依赖手机端环境 |
| API 能力边界已摸清 | ✅ | 见 [08](../docs/08-GitHub-API-契约.md) |
| 社区仓库地基文件已就绪 | ✅ | 见 `community-repo/` |

**放行判断**：

- **可以进 M1**（形态② + 索引 + 缓存）—— 因为 M1 完全不依赖假设 B/C，也不依赖「非协作者能建帖」（M1 只读）。
- **不能进 M2**（身份 + 发帖）—— 直到假设 A 有实测结论。
- **假设 B/C 可以并行**，不阻塞 M1。

---

## 5. 一条龙执行清单（能在电脑前做完的部分）

```
[ ] 1. 建公开仓库 dsh-plugin-community
[ ] 2. 提交 community-repo/ 全部文件
[ ] 3. Settings → Features → 勾上 Discussions
[ ] 4. 建 6 个讨论分类（照 docs/discussions-categories.md）
[ ] 5. 发前 3 个帖（照 docs/seed-posts.md）
[ ] 6. 跑假设 A：用第二个账号发一帖          ← 关键
[ ] 7. 建 OAuth App（勾 Enable Device Flow），把 client_id 填进 poc/config.json
[ ] 8. node run.mjs login        → POC-1
[ ] 9. node run.mjs poc3 --yes   → POC-3
[ ] 10. 把 1–9 的结果填回本文件
```

---

*本报告的每条结论都标注了来源。凡是标「实测」的都有原始返回；标「官方文档定论」的引用了官方原文；标「推论/旁证」的**明确说明了它是推论**，不与实测混同。*
