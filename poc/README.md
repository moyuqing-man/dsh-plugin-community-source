# POC 验证器

把 [docs/08-GitHub-API-契约.md](../docs/08-GitHub-API-契约.md) 里的每一条结论，变成**可复现的接口证据**。

> **这是验证脚本，不是插件骨架。** 它不依赖 DSH 运行时、不注册任何 slot、不 import 任何 `@deepseek-ai/*`。
> 它只回答一个问题：**GitHub 到底能不能这么用？** 插件代码要等这里全部跑通再写。

---

## 0. 它验证什么

> ✅ **已实测完成、且不需要 token 的三项**：**POC-0**（匿名可读 Discussions）、**POC-2**（REST 无 discussions 写接口，写只能走 GraphQL）、**POC-6**（304 条件请求照样吃配额）。三项都由 `probe` 一键复现。

| 命令 | 对应 POC | 回答的问题 | 需要 token |
|---|---|---|---|
| `probe` | **POC-0 + POC-2** | 匿名能读什么？60/hr 卡在哪？REST 到底有没有写接口？ | ❌ |
| `probe --etag` | POC-6 | 304 条件请求算不算配额？ | ❌ |
| `login` | POC-1 | Device Flow 在真实环境能不能走通？ | ❌（但需要 client_id） |
| `token <PAT>` | — | ⭐ 捷径：贴一个 PAT 直接登录，跳过建 OAuth App | 你自己提供 |
| `status` | — | 我是谁？配额还剩多少？门控放不放行？ | ✅ |
| `poc2` | POC-2（认证版交叉验证，**可选**） | 用真 token 再确认一次：写路径确实只能走 GraphQL | ✅ |
| `poc3` | POC-3 | 建帖 → 评论 → **REST 回读** 整条链路通不通？**契约已由官方文档逐字核实**（见 [08](../docs/08-GitHub-API-契约.md) §3.1），现在只剩「亲手发一个帖」 | ✅ |
| `poc4` | POC-4 | ~~`read:user public_repo` 够不够？~~ **✅ 已由官方文档定论，无需实跑**：公开仓库就是 `public_repo` | ✅ |
| `all` | 组合 | 一次跑完 probe + login + status + poc2 + poc4 | 两者 |

**POC-7（非协作者能否建 Discord/讨论）脚本做不了** —— 它需要一个**另一个普通账号**，属于人工步骤，见 [docs/04](../docs/04-身份与登录.md) 第 8 节。

---

## 1. 前置：Node

系统 PATH 里没有 `node`。用 DSH 自带的（实测 **v24.21.0**）：

```
C:\Users\29427\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
```

下文用 `$NODE` 代指它。想省事就在当前窗口先设一次：

```powershell
$NODE = "C:\Users\29427\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
```

**零依赖** —— 没有 `package.json`、不需要 `npm install`。只用 Node 18+ 内置的 `fetch`。

---

## 2. 两条路线，先选一条

| 路线 | 代价 | 能验证什么 |
|---|---|---|
| **A. Personal Access Token（推荐先做）** | 30 秒 | POC-3（亲手发帖）；POC-4 已由官方文档定论、无需实跑 |
| **B. OAuth App + Device Flow** | 2 分钟（且必须记得勾 `Enable Device Flow`） | 以上全部，**外加 POC-1**（登录流程本身跑不跑得通） |

**两者能验证的 API 边界完全一样** —— 路线 B 只多验证「怎么拿到 token」这一件事。所以建议先用 A 把 API 问题钉死，再用 B 验证登录体验。

### 路线 A：直接贴一个 Personal Access Token

```powershell
& $NODE run.mjs token ghp_你的token
```

token 在 <https://github.com/settings/tokens> → **Generate new token (classic)**，勾 `read:user` 和 `public_repo`。

脚本会先拿它打一次 `/user` 校验，成功了才存到 `poc/.token.json`（已 gitignore，**永不进 `results/`**）。之后 `status` / `poc2` / `poc3` / `poc4` 全部可用。

> ⚠️ 这条命令**只是验证期的捷径** —— 真插件必须走 Device Flow（不能让用户去手工造 PAT）。路线 A 存在的唯一理由是：验证 API 边界不需要先建 OAuth App。

### 路线 B：建测试 OAuth App（约 2 分钟）

1. 打开 <https://github.com/settings/developers> → **New OAuth App**
2. 填写（除了名字都可以随便填，Device Flow 用不到回调）：

   | 字段 | 值 |
   |---|---|
   | Application name | `DSH 插件社区 POC` |
   | Homepage URL | 你的仓库地址即可 |
   | Authorization callback URL | `http://127.0.0.1` （Device Flow 不用，但必填） |

3. 创建后复制 **Client ID**（形如 `Ov23li…`）
4. ⚠️ **在同一个页面勾选 `Enable Device Flow` 并保存**

> **漏了第 4 步不会在创建时报错**，只会在轮询时返回 `device_flow_disabled`。脚本会明确提示你去哪勾选。

5. 不需要 `Client Secret`。**Device Flow 全程不用 client_secret** —— 这是它相对 web flow 最大的好处（手机端/CLI 不用藏密钥）。

---

## 3. 配置

```powershell
cd C:\Users\29427\Desktop\插件生态论坛插件\poc
Copy-Item config.example.json config.json
```

编辑 `config.json`：

```json
{
  "clientId": "Ov23liXXXXXXXXXXXXXX",
  "scope": "read:user public_repo",
  "repo": "your-name/dsh-plugin-community",
  "categoryName": "General"
}
```

**scope 必须正好是 `read:user public_repo`**：

- `read:user` —— 读登录者身份
- `public_repo` —— 写公开仓库（建讨论属于这一类）
- ❌ **不要写 `read:discussion` / `write:discussion`** —— 这两个**不是 OAuth scope**，写了会被静默忽略，然后写操作失败。详见 [docs/08 §4](../docs/08-GitHub-API-契约.md)
- ❌ **不要加 `offline_access`** —— 加上会让 token **8 小时过期**并强制引入 refresh 流程，社区插件不需要
- 想要更小权限可以试 `public_repo` 单独一个，但读身份会受限

`config.json`、`.token.json`、`results/` 都已在 `.gitignore` 里。

---

## 4. 准备测试仓库

`probe` 不需要仓库（默认拿 `giscus/giscus` 当靶子，只读）。
`poc2`/`poc3`/`poc4` 需要一个**你自己的**测试仓库：

1. 建一个公开仓库，例如 `dsh-plugin-community-poc`
2. **Settings → General → Features → 勾选 `Discussions`**（不勾会得到 `hasDiscussionsEnabled: false`，脚本会提示你去开）
3. 进入 **Discussions 标签页 → 分类管理**，确认至少有一个分类（默认会有 `General` / `Announcements` 等）
4. 把仓库名填进 `config.json` 的 `repo`

> 目的是**先在一个随便造的仓库上把链路跑通**，确认无误后再对真正的社区仓库操作。

---

## 5. 跑

```powershell
$NODE = "C:\Users\29427\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

# 第一步：匿名探测（不吃 token，约 11 次请求）
& $NODE run.mjs probe

# 只跑一次就够，想复现 POC-6 再加 --etag（额外 6 次请求）
& $NODE run.mjs probe --etag

# 第二步：登录（会打印一次性代码，去浏览器输入）
& $NODE run.mjs login

# 第三步：写路径
& $NODE run.mjs status
& $NODE run.mjs poc2
& $NODE run.mjs poc4

# 第四步：先预演（不发帖），确认好了再加 --yes
& $NODE run.mjs poc3
& $NODE run.mjs poc3 --yes
```

`poc3` **默认只预演**：它会打印将要发送的 mutation、选中的分类，但不真的发帖。加 `--yes` 才发。

---

## 6. 结果怎么看

每次运行都会把证据写到 `poc/results/<时间戳>-<命令>.json`（已 gitignore）。

证据里包含**真实的 HTTP 状态码、响应头里的配额数字、以及截断的响应体**，写文档时直接引用它，不用再复现一遍。

**token 不会进证据文件**：`lib/store.mjs` 的 `redact()` 会把 `access_token` / `refresh_token` / `device_code` 等字段替换成 `***REDACTED***`，并且 `run.mjs` 全程不打印 token 本体。

每次跑完请把**判定结论**（不是原始 JSON）回填到 [docs/08](../docs/08-GitHub-API-契约.md) 第 10 节的 POC 表，并把「未实测」改成实测值。

---

## 7. 已知的坑（都是实测或官方文档确认过的）

| 坑 | 现象 | 处理 |
|---|---|---|
| **没开 Device Flow** | `device_flow_disabled` | 去 OAuth App 设置勾 `Enable Device Flow` |
| **轮询太快** | `slow_down` | 官方规定 interval +5 秒，**且错误响应里会带新的 interval**，脚本优先采信响应值 |
| **设备码过期** | `expired_token` / `token_expired`（文档里两种写法都出现过） | 默认 15 分钟，重跑 `login` |
| **验证码提交限流** | 用户侧提交验证码限 **50 次/小时/应用** | 反复重试会撞上，别狂点 |
| **未认证只有 60/hr** | `API rate limit exceeded for <你的IP>` | ⚠️ **按来源 IP 计费** —— NAT 后面所有人共用。这是「缓存 + 配额调速器」是必需品而非优化项的根因 |
| **search 单独限 10/分钟** | 上面那条 60/hr 还够，search 却先 403 | search 是独立桶，排行榜类功能要单独算预算 |
| **未认证 GraphQL = 0** | `POST /graphql` 返回 403 | 未认证时讨论分类、写操作全部不可用，只能走 REST 只读 |
| **REST 没有 discussions 写接口** | `POST /repos/{r}/discussions` → **404**，而同样未认证的 `POST /repos/{r}/issues` → **401** | 判据：未认证时「存在但需鉴权」=401、「不存在」=404。故**建帖/评论只能走 GraphQL mutation**，`read/write:discussion` 也从不是 OAuth scope |
| **304 也吃配额** | 配额莫名减少 | `If-None-Match` 只省带宽，**不省配额**，不要用它来提高轮询频率 |
| **`/rate_limit` 不耗配额** | — | ✅ 这是**唯一**可信的免费预算探针，调速器就靠它 |

---

## 8. 目录结构

```
poc/
├─ run.mjs                 CLI 入口 + 各 POC 的实现
├─ lib/
│  ├─ gh.mjs               HTTP 层：api() / graphql() / oauth() / budget() / ensureBudget()
│  ├─ deviceflow.mjs       Device Flow：官方错误码 → 可操作的中文提示
│  └─ store.mjs            配置 / token / 证据落盘（含脱敏）
├─ config.example.json     复制成 config.json
├─ .gitignore              忽略 config.json / .token.json / results/
└─ results/                每次运行的证据（自动创建）
```

`lib/gh.mjs` 里 `ensureBudget()` 是**配额调速器的最小实现**：跑一批请求前先探免费预算，低于底线就拒绝并降级为纯缓存。这段逻辑之后会原样搬进插件，所以故意写得独立、无副作用。
