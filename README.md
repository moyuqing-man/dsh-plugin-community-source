# DSH 插件社区 · 方案文档

> 一句话：**市场已经过剩，社区还是空的。**
> 本方案不做第 N 个插件市场，而做**市场之上的那一层**——讨论、信任、沉淀与协作。
> 社区本身是一个 DSH 插件，但它的本质是**一个「联合其他插件的联合插件」**：不重复收录，只桥接与组织。

> **仓库**：源码与这 8 份方案文档 → `moyuqing-man/dsh-plugin-community-source`（本地就是这个目录）；社区仓库（Discussions 分类 / Issue 与讨论表单 / 行为准则）→ `moyuqing-man/dsh-plugin-community`（本地是 [`m0/community-repo/`](m0/community-repo/README.md)）。两个仓库各自独立推送。

> ⚠️ **当前版本是 demo（0.1.0），不是稳定版。** 插件本体代码已写完、220 个测试全绿，打包路径真机走通了（`pnpm pack` → 真实 tgz → 解包后 import + apply 成功，4 条路由与 4 个 Agent 工具都注册得上），**并且已经真的被 DSH 装载起来过**——在隔离的临时 profile 里 `dsh plugin add` 真实 tarball 后启动，`/community` 与 `/api/v1/community/meta` 都返回 200，启动日志零告警。这一轮真机验证抓出了两个本地测试**结构上不可能发现**的 bug（`Config` 必须实现 Standard Schema、`ctx` 是 Proxy 所以未 inject 的服务访问会抛错），已修并加了变异测试守住；随后用岚叔目录的 **655 条真实数据**跑解析器，又抓出 4 个 bug（其中一个判据**反了**，把上游评为最好的条目涂成红线），修正后红线从 528+ 条降到 43 条。详见 [docs/07-路线图与验收.md](docs/07-路线图与验收.md) 第 6、7 条与「诚实保留」第 2 条。仍然**没有在真实环境验证过**的是：① client 半边在真实界面里的挂载（侧栏图标 / 主面板 / 四个工具卡片要有人在界面上点开看），② 真机上的工具卡片，③ `dsh.so` 与 `dsh.works` 两个可选索引源（本机连不上，只有岚叔目录连上过），④ client 半边新增的**面板内发帖 / 评论 / 点赞**（宿主接口已线下验证，client 侧渲染没有），⑤ npm 上的真实发布（打包已验证，差一次 `pnpm publish`）。登录也需要自己配 Client ID。详见 [plugin/README.md](plugin/README.md) 开头的说明。

---

## 1. 一页摘要

| 维度 | 结论 |
|---|---|
| 交付物 | **方案文档 + 可执行的 POC 验证脚本 + 已开工的插件本体**（[`poc/`](poc/README.md)、[`plugin/`](plugin/README.md)；全部零依赖、纯 JS） |
| 载体 | **GitHub Discussions = 论坛**，**Issues = bug 汇报**，**Stars = 评分**，**Releases = 版本** |
| 登录 | **GitHub Device Flow**——8 位验证码，无回调域名、无 client secret、手机端友好 |
| 权限 | 匿名可读，登录可写（发帖 / 评论 / 投票） |
| 技术形态 | DSH 插件，**双形态交付**：① client slot 注入版 ② host 侧独立 HTTP 页面版 ③ JSON API |
| 手机端 | 对 `dsh-android` 天然兼容；对 `dsh-phone-pair` **主动兼容**（靠独立页面形态）；对原生客户端提供 JSON API |
| 硬约束 | **纯 JS、零原生依赖**——这是能跑在 Android host 上的唯一前提 |
| 不做什么 | 不重复收录插件目录、不做第二个注册系统、不做三个手机端 App |

---

## 2. 文档导航

| 文档 | 回答什么问题 |
|---|---|
| [01-定位与生态分析](docs/01-定位与生态分析.md) | 为什么已经有市场了还要做社区？差异化在哪？不做什么？ |
| [02-总体架构](docs/02-总体架构.md) | 系统怎么分层？双形态交付怎么落地？数据怎么流？ |
| [03-插件实现规格](docs/03-插件实现规格.md) | 用真实源码实测出来的 DSH 插件契约；路由表、槽位表、工具表 |
| [04-身份与登录](docs/04-身份与登录.md) | GitHub 注册流程怎么简化到「点一下 + 输 8 位码」 |
| [05-界面与交互设计](docs/05-界面与交互设计.md) | 页面长什么样？挂在哪些官方槽位上？关键流程怎么走？ |
| [06-手机端兼容](docs/06-手机端兼容.md) | 三套手机方案能不能兼容插件？不能的话我们怎么主动兼容？ |
| [07-路线图与验收](docs/07-路线图与验收.md) | 分几个里程碑？怎么算做完了？风险有哪些？ |
| [08-GitHub-API-契约](docs/08-GitHub-API-契约.md) | **实测**：哪些免登录能读、哪些必须要 token、限额卡在哪、POC 怎么跑 |
| [poc/ 验证器](poc/README.md) | **可执行**：一条命令把 08 的每条结论复现成证据（POC-0/1/2/3/4/6） |
| [m0/ 启动包](m0/README.md) | **可交付**：M0 验证结论 + 可直接推上 GitHub 的社区仓库地基（分类 / 表单 / 首发帖） |
| [plugin/ 插件本体](plugin/README.md) | **可运行且已真机装载过**：M1 + M2 + M3 + M4 已跑通——多源索引（6 个源，默认开 2 个）、**索引质量治理**（`sort=smart` 把框架本体与聚合清单降级，`?sort=stars` 仍是纯 star 排序）、`/community` 页面（关掉 JS 也能看，带类型/分类/排序 chips）、**作者资料页** `/community/u?login=`、`/api/v1/community/*` JSON API、缓存与陈旧降级、GitHub Device Flow 登录与发帖/评论/表态/单帖读取、**client 半边七个座位**（侧栏入口 / 主面板**双页签含发帖·评论·点赞** / 插件详情页区块与标签 / 设置页 / 登录浮层 / 4 个 Agent 工具的自定义卡片）、**中英双语**（`?lang=` + 设置页可切换）；**220 个测试全绿**；英文版见 [plugin/README.en.md](plugin/README.en.md) |

---

## 3. 核心设计主张

**主张一 · 社区是「联合插件」，不是「另一个市场」。**
已有市场（`DSH-Plugins-Marketplace` ★175、`dsh-find-plugin` ★183、`dsh-plugin-subscriptions` ★448 等）已经把「发现」这个问题解决得很好，而且各自还在做 CI 索引与审核规范。社区重复造一个目录只会内卷。社区要做的是**读它们的索引，然后在其上叠加它们都不做的事**：讨论、评价、问题追踪、经验沉淀。

**主张二 · GitHub 已经是最好的后端，只是缺一个入口。**
评分不用自建投票系统，Stars 就是。Bug 不用自建工单，Issues 就是。论坛不用自建帖子表，Discussions 就是。本方案的工程量几乎全部集中在**桥接层与界面层**，而不是后端服务。

**主张三 · 登录必须是「Device Flow」。**
自建注册要邮箱、密码、验证码、找回流程；GitHub OAuth 回调要域名、要 HTTPS、要 client secret。而 **GitHub Device Flow** 只要一个 client_id，用户看到 8 位码、点个链接、输码、授权——**在手机上比在电脑上还顺手**。这是本方案能同时服务桌面与手机的关键。

**主张四 · UI 必须能脱离 client 插件图独立存在。**
现有手机方案中，`dsh-phone-pair` 的前端是**构建时快照**，而 DSH 的 client 插件是**运行时注入**的——两者大概率对不上，结果就是「插件 UI 不显示」。所以社区页必须同时提供一条**不依赖 slot 注入**的路径：host 侧 `webServer.register` 直接渲染一个独立页面，任何浏览器/WebView 直接访问 URL 就能用。这条路径同时天然服务原生客户端（换成 JSON API）。

---

## 4. 与用户原始设想的一致与修正

| 原始设想 | 本方案 | 说明 |
|---|---|---|
| 社区本身是「插件联合其他插件的联合插件」 | ✅ 采纳为核心主张一 | 落地为「不收录目录，只读别人的目录 + 叠加讨论层」 |
| DSH 插件只做界面和链接层 | ✅ 采纳 | host 半边只做 API 桥接与缓存，client 半边只做界面 |
| GitHub 已有 star 做评分、Issues 做 bug | ✅ 采纳 | 直接用，不自建 |
| 简化 GitHub 注册流程 | ✅ 强化 | 升级为 Device Flow，8 位码 |
| 评论需要登录 | ✅ 采纳 | 匿名可读、登录可写 |
| 论坛用 GitHub Discussions | ✅ 采纳 | Categories 直接映射为板块 |
| 做手机版 harness | ↩️ 修正 | 已完成调研：B 站已有的手机方案**能兼容插件**（`dsh-android` 是同源真 DSH），因此**不做手机端**，改为**主动兼容已有方案** |

---

## 5. 关键事实速查（后续文档反复引用）

**生态规模**：聚合 7 个源（dsh.so 10099 · radar 301 · GitHub topic · awesome-dsh-plugin 4579 · 岚叔目录 655 · npm · dsh.works），候选池 **13061 条**。市场不是不够，是太多。

**Android 可行性的决定性证据**：`yhm080315-sudo/dsh-android` 把完整 DSH 打进 APK（自带 Node + bionic 二进制），README 原文——「WebView 里是真正的 DSH Web 界面——不是重写的，是同源代码」「主界面、插件、皮肤、agent 全部跟桌面端一致」，对比表中「第三方插件 ✅」。

**但代价是**：任何依赖预编译 `.node` 的 npm 包在 Android 上没有版本；`grep`/`glob` 需特殊处理（`@vscode/ripgrep-android-arm64` npm 不发布）。→ **本方案的零原生依赖红线由此而来。**

**client 插件图是否为空的判据**：页面 HTML **34846 字节 = 正常**，**3709 字节 = 插件图为空**。这条判据在验证手机端兼容性时会直接用到。

**插件契约（实测自真实插件源码）**：host 半边 `dsh.bundle.patch` + `export const name/inject/Config` + `export function apply(ctx, config)`；client 半边 `dsh.client` + `export const inject = ['slots']` + `ctx.slots.inject(name, () => ctx.slots.register({ name, id, order }, Component))`。详细规格见 [03](docs/03-插件实现规格.md)。

**GitHub API 能力边界（实测，见 [08](docs/08-GitHub-API-契约.md)）**：

| 结论 | 实测值 |
|---|---|
| **Discussions 有 REST 读接口，完全免登录** | `GET /repos/{o}/{r}/discussions` ✅ 200，含 `body`/`category`/`comments`/`answer_chosen_at`/`author_association` |
| 写只能走 GraphQL | ✅ **对照实验钉死**：未认证 `POST /discussions` → **404 Not Found**，而 `POST /issues` → **401 Requires authentication**（存在但需鉴权=401、不存在=404）；`createDiscussion` 是 GraphQL mutation |
| 未认证限额 | REST **60/小时且按来源 IP**；`search` **10/分钟**；**GraphQL 为 0** |
| 认证后 | 5,000/小时（PAT / OAuth App / GitHub App user token **共享同一池**） |
| 内容创建 | ≤80/分钟 且 ≤500/小时，**网页操作也计入** |
| 正确的 scope | **`read:user public_repo`** —— `read:discussion` / `write:discussion` **不是 scope，不存在** |
| Device Flow | 不需要 `client_secret`；`expires_in=900`、`interval=5`；验证码提交限 **50/小时/应用** |
| 生态健康度 | **npm 周下载量有公开 API 且不吃 GitHub 配额**；**dependents 数无公开 API**（实测 404） |
| **`GET /rate_limit`** | **自身不消耗配额**（实测 delta=0）→ 免费的预算探针，配额门控就靠它 |
| **304 / ETag 条件请求** | **照样计入配额**（`delta=1`，3/3 复现）——省带宽，**不省配额**；推翻了「304 免费」的常见说法 |

---

## 6. 阅读顺序建议

- **只想知道结论** → 本文第 1 节 + [01](docs/01-定位与生态分析.md) 第 1 节
- **要评估可行性** → [03](docs/03-插件实现规格.md)（契约是否够用）+ [06](docs/06-手机端兼容.md)（手机端是否真能跑）
- **要评估工作量** → [02](docs/02-总体架构.md) 第 6 节 + [07](docs/07-路线图与验收.md)
- **要开始动手** → [03](docs/03-插件实现规格.md) + [05](docs/05-界面与交互设计.md) + [07](docs/07-路线图与验收.md)

---

## 7. 许可证

[MIT](LICENSE)，© 2026 moyuqing-man。方案文档、POC 脚本与插件本体同一个许可证。

插件本体（[`plugin/`](plugin/README.md)）另有一份同样的 [`plugin/LICENSE`](plugin/LICENSE)，
因为它会被单独发到 npm，而 npm 包只会带上自己目录内的文件。
社区仓库（`m0/community-repo/` → `moyuqing-man/dsh-plugin-community`）也放了同样的 [LICENSE](m0/community-repo/LICENSE)——它是独立仓库，许可证不会跟着父目录走。

