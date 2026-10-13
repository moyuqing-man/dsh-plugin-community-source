# 发布到 npm

这份文档写给「拿到这个包、准备把它发出去」的人。**所有需要账号凭据的步骤都标了 🧑 —— 那些步骤本仓库不代劳，只能你自己在终端里做。**

---

## 0. 先跑自检

```sh
cd plugin
node scripts/pack-check.mjs
```

它做三件事：

1. **复算 npm 的打包规则**（`files` 字段 + npm 永远包含/永远排除的那些文件），列出真实会进包的文件和总体积；
2. **顺着相对 import 图走一遍** —— 从 `main` / `exports` 各目标 / `dsh.bundle.patch` 出发，确认每个被 import 的文件都在打包集内。这一步专抓 `import '../../m0/xxx.js'` 这种「本地测试全绿、装包的人一跑就炸」；
3. **查清单必备字段**：`name`/`version`/`license`/`main`/`exports`/`publishConfig.access=public`、`dependencies` 必须为空（这是本项目的红线：纯 JS、零运行时依赖）。

有问题时退出码为 1。

> **它证明不了什么**：真实 npm 的 glob 细节、`.npmignore` 交互、registry 端校验。有网络之后请再跑一次 `npm pack --dry-run` 复核。

---

## 1. 两个仓库怎么分（已定案）

本项目推两个**互相独立**的公开仓库，各推各的：

| 仓库 | 放什么 | 本地仓库根 | 为什么分开 |
|---|---|---|---|
| [`moyuqing-man/dsh-plugin-community-source`](https://github.com/moyuqing-man/dsh-plugin-community-source) | 插件源码（`plugin/`）、方案文档（`docs/`）、M0 文档与 POC（`m0/*.md`、`poc/`） | 项目根目录 | 有可执行代码，是这个 npm 包的家 |
| [`moyuqing-man/dsh-plugin-community`](https://github.com/moyuqing-man/dsh-plugin-community) | 社区仓库：README、行为准则、Issue/Discussion 表单（`m0/community-repo/`） | `m0/community-repo/` | `SECURITY.md` 对外承诺「本仓库不含任何可执行代码」——把它和源码分开，这句话才是真的 |

`package.json` 已经填好指向源码仓库，并且因为包在 `plugin/` 子目录里，带了 `"directory": "plugin"`：

```jsonc
"repository": {
  "type": "git",
  "url": "git+https://github.com/moyuqing-man/dsh-plugin-community-source.git",
  "directory": "plugin"
},
"homepage": "https://github.com/moyuqing-man/dsh-plugin-community-source#readme",
"bugs": { "url": "https://github.com/moyuqing-man/dsh-plugin-community-source/issues" }
```

本地两个仓库的 `.git` 位置：项目根目录下一个，`m0/community-repo/` 下一个。项目根的 `.gitignore` 里排除了 `/m0/community-repo/`——不然 git 会把它当成嵌套子模块，推上去是个空目录。

> 换仓库的话：改上面的 URL、改 `plugin/cordis.patch.yml` 里的 `owner`/`repo`（那是**社区**仓库，用来读 Discussions），再改 `m0/community-repo/` 里约 30 处讨论区链接。缺 `repository` 字段不会导致发布失败，只是 npm 页面上少一个「源码」入口。

### 推上去（本地的 `git init` 与首次提交已经做好）

🧑 **先在网页上建两个空仓库**：<https://github.com/new> → 名字分别填 `dsh-plugin-community-source` 和 `dsh-plugin-community`。**不要**勾选 Add a README / .gitignore / license——仓库非空的话第一次 `git push` 会被拒。

然后两条命令各推一个仓库：

```sh
# 源码仓库（仓库根 = 项目根目录）
cd "C:\Users\29427\Desktop\插件生态论坛插件"
git remote add origin https://github.com/moyuqing-man/dsh-plugin-community-source.git
git push -u origin main

# 社区仓库（仓库根 = m0/community-repo）
cd "C:\Users\29427\Desktop\插件生态论坛插件\m0\community-repo"
git remote add origin https://github.com/moyuqing-man/dsh-plugin-community.git
git push -u origin main
```

第一次 `git push` 会弹一次浏览器，让你授权 GitHub（Git for Windows 自带的凭据管理器；你机器上 GitHub Desktop 3.6.3 已装、Git 全局身份已经是 `moyuqing-man <3538481552@qq.com>`，直接确认即可）。推完之后，这两个目录也能在 GitHub Desktop 里用「File → Add local repository」加进来做图形化管理。

### 建仓库时直接粘：About 描述与 Topics

GitHub 的仓库描述**带不上去**——`git push` 只推文件，About 与 Topics 只能用网页或 API 设置。所以建仓库时一起填掉最省事，下面是写好的文案。

**`dsh-plugin-community-source`**（源码 + 方案文档）

- **Description**
  > DSH 插件社区：把 GitHub Discussions 变成插件讨论区、Issues 变成 bug 汇报入口、Stars 变成评分，插件详情页里就能看到社区在说什么。纯 JS、零原生依赖。 / A community layer for DSH plugins — discussions, bug inbox and ratings, right inside the plugin detail page.
- **Topics**：`dsh` `dsh-plugin` `deepseek-harness` `plugin-community` `github-discussions`

**`dsh-plugin-community`**（社区仓库）

- **Description**
  > DSH 插件社区的讨论与反馈入口：插件展示 / 求助 / 想法与需求 / 已知问题。**本仓库不含任何可执行代码**（见 SECURITY.md）。 / Discussion and feedback hub for the DSH plugin community. Contains no executable code.
- **Topics**：`dsh` `dsh-plugin` `deepseek-harness` `community` `discussions`

两处 Description 都控制在 350 字符以内（GitHub 的上限）。npm 包自身的 `description` 已经写在 `package.json` 里，是中英双语，不用重复填。

---

## 2. 首次发布（🧑 = 需要你的账号）

```sh
# 1. 确认包名没被占（🧑 需要网络）
npm view dsh-plugin-community

# 2. 登录（🧑 浏览器 OTP / 2FA）
npm login
npm whoami

# 3. 真正的 dry run：这一步会打印最终文件清单，和上面的自检对照
npm pack --dry-run

# 4. 发布。scope 包要带 --access public；本包不是 scope 包，但加上无害
npm publish --access public
```

**这一步之后就不能回头改内容了**——npm 同一版本号只允许发布一次。

---

## 3. 发布后验证（🧑）

```sh
npm view dsh-plugin-community            # 元数据、版本、体积
npm view dsh-plugin-community dist.tarball
npm install dsh-plugin-community         # 在空目录里试装一次
```

然后按 `README.md` 的「装进 DSH」一节把它装进 profile，重启 DSH，访问 `http://127.0.0.1:<端口>/community` 确认页面出得来。

---

## 4. 之后每次发版

1. 改 `package.json` 的 `version`（本项目按语义化版本：破坏性改动 → major，新能力 → minor，修 bug → patch）；
2. 在 `README.md` 与 `README.en.md` **两边**都更新「现在能用什么 / What actually works right now」；
3. 跑 `node --test "test/*.test.mjs"` 与 `node scripts/pack-check.mjs`；
4. 重复第 2 节的第 3、4 步。

> 两份 README 的章节数有测试守着（`test/i18n.test.mjs` 里的「两份 README 的章节数一致」），只更新一种语言会被测试拦下。

---

## 5. 如果发错了

- **72 小时内**：`npm unpublish dsh-plugin-community@<version>`（🧑）。已经有人装过的话，这个操作会让他们下次安装失败。
- **72 小时后**：`unpublish` 基本没用了，只能**发一个新版本**修掉，然后在 npm 上 `npm deprecate dsh-plugin-community@<version> "<原因>"`（🧑）标记旧版本。
- 所以「先 `npm pack --dry-run` 看一眼」永远比事后撤回便宜。

---

## 6. 这个包不包含什么

| 不在包里 | 为什么 |
| --- | --- |
| `test/` | 不发布测试；`pack-check.mjs` 会拦下混进去的 `.test.mjs` |
| `scripts/` | 不在 `files` 里；发布清单里也不会出现 |
| `node_modules/` | npm 永远排除 |
| 任何凭据 | 红线：token 只存在 `ctx.credentials` 里，`.env` / `*.pem` / `*.key` 这类文件如果出现在打包集内，自检会直接报错 |
