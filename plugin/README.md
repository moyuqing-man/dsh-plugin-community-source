# dsh-plugin-community

**DSH 插件社区** —— 把 GitHub Discussions 变成插件的讨论区、Issues 变成 bug 汇报入口、Stars 变成评分。

> English version: [README.en.md](./README.en.md)

> ⚠️ **这是一个 demo（0.1.0），不是稳定版。** 代码写完了、153 个测试全绿，但有三处**还没在真实环境里验证过**：
> 工具卡片（需要一台装了本插件的 DSH 真机跑一次）、`dsh.so` / `dsh.works` / 岚叔目录三个索引源
> （开发机连不上它们，只用离线 fixture 测过解析逻辑）、以及 npm 上的真实打包结果。
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
| 插件详情页里嵌社区讨论（不离开当前页面） | ✅ 可用 |
| Agent 工具（`community_search` 等 4 个） | ⏳ M4 |
| 发布到 npm | ⏳ M4 |

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

---

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `owner` | `moyuqing-man` | 社区仓库归属 |
| `repo` | `dsh-plugin-community` | 社区仓库名 |
| `allowRemote` | `false` | **默认只允许本机访问**。想让手机/局域网访问必须显式开成 `true` |
| `cacheTtlMinutes` | `60` | 索引缓存新鲜期 |
| `sources` | `['github-topic','awesome']` | 启用哪些索引源 |
| `userAgent` | `dsh-plugin-community/0.1.0` | 请求 GitHub 时带的 UA |
| `prewarm` | `true` | 启动后延迟预热体积大的源 |

`owner` / `repo` **是配置项，不写死在代码里**——换仓库只改这两行。

---

## 路由

### 页面（服务端渲染，关掉 JavaScript 也能看）

| 路径 | 说明 |
|---|---|
| `/community` | 插件列表，支持 `?q=&category=&sort=&page=` |
| `/community/plugin?repo=owner/name` | 插件详情 |
| `/community/t?id=<discussion>` | 302 跳转到 GitHub，**不二次托管讨论正文** |
| `/community/u?login=<user>` | 按作者看帖子 |

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
| `/api/v1/community/discussions` | GET | 讨论列表 |
| `/api/v1/community/discussion` | GET / POST | 读 / 发帖（POST 返回 **201**） |
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
| `main` | key `community` | 主面板社区页（搜索 + 列表 + 跳完整页面） |
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

- **按 star 排序会把框架本体顶到最上面。** `topic:dsh-plugin` 是自我声明式的
  （GitHub 的匹配是精确的，这点已验证），而 `deepseek-ai/deepseek-harness` 自己也打了这个标签。
  整个生态有 19055 个仓库带这个 topic，于是「最热的插件」里混进了很多并不是插件的大仓库。
  默认排序暂时保持 star（符合直觉），后续打算加一个混合评分或可配置的排除名单。
- **未认证配额是硬墙**：`api.github.com` 每小时 60 次、search 桶每分钟 10 次（按出口 IP 计）。
  所以列表页只吃索引源、只有详情页才补实时元数据——否则 30 条卡片就能打光一小时配额。
- `@vscode/ripgrep-android-arm64` 这类原生包在 Android 上根本没有，所以本插件不碰原生依赖。

---

## 开发

```bash
node --test "test/*.test.mjs"     # 151 个测试
node scripts/pack-check.mjs       # 发布前自检：打包清单 + 相对 import 图 + 清单字段
```

> Windows 上别用 `node --test test/`，Node 24 会把它当成模块路径解析然后报
> `Cannot find module ...\test`。用 glob 形式。

测试覆盖：文本与 URL 安全、卡片归一化与合并、错误信封、缓存（含陈旧降级与并发去重）、
索引源的解析（6 个源 + 安装命令解析）、路由（JSON/HTML/状态码/关 JS 可用）、
host 接线（路由注册与卸载、本机限制、上游全挂时仍渲染）、写路径（幂等 / 写间隔 / 绝不重试 /
GraphQL 藏在 200 里的错误）、Device Flow（验证码不外泄 / 冷启动轮询拦在本地 / slow_down 加间隔）、
**多语言**（语言解析与优先级 / 中英键集合一致 / 英文页不混汉字 / 相对时间单复数）、
**client 半边**（bundle 形状 / 零依赖 / 七个座位 / 只 require react / 语言覆盖被记住 /
**工具卡片的 key 与 host 工具名一一对应** + 三种 phase 的渲染 + 坏形状不抛错），
以及 **发布边界**（包内文件都在磁盘上、`test/` 与 `node_modules/` 不进包、体积上限、
零运行时依赖、entry point 一定在包里）。

一共 **151 个测试**。

索引源的 `parse()` 都是纯函数，用离线 fixture 测，不需要联网。
client 半边的测试通过替换 `globalThis.window.__ModuleLoader__` 把 bundle 截下来跑，**也不需要浏览器**。

发版流程的说明**不在这个仓库里**（它是维护者自己的备忘，没有随仓库公开）。
自检脚本 `node scripts/pack-check.mjs` 会告诉你哪些文件真的会进包，以及 npm 会怎么算 `files`。

## 许可证

MIT
