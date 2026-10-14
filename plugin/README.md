# dsh-plugin-community

**DSH 插件社区** —— 把 GitHub Discussions 变成插件的讨论区、Issues 变成 bug 汇报入口、Stars 变成评分。

> English version: [README.en.md](./README.en.md)

> ⚠️ **这是一个 demo（0.1.0），不是稳定版。** 代码写完了、221 个测试全绿，**已经真的被 DSH 装载过**
> （隔离 profile 里 `dsh plugin add` 后启动，`/community` 与 `/api/v1/community/meta` 都返回 200），
> **也已经发布到 npm**：`dsh-plugin-community@0.1.0`，`dsh plugin add dsh-plugin-community` 实测能从
> registry 下载、装上、跑起来。这一轮真机验证抓出了两个本地测试**结构上不可能发现**的 bug，另有 4 个
> bug 是用岚叔目录 **655 条真实数据**跑解析器跑出来的，详见下文「真机验证」一节。
> 仍然**没验证过**的是：
> ① client 半边的**写路径**（面板内发帖 / 评论 / 点赞的提交需要 GitHub 登录态）与四个工具卡片
> （要有人在真实会话里跑一次工具调用才看得到），
> ② `dsh.so` 与 `dsh.works` 两个索引源（开发机连不上，只用离线 fixture 测过解析逻辑；**岚叔目录
> 在 2026-10-14 连上过，见下文「用真实数据跑一遍解析器」**）。
> 登录功能还需要你自己申请一个 GitHub OAuth App、把 Client ID 填进配置才能用。
> 适合评估与试玩，**不建议现在就拿去撑依赖它的流程**。


这个包有**两个半边**：

- **host 半边**（`lib/index.js`）——挂两条路由（一个给人看的页面、一个给程序看的 JSON API），
  数据全部从已有的插件索引源和 GitHub 读，自己**不存任何东西、不建任何库**。
- **client 半边**（`lib/client.js`）——往 DSH 界面里插七个座位，让社区**长在 DSH 里面**
  而不是只挂在一个外部网页上。

两个半边都是**手写的纯 JS，零构建步骤**：client 半边就是一个
`window.__ModuleLoader__.load({ id, factory })` 包裹的工厂函数，不写 JSX，用 `React.createElement`。
（这不是风格选择——本机 npm registry 不可达，装不了 esbuild/rollup，也不想为了构建工具引入 CI 依赖。）

> 设计定位：市面上不缺口「插件市场」，缺的是「插件社区」。
> 所以这里只做**桥接与组织**，不做第二个市场。

---

## 现在能用什么（诚实版）

| 能力 | 状态 |
|---|---|
| 索引多个插件源并合并成统一卡片 | ✅ 可用 |
| `/community` 页面（服务端渲染 HTML） | ✅ 可用 |
| `/community/plugin?repo=` 详情页 | ✅ 可用 |
| `/api/v1/community/*` 读接口 | ✅ 可用 |
| 分层缓存 + 上游挂了走陈旧数据 | ✅ 可用 |
| 未登录时只读、写操作一律 401 | ✅ 可用 |
| 登录（GitHub Device Flow，8 位验证码） | ✅ 可用（**需要先填 `clientId`**，见下） |
| 真正发帖 / 评论 / 表态 | ✅ 可用（`public_repo`） |
| 侧栏入口 + 主面板社区页（`sidebar.panellist` + `main`） | ✅ 可用 |
| **面板内发帖 / 评论 / 点赞**（不跳 GitHub 网页） | ✅ 代码就绪，**待真机登录验证** |
| 插件详情页里嵌社区讨论（不离开当前页面） | ✅ 可用 |
| **作者资料页** `/community/u?login=` | ✅ 可用（走 REST，**未登录也能看**） |
| **索引质量治理**（`sort=smart`：降级框架本体与聚合清单） | ✅ 可用 |
| Agent 工具（`community_search` 等 4 个） | ✅ 已注册 |
| 发布到 npm | ✅ 已发布 `dsh-plugin-community@0.1.0`（30 文件 / 343.9 KB 解包后；`dsh plugin add dsh-plugin-community` 实测可装） |

**没配 `clientId` 时不会崩，也不会假装能登录**：页面会直接列出开通步骤（5 步，
其中第 4 步「勾 Enable Device Flow」最容易漏），API 则返回 `503 NOT_CONFIGURED`。
两者行为不一致是**故意的**——人看到的是能照着做的说明，脚本看到的是明确的状态码。

**未登录时「读讨论列表」也是读不到的**：GitHub GraphQL 对未认证请求的配额是 **0**，
而 REST 侧**根本没有** discussions 接口（这是实测结论，不是猜测）。
所以接口会明确返回 `{available:false, reason:"TOKEN_REQUIRED"}`，
而不是假装「这个插件没有讨论」——把「读不到」和「没有」混为一谈，比报错更糟。

---

## 快速开始

### 想先看看页面长什么样（不用装进 DSH）

```bash
node scripts/preview.mjs
# 浏览器打开 http://127.0.0.1:3221/community
```

想在手机上看：

```bash
ALLOW_REMOTE=1 PORT=3221 node scripts/preview.mjs
# 手机浏览器打开 http://<电脑局域网IP>:3221/community
```

### 装进 DSH

装进 profile 后，在 `cordis.patch.yml` 里加一段（或直接用下面的默认值）：

```yaml
- insert:
    - id: dsh-plugin-community
      name: 'dsh-plugin-community'
      config:
        owner: 'moyuqing-man'
        repo: 'dsh-plugin-community'
```

然后重启 DSH，访问 `http://127.0.0.1:<端口>/community`。

本包在 `package.json` 的 `dsh.compatibility` 里声明了兼容范围：DSH `>=0.2.0-rc.2`、Node `>=22`、`profiles: ["web"]`。
真机装载并跑通的是 **DSH 0.2.0-rc.2（桌面版）**；`>=` 的上界是空的，也就是说更高版本没有被声称过一定可用。

---

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `owner` | `moyuqing-man` | 社区仓库归属 |
| `repo` | `dsh-plugin-community` | 社区仓库名 |
| `allowRemote` | `false` | **默认只允许本机访问**。想让手机/局域网访问必须显式开成 `true` |
| `cacheTtlMinutes` | `60` | 索引缓存新鲜期 |
| `sources` | `['github-topic','awesome']` | 启用哪些索引源（可选 6 个源里有 3 个标了 `optIn`，默认不开） |
| `frameworks` | `['deepseek-ai/deepseek-harness']` | 哪些仓库是**框架本体**而不是插件：仍然列出、仍然可筛，但在综合排序里降级 |
| `excludeRepos` | `[]` | 要从列表里**彻底删掉**的仓库。默认空——降级而不是删除，是刻意的 |
| `userAgent` | `dsh-plugin-community/0.1.0` | 请求 GitHub 时带的 UA |
| `prewarm` | `true` | 启动后延迟预热体积大的源 |

`owner` / `repo` **是配置项，不写死在代码里**——换仓库只改这两行。
`frameworks` / `excludeRepos` 的存在不是为了「治理数据好看」：`topic:dsh-plugin` 是
**自我声明**标签，任何人都能加，官方框架 `deepseek-ai/deepseek-harness` 因此常年霸榜，
`sort=smart` 就是用来把它和「聚合清单」类仓库降下去的。做法记录在 `lib/core/rank.js` 文件头。

---

## 路由

### 页面（服务端渲染，关掉 JavaScript 也能看）

| 路径 | 说明 |
|---|---|
| `/community` | 插件列表，支持 `?q=&category=&kind=&sort=&page=` |
| `/community/plugin?repo=owner/name` | 插件详情 |
| `/community/t?id=<discussion>` | 302 跳转到 GitHub，**不二次托管讨论正文**（`/thread` 接口才是本地读） |
| `/community/u?login=<user>` | 作者资料页 + 他名下的索引条目。**走 REST 的公开用户信息，未登录也能看** |

`sort` 取值：`smart`（默认）/ `stars` / `downloads` / `recent` / `name`。
`kind` 取值：空（全部）/ `plugin` / `framework` / `aggregator` / `unknown`。

页面**零前端 JS**：搜索是 `<form method="get">`，翻页和筛选是 `<a>`。
这不是洁癖，是硬要求——手机端 WebView 里客户端插件图可能加载不出来，那时页面必须还是活的。

**语言**：所有页面都接受 `?lang=zh` / `?lang=en`，没给就按 `Accept-Language` 自动判断。
页面右上角有语言切换链接，切过去会**带着当前的搜索词和筛选条件**，不会把你的搜索结果弄丢。

### JSON API

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/v1/community/plugins` | GET | 列表 |
| `/api/v1/community/plugin` | GET | 单个插件；`?repo=owner/name` 或 **`?pkg=<npm包名>`**（见下） |
| `/api/v1/community/meta` | GET | 公开配置事实（仓库地址、前缀、是否配了 clientId）；**只给公开值** |
| `/api/v1/community/discussions` | GET | 讨论列表（**未登录读不到**，如实返回 `available:false`） |
| `/api/v1/community/discussion` | GET / POST | 读 / 发帖（POST 返回 **201**） |
| `/api/v1/community/thread` | GET | 单帖正文 + 评论（`?repo=&number=`）；未登录同样如实返回 |
| `/api/v1/community/comment` | POST | 评论 / 嵌套回复（`discussionId` + `body` + 可选 `replyToId`，201） |
| `/api/v1/community/user` | GET | 作者资料 + 他名下的索引条目（`?login=`）；**未登录可读**，且**不回 email** |
| `/api/v1/community/reaction` | POST | 表态（8 种之一） |
| `/api/v1/community/issues` | GET | issue 列表 |
| `/api/v1/community/me` | GET | 当前登录态（**永不回 token**） |
| `/api/v1/community/auth/start` | POST | 开始 Device Flow，返回 8 位验证码 |
| `/api/v1/community/auth/poll` | POST | 轮询换 token；等待中返回 **202** |
| `/api/v1/community/auth/logout` | POST | 退出（清 `credentials` 记录） |

错误统一信封：`{ ok: false, status, reason, message, fields, requestId }`。

**写操作的两道前置检查**：① 必须登录；② 请求必须带
`Content-Type: application/json` 且 `Origin` 同源。第二条不是形式主义——
不带这个头就是「简单请求」，**不触发 CORS 预检**，一个恶意页面就能借你已登录的
浏览器发帖。JSON 头会强制预检，浏览器会先来问一句，那时才有机会拒绝。

---

### 为什么 `/plugin` 还要支持 `?pkg=`

因为 **client 半边手里只有 npm 包名，没有仓库地址**。插件详情页给你的 `subject`
长这样：`{ kind: 'bundle' | 'row', pkg?: { name }, row?: { moduleName } }`——
想「不离开详情页就显示它的社区讨论」，就必须先把包名换成仓库。

反查靠索引源里已有的 `npm` 字段（大小写不敏感，`@scope/name` 也认）。
有个真实的坑：**不是每个索引源都有 `npm` 字段**——`github-topic` 就没有。
只启用那类源时反查会 400，这是源能力差异，不是 bug。默认配置同时含 `awesome`，所以能查到。

---

## client 半边插了哪七个座位

| 座位 | 注册 id / key | 干什么 |
|---|---|---|
| `sidebar.panellist` | `community`（order 30） | 侧栏图标；**id 和主面板的 key 同名，DSH 就自动把两者连起来** |
| `main` | key `community` | 主面板社区页：**插件 / 讨论两个页签**。插件页有搜索 + 排序 + 类型筛选 + 骨架屏；讨论页未登录时给登录入口（不画发帖框），登录后有发帖表单、单帖视图、评论框、点赞按钮 |
| `plugins.detail.badge` | `community`（order 20） | 详情页标题旁的标签；无对应插件时**渲染 null** |
| `plugins.detail.section` | `community`（order 40） | 详情页里的社区区块：星级、issue、讨论、已知问题 |
| `settings.section` | `community`（order 45） | 设置页：社区仓库地址 + 登录/登出 |
| `shell.overlay` | `community-login`（order 70） | 右下角登录浮层；未登录且已配 `clientId` 时才出现 |
| `tool.call.toolview` × 4 | key = 工具名（`community_search` / `_plugin` / `_post` / `_triage`） | 四个 Agent 工具的自定义卡片：标题、参数、输出、错误 |

四个刻意的做法：

1. **`main` 用的是没人占用的 key。** 复用一个已被占用的 key 会**替换掉**那个占用者
   （比如撞上 `conversation` 就把会话面板顶掉），所以新入口一律用自己的 id。
2. **工具卡片的 key 必须与 host 侧工具名一字不差。** 对不上时宿主**静默**回落到官方通用
   卡片——界面不报错、日志也不报错，所以有一条测试直接读 `lib/core/tools.js` 比对两组名字。
   动手前也查过：`tool.call.toolview` 是 keyed 槽、`keyDomain` 是 open 的，
   四个 `community_*` 都不在已占名单里，所以这里是纯增量，不会顶掉别人的卡片。
3. **样式只用主题变量**（`--dsw-alias-*`），不写死颜色——浅色/深色主题都能跟。
4. **client 半边只读 host 半边自己那条路由**（同源 `fetch` + `credentials: 'same-origin'`），
   不碰 GitHub。凭据只在 host，永远不会进浏览器。

---

## 这个插件给自己定的红线

1. **零运行时依赖**（`dependencies` 和 `peerDependencies` 都是空的），
   `lib/` **不 import 任何 `@deepseek-ai/*`**。
   好处是 host 半边可以完全用假 ctx 在本地测，不依赖任何构建工具。
2. **零原生模块**。Android 上跑不了任何预编译的 `.node` 文件，
   而「DSH for Android」恰恰是唯一插件完全兼容的手机方案。
3. **上游全挂也不白屏**。缓存有「陈旧但可用」这一档：拿不到新数据时显示旧数据 + 提示，而不是错误页。
4. **未登录只读**。写操作先查登录态，未登录一律 401，绝不在没登录的情况下产生任何写入；
   登录后还要过 `Content-Type` + `Origin` 两道同源检查。
5. **token 不进日志、不进仓库**。token 只存在 `ctx.credentials` 里，
   插件目录下**没有任何 token 文件**。自查命令（用字符组写是为了让这条说明本身
   不触发它自己的检查）：

   ```bash
   grep -riE "gh[opsu]_|github[_]pat_" plugin/ && echo "有命中，查一下" || echo "干净"
   ```
6. **重复提交不发第二条帖**。相同标题正文在 60 秒内会返回前一条的结果并标 `deduped`，
   写操作之间强制间隔 1.2 秒，**POST 永不重试**——重复发帖比慢几秒难收拾得多。

---

## 多语言

界面支持**中文与英文**两套文案，三块地方各自决定用哪一套：

| 位置 | 怎么定语言 | 能不能改 |
|---|---|---|
| 服务端渲染的页面（`/community*`、登录页、错误页） | `?lang=` → `Accept-Language` → 中文 | 换链接即可，页面右上角有切换入口 |
| client 半边（侧栏面板、详情页区块、设置页、登录浮层） | `localStorage` 里的手动覆盖 → 浏览器语言 | 设置页「界面语言」两个按钮，**选完记住** |
| Agent 工具的输出 | 跟随索引里那条数据自己的语言（`description.zh` 优先） | — |

几个刻意的决定：

- **英文字符串里不允许出现汉字**（有一条测试专门盯着这件事）。混着写最容易在中文环境里
  看着正常、到英文环境才发现漏翻。
- 这条约束只管**界面文案**，**不管索引源里的数据**。真机上英文页面仍会夹着汉字——
  那是插件作者自己写的描述，很多条目只有中文一种。这些描述按
  `pickLocalized` 回退显示原文，而不是留空。实测：`?lang=en` 的列表页有 270 个汉字，
  几乎全部来自插件描述（唯一属于界面的两个是语言切换器里的「中文」）。
- 索引源里的描述大量只有一种语言，所以 `pickLocalized` 挑不到当前语言时会**退回另一种语言**，
  而不是显示空白——「看不懂」比「什么都没有」好。
- 相对时间（「3 天前」/「3 days ago」）是手写的，不用 `Intl.RelativeTimeFormat`：
  零依赖是红线，而且老一点的 Android WebView 未必有。
- 侧栏那个图标按钮的文字由宿主在投影时算，**要下次加载才会跟着语言变**；面板里的内容
  点一下按钮就立刻切。

---

## 已知限制

- **默认是 `sort=smart`，不是按 star 排。** 原因：`topic:dsh-plugin` 是自我声明式的
  （GitHub 的匹配是精确的，这点已验证），而 `deepseek-ai/deepseek-harness` 自己也打了这个标签，
  于是「最热的插件」榜首常年是框架本体。整个生态有 19055 个仓库带这个 topic。
  `smart` 把「框架本体 / 聚合清单 / 看不出是插件」三类**降级而不删除**——说
  「它在这，但它不是插件」比假装它不存在更诚实。`?sort=stars` 仍是**纯 star 排序**，随时可切回去。
- **`smart` 是启发式，会误伤也会漏放。** 已经知道的边界：它顶到第一的
  `tt-a1i/archify`，描述主体其实是 Claude Code / Codex 的 agent skill，只在 topics 里挂了
  `dsh-plugin`，外加发了一个 npm 包——也就是说「有 npm 包」这个信号可以被没有 DSH 专属功能的
  项目满足。同类还有 `volcengine/OpenViking`、`Tencent/WeKnora`（带 topic 的通用 AI 项目）。
  没改判据，是因为「怎么判断一个仓库真的是 DSH 插件」需要比 topic 更硬的数据源
  （上游目录的收录、README 里的安装上下文），而这类数据默认源里没有
  （岚叔目录连上过，但它明确标注 `curated 203 / autoDiscovered 452`，收录本身也不等于「是 DSH 插件」）。
  在那之前，页面底部那句「按原样提供，未做人工审核」就是这条排序的边界。
- **未认证配额是硬墙**：`api.github.com` 每小时 60 次、search 桶每分钟 10 次（按出口 IP 计）。
  所以列表页只吃索引源、只有详情页才补实时元数据——否则 30 条卡片就能打光一小时配额。
- `@vscode/ripgrep-android-arm64` 这类原生包在 Android 上根本没有，所以本插件不碰原生依赖。

---

## 真机验证（2026-10-14，抓出两个真 bug）

这个插件**已经真的被一个 DSH 进程装载过，页面也真的在浏览器里渲染出来了**。
做法是在**隔离的临时 profile** 里做，不动你在用的那个（`DSH_HOME` 指到临时目录，删掉即完全回滚）：

```cmd
set DSH_HOME=%TEMP%\dcom-dsh-home
dsh --profile min --from-default-profile web         :: 这一步不能省，见下
dsh plugin --profile min add file:<项目路径>\plugin\dsh-plugin-community-0.1.0.tgz
dsh --profile min --port 3309 --no-open
curl http://127.0.0.1:3309/community                 :: 期望 200
curl http://127.0.0.1:3309/api/v1/community/meta     :: 期望 200
```

> **`--from-default-profile web` 不能省。** 直接 `dsh --profile min` 建出来的 profile
> 只带 `@deepseek-ai/dsh-base`，没有 `@deepseek-ai/dsh-web-app`，于是插件会停在
> `pending (waiting for service: webServer)` —— 症状和「插件坏了」很像，但其实是环境缺服务。

**第一次启动是失败的**，而且失败得很安静：启动日志只有一行 `warning: 1 entry did not activate`，
两个路由都是 404 —— 而当时仓库里 202 个测试全绿、`pack-check.mjs` 通过、`verify-tarball.mjs` 也通过。
两个根因都是从 `app.asar` 里抽源码取证确认的，不是靠猜：

| # | 根因 | 真机症状 | 修法 |
|---|---|---|---|
| 1 | `Config` 不是 [Standard Schema](https://standardschema.dev) | cordis 挂载前调 `Config['~standard'].validate(config)`，`Config` 是普通对象就抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，插件**静默不激活** | 给 `Config` 加**非枚举**的 `~standard = { version: 1, vendor, validate }`（手写 10 行，不引 schemastery） |
| 2 | 用 `ctx.xxx ?? null` 读**没写进 `inject`** 的服务 | cordis 的 `ctx` 是 Proxy，get 陷阱对未 inject 的属性**一律抛** `cannot get property "X" without inject` | 统一走 `optionalService(ctx, name)`：`ctx.get(name)` 优先，属性访问只作兜底且包在 try/catch 里 |

修完复测：`/community` → **200**（33229 字节、无 `<script>`）、`/api/v1/community/meta` → **200**，
启动日志零告警。

### client 半边也在真实页面里跑起来了

用 CDP 取证（Edge `--remote-debugging-port=9223` + Node 内置 `WebSocket` 直连，
不装 puppeteer），四层：

| 层 | 证据 |
|---|---|
| 加载器**真的把我们的包列进去了** | 真实页面的 `<link rel="preload">` 合并 URL 里含 `dsh-plugin-community/client.js` |
| 取回来的**就是我们写的代码** | 445831 字节的合并 bundle 里，我们那段 60505 字节与磁盘上的 `lib/client.js` **sha256 完全相同** |
| **侧栏真的画出来了** | `button[aria-label="社区"]` 存在，里面是那个手写 svg（按 `path d="M8.6 17.2 …"` 唯一定位） |
| **面板真的渲染 + 有活数据** | 点击后出现 40 个 `dcom-*` class；`archify ★83k` / `OpenViking ★40k` / `WeKnora ★34k` 是真从 GitHub 拉的；切到「讨论」页签给出「需要登录 GitHub」+ 登录按钮，不是空壳；控制台零 error |

**还没证明的**：工具卡片要等真实会话里调一次 `community_search` 才会出现；
发帖/评论/点赞的**提交**要 `clientId` + 登录态。

> 别用 `--dump-dom`：在 `--headless=new` 下会挂住，在 `--headless=old` 下拿不到 SPA 渲染后的 DOM。
> 要的是渲染完成后的运行时状态，**只能走 CDP**。

**为什么本地测试永远抓不到这两条**：假 `ctx` 是普通对象（不会抛错），而 `apply()` 是被直接调用的
（不经过加载器的配置解析）。所以修完代码之后，**守卫本身**也一起升级了：

- `scripts/verify-tarball.mjs` 现在会检查 `Config['~standard']`（含「垃圾配置不能抛」
  与「必须非枚举」两条），而且是在**解包出来的副本**上查 —— 它才是要发出去的东西；
  假 `ctx` 也改成了 **Proxy，对未 inject 的普通属性抛错**，与真 cordis 行为一致。
- `test/guards.test.mjs` 用**变异测试**证明上面两条守卫真的有牙：把两个 bug 人为还原回去，
  断言守卫确实报警。只验证通过路径的守卫是装饰，不是守卫。

### 用真实数据跑一遍解析器（抓出 4 个真 bug）

上面那条教训的推论是：**只要拿得到真响应，就该拿真响应跑一遍解析器**。2026-10-14 岚叔目录
`https://dsh.lanshuagent.com/api/plugins` 恰好连上了（此前一直超时），拿到 **655 条真实数据**，
离线 fixture 与它一比，抓出 3 个 bug —— 其中第一个是**判据反了**：

| # | bug | 真实数据说了什么 | 后果 |
|---|---|---|---|
| 1 | 红线用白名单反推（`BENIGN_SCREENING = ['pass','ok','pending']`） | 真实取值是 `clear 61 / review 467 / pending 105 / blocked 22` —— 白名单里**既没有 `blocked` 也没有 `clear`** | 上游结论**最好**的 61 条被挂上「目录审核：clear」红线，全库 **528+ 条被涂红**；修后降到 **43 条**（= `blocked` 22 与 `caution` 32 的并集） |
| 2 | 只从 `installCommand` 取 npm 名 | 655 条里**只有 131 条**有安装命令（且全是 `github:owner/repo#sha`，推不出 npm 名），另有 **475 条只有 `manifest.packageName`** | 475 条的 npm 名是空的，而 `?pkg=`（拿 npm 包名反查仓库）正是靠这个字段工作；修后 **606/655** 条有 npm 名 |
| 3 | 只报 `screening.state` 这个枚举名 | 上游的 `findings` 自带**中英双语 label**（`发现动态代码执行入口`…） | 详情页只说「目录审核未通过」，用户不知道到底哪里不安全；现在列出 `high` 级说明（超过 4 项截断并注明还有几项），而 `medium` 级（1181 次，几乎是所有插件的常态）不进红线 |
| 4 | （顺带查出的同族问题）`dshSo.js` 把 `riskNote` **同时**推进 `capabilities` 与 `capabilityRedLines` | 代码自己的注释写着「只把真的危险放进红线」，实现却两边都放 | `capabilities` 在详情页的标题是「**它能做什么**」——把「严重风险」写在「它能做什么」底下，等于把警告伪装成功能说明 |

修完把真实数据整个跑了一遍：**655 条全部解析成功、0 条被跳过**，红线从 528+ 降到 43，
npm 名从 131 涨到 606，`blocked` 条目的红线文本从 `目录审核：blocked` 变成
`目录审核未通过：发现动态代码执行入口；发现递归删除或直接删除文件的调用`。这些都加进了
`test/sources.test.mjs`（该文件现在 23 项），用的全是上游真实取值。

> `dsh.so` 与 `dsh.works` 两个源**仍然连不上**（当天独立进程各试一次，都是 10.7 s 后
> `fetch failed`），所以它们的解析逻辑还是照上游公布的形状写的。`dshWorks.js` 复核过没有
> 第 4 类问题；`dshSo.js` 的问题已修并补了 3 项测试。**等哪天能联网，应该像岚叔这样再核一遍。**

---

## 开发

```bash
node --test "test/*.test.mjs"           # 221 个测试
node scripts/pack-check.mjs             # 发布前自检：打包清单 + 相对 import 图 + 清单字段
node scripts/verify-tarball.mjs [tgz]   # 更强的一步：从真实 tgz 解包并真的 import + apply 一次
```

> `verify-tarball.mjs` 不传参数时会先自己跑一次 `pnpm pack`（本机只有 pnpm，
> DSH 运行时里没有 npm CLI）。它比 `pack-check.mjs` 多证明一件事：
> **解出来的那棵树真的能被加载** —— 4 条路由与 4 个 Agent 工具都会注册一遍，
> 并且用的是 `cordis.patch.yml` 里那份**安装时真正生效的配置**。

> Windows 上别用 `node --test test/`，Node 24 会把它当成模块路径解析然后报
> `Cannot find module ...\test`。用 glob 形式。

测试覆盖：文本与 URL 安全、卡片归一化与合并、错误信封、缓存（含陈旧降级与并发去重）、
索引源的解析（6 个源 + 安装命令解析）、**排序治理**（框架本体 / 聚合清单 / 未知三档的降级系数、
置信度权重、稳定排序）、路由（JSON/HTML/状态码/关 JS 可用、单帖与评论、作者页、`kind` 筛选）、
host 接线（路由注册与卸载、本机限制、上游全挂时仍渲染）、写路径（幂等 / 写间隔 / 绝不重试 /
GraphQL 藏在 200 里的错误）、Device Flow（验证码不外泄 / 冷启动轮询拦在本地 / slow_down 加间隔）、
**多语言**（语言解析与优先级 / 中英键集合一致 / 英文页不混汉字 / 相对时间单复数）、
**client 半边**（bundle 形状 / 零依赖 / 七个座位 / 只 require react / 语言覆盖被记住 /
**工具卡片的 key 与 host 工具名一一对应** + 三种 phase 的渲染 + 坏形状不抛错 +
页签切换 / 发帖 POST / 评论 POST / 点赞失败退回 / 作者链接），
以及 **发布边界**（包内文件都在磁盘上、`test/` 与 `node_modules/` 不进包、体积上限、
零运行时依赖、entry point 一定在包里）、**解包验证**（`cordis.patch.yml` 的解析 /
块序列与布尔类型 / 解析出的键必须与 `lib/index.js` 的 `Config` 对得上 /
从工作区能 import + apply 并注册出 4 条路由与 4 个工具）。

一共 **221 个测试**。

索引源的 `parse()` 都是纯函数，用离线 fixture 测，不需要联网（岚叔那份额外用 655 条**真实
响应**复核过一遍，见上文「用真实数据跑一遍解析器」）。
client 半边的测试通过替换 `globalThis.window.__ModuleLoader__` 把 bundle 截下来跑，**也不需要浏览器**。

发版流程的说明**不在这个仓库里**（它是维护者自己的备忘，没有随仓库公开）。
自检脚本 `node scripts/pack-check.mjs` 会告诉你哪些文件真的会进包，以及 npm 会怎么算 `files`。

本机上 `node` / `npm` / `pnpm` 都不在 PATH，只有 DSH 运行时里那一套（而且那套**没有 npm CLI**）。
所以仓库里放了一个包装脚本，把路径拼好：

```cmd
scripts\publish.cmd check     :: 自检 + 跑测试，不发布
scripts\publish.cmd login     :: 登录 registry（需要真实交互终端）
scripts\publish.cmd whoami    :: 看当前登录的是谁
scripts\publish.cmd           :: 全套：自检 → 测试 → 查登录 → 查工作区 → 发布
```

## 许可证

MIT
