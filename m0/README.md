# M0 · 可行性验证与社区仓库启动包

> 本目录是 [07-路线图与验收](../docs/07-路线图与验收.md) 第 2 节「M0 · 可行性验证」的可交付物。
> **M0 不写产品代码**，只做两件事：把可能推翻设计的假设验证掉，把社区仓库的地基文件准备好。

---

## 1. 这个目录里有什么

| 文件 | 是什么 | 什么时候用 |
|---|---|---|
| [M0-VERIFICATION.md](M0-VERIFICATION.md) | **M0 的正式产出物**：三个假设的结论/证据/影响 + 剩余 POC 的执行清单 | 先读这个 |
| `community-repo/` | **社区仓库的启动包**：一组可直接提交到 GitHub 的文件 | 你能登录 GitHub 时，整包搬进新仓库 |
| `community-repo/docs/discussions-categories.md` | Discussions 分类的**手工初始化清单**（分类不能在代码里创建） | 建仓库时照着点 |
| `community-repo/docs/seed-posts.md` | 首发帖文案 | 仓库建好后发前 3 个帖 |

---

## 2. 三分钟用起来

**目标状态**：一个公开仓库 `moyuqing-man/dsh-plugin-community`，Discussions 开着，有 6 个分类、4 个发帖表单、3 个 Issue 表单。

```
① 在 GitHub 上新建公开仓库           dsh-plugin-community（不要勾任何模板）
② 把 community-repo/ 里的东西推上去  内容直接复制到仓库根目录
③ Settings → Features → 勾 Discussions
④ 按 docs/discussions-categories.md 逐个建 6 个分类
⑤ 按 docs/seed-posts.md 发前 3 个帖
```

> ⚠️ **第 ③ 步不能跳**。仓库不勾 Discussions，第 ④ 步的分类页都不会出现，
> 而 [08 §3.1](../docs/08-GitHub-API-契约.md) 里那条「写路径必须走 GraphQL」的结论也建立在 Discussions 已开启之上。

---

## 3. 名字是占位的，改起来是一处替换

第 [07](../docs/07-路线图与验收.md) 第 10 节的 5 个待决问题还没拍板，所以 M0 的启动包**用了默认值**，把决定推迟而不是卡住：

| 项 | M0 用的默认值 | 想改的话 |
|---|---|---|
| 仓库位置 | `moyuqing-man/dsh-plugin-community`（个人账号下） | 换成组织：只改仓库地址，文件不用动 |
| 社区名 | **DSH 插件社区** | 全局替换这一个词 |
| 语言 | 中文为主（英文摘要附在 README 末尾） | — |

**这些默认值不写死在插件里**。按 [02-总体架构](../docs/02-总体架构.md)，`owner` / `repo` 是插件的配置项，所以换仓库=改一行配置，不是改代码。

---

## 4. 与 M1 的边界

M0 只产出**能被人看懂、能被 GitHub 直接消费的文件**。以下都**不属于** M0：

- ❌ DSH 插件本体（`package.json` / `cordis.patch.yml` / client bundle）—— 那是 M1/M3
- ❌ `/community` 页面与 JSON API —— M1
- ❌ Device Flow 登录 —— M2

**M0 不通过就不要进 M1。** 判据见 [M0-VERIFICATION.md](M0-VERIFICATION.md) 第 4 节。

---

## 5. 启动包里哪些文件是「GitHub 会读的」

不是普通文档，格式错了 GitHub 会静默忽略：

| 路径 | 谁读它 | 关键约束（已按官方文档核对） |
|---|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` | GitHub Issue 表单渲染器 | 顶层必须有 `name`/`description`/`body`；**`name` 必须 >3 字符**否则不显示 |
| `.github/ISSUE_TEMPLATE/config.yml` | 模板选择页 | `blank_issues_enabled: false` + `contact_links` |
| `.github/DISCUSSION_TEMPLATE/*.yml` | Discussions 发帖表单 | **文件名必须 = 分类的 slug**；**没有** `name`/`description`，只有 `body`(+可选 `labels`/`title`) |
| `README.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` | GitHub 社区健康度检查 | 这四个文件的存在本身会被 GitHub 识别为「社区健康」 |

来源：GitHub 官方文档仓库原始 markdown（[Issue 表单语法](https://github.com/github/docs/blob/main/content/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms.md)、[表单 schema](https://github.com/github/docs/blob/main/content/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema.md)、[Discussion 分类表单](https://github.com/github/docs/blob/main/content/discussions/managing-discussions-for-your-community/creating-discussion-category-forms.md)）。
