/**
 * 多语言文案。
 *
 * 为什么不用 `Intl` 或任何第三方库：
 *   - 本项目有 **零运行时依赖** 红线（Android host 上装不了原生模块，连构建工具都没有）；
 *   - 需要的只是「一张表 + 一次查表 + `{name}` 占位符替换」，`Intl` 帮不上忙。
 *
 * 为什么默认是中文而不是英文：
 *   社区仓库、模板、README 都以中文为主，用户群也是中文用户。**没有明确语言信号时给中文**
 *   比给英文更少让人意外；但只要浏览器说了偏好英文，就会走英文。
 *
 * 语言信号的优先级（从高到低）：
 *   1. URL 上的 `?lang=`（用户点过切换，页面里所有链接都会带上它，所以能粘住）
 *   2. `Accept-Language` 请求头（按 q 值排序，只认 zh / en）
 *   3. `DEFAULT_LOCALE`
 */

export const LOCALES = ['zh', 'en']

export const DEFAULT_LOCALE = 'zh'

/** 语言切换器上显示的短标签。用各自的语言写，免得英文用户看到两个汉字。 */
export const LOCALE_LABELS = { zh: '中文', en: 'English' }

const MESSAGES = {
  zh: {
    // ---------------------------------- 外壳 ----------------------------------
    'html.lang': 'zh-CN',
    'site.name': 'DSH 插件社区',
    'foot.disclaimer': '数据来自公开索引与 GitHub API，按原样提供，未做人工审核。装任何插件前请自己看一眼源码。',
    'foot.ssr': '这个页面是服务端渲染的，不执行 JavaScript —— 手机上、关闭 JS 的浏览器里都能看。',
    'nav.langSwitch': '语言',

    // ---------------------------------- 账号 ----------------------------------
    'nav.loggedInAs': '已登录为',
    'nav.unknownUser': '（未知用户）',
    'nav.scopes': '授权',
    'nav.loggedOut': '未登录：现在只能看，不能发帖或评论。',
    'nav.switchAccount': '换个账号',
    'nav.login': '用 GitHub 登录',

    // ---------------------------------- 索引页 ----------------------------------
    'index.title': 'DSH 插件社区',
    'index.titleQuery': '搜索「{query}」 · DSH 插件社区',
    'index.description': 'DSH（DeepSeek Harness）插件索引，共 {known} 个条目。',
    'index.summary':
      '索引了 **{known}** 个插件条目 · 搜到 **{total}** 条 · 其中有 npm 包的 {npm} 个 · 已归档 {archived} 个',
    'index.searchPlaceholder': '搜插件名、作者、说明、能力…',
    'index.searchLabel': '搜索插件',
    'index.searchButton': '搜索',
    'index.byCategory': '按分类',
    'index.sort': '排序',
    'index.all': '全部',
    'index.empty': '没有匹配的结果。换个关键词，或者清清筛选。',
    'index.pagerPrev': '← 上一页',
    'index.pagerNext': '下一页 →',
    'index.byKind': '按类型',
    'index.kindTip':
      '**「综合排序」在压住两类噪声**：`topic:dsh-plugin` 是自我声明的标签，谁都能打，所以官方框架本体和「清单仓库」都会混进来。这里把它们降级而不是删掉——说清「它在这，但它不是插件」，比假装不存在更诚实。',
    'index.kindAll': '全部类型',
    'kind.framework': '框架本体',
    'kind.aggregator': '聚合清单',
    'kind.plugin': '插件',
    'kind.unknown': '未归类',
    'card.kindTag': '类型：{label}',
    'card.authorLink': '作者主页',

    // ---------------------------------- 排序 ----------------------------------
    'sort.smart': '综合排序',
    'sort.stars': '按 star',
    'sort.downloads': '按下载量',
    'sort.recent': '按收录时间',
    'sort.name': '按名称',

    // ---------------------------------- 作者页 ----------------------------------
    'user.title': '{login} 的插件 · DSH 插件社区',
    'user.description': '{login} 在 DSH 插件索引里的条目。',
    'user.heading': '作者',
    'user.plugins': '收录的插件',
    'user.none': '索引里还没有这个作者的插件。',
    'user.notFound': 'GitHub 上没有叫 {login} 的用户。下面是索引里同名作者的条目。',
    'user.unavailable': '暂时读不到 GitHub 资料（{reason}）。下面只显示索引里的条目。',
    'user.repos': '公开仓库',
    'user.followers': '关注者',
    'user.joined': '注册于',
    'user.profile': 'GitHub 主页',
    'user.count': '索引里有 {count} 个条目',
    'user.backToUser': '← 回到 {login} 的主页',
    'user.ownerBadge': '作者主页',

    // ---------------------------------- 卡片 ----------------------------------
    'card.noDescription': '（这个条目没有写说明）',
    'card.perWeek': '/周',
    'card.archived': '已归档',
    'card.lastPush': '最后提交 {when}',
    'card.sources': '来源 {list}',

    // ---------------------------------- 提示条 ----------------------------------
    'sources.partial': '**有索引源没取到数据**：{list}。下面显示的是能取到的部分。',
    'sources.stale': '部分数据是缓存里的旧副本（上游暂时取不到），可能不是最新的。',

    // ---------------------------------- 详情页 ----------------------------------
    'detail.back': '← 回到插件索引',
    'detail.title': '{name} · DSH 插件社区',
    'detail.description': '{repo} 的社区信息',
    'detail.archived': '这个仓库已归档，作者不再维护。',
    'detail.noDescription': '（没有写说明）',
    'stat.stars': 'Star',
    'stat.openIssues': '未关 Issue',
    'stat.pushedAt': '最后提交',
    'stat.license': '许可证',
    'stat.starsIndexed': 'Star（索引值）',
    'stat.sources': '来源',
    'stat.unknown': '未知',
    'stat.undeclared': '未声明',
    'detail.install': '安装',
    'detail.noInstall': '这个插件没有登记安装命令。请到仓库的 README 里看怎么装。',
    'detail.capabilities': '它能做什么',
    'detail.redLines': '它明确不做的事',
    'detail.issuesHeading': '已知问题（GitHub Issues）',
    'detail.discussionsHeading': '社区讨论（GitHub Discussions）',
    'detail.issuesEmpty': '目前没有开着的 Issue。',
    'detail.issuesUnavailable': '取不到 Issue 列表。可以直接去 {link} 看。',
    'detail.issuesUnavailableWhy': '取不到 Issue 列表（{reason}）。可以直接去 {link} 看。',
    'detail.discussionsEmpty': '这个仓库还没有开讨论。',
    'detail.discussionsUnavailable': '暂时读不到讨论列表。可以先去 {link} 看看。',
    'detail.discussionsUnavailableWhy': '暂时读不到讨论列表（{reason}）。可以先去 {link} 看看。',
    'detail.discussionsTokenRequired':
      '讨论列表需要登录 GitHub 后才能读取（未认证时 GraphQL 配额为 0）。可以先去 {link} 看看。',
    'detail.repoIssuesLink': '仓库的 Issue 页',
    'detail.repoDiscussionsLink': '仓库的 Discussions',
    'detail.disclaimer': '这里显示的都是 GitHub 上的原始内容，本社区不做审核也不做背书。插件的问题请去{link}提。',
    'detail.disclaimerLink': '它自己的仓库',
    'detail.colNumber': '#',
    'detail.colTitle': '标题',
    'detail.colState': '状态',
    'detail.colCategory': '分类',
    'detail.colReplies': '回复',

    // ---------------------------------- 错误页 ----------------------------------
    'error.requestId': '请求编号',
    'error.back': '← 回到插件索引',
    'error.pluginNotFound': '索引里没有 {repo}。可能是没被任何索引源收录，或者仓库名写错了。',
    'error.discussionNotHosted': '讨论不在这里托管。请到 GitHub Discussions 里看原帖。',
    'error.pageNotFound': '没有这个页面：{path}',

    // ---------------------------------- 登录页 ----------------------------------
    'login.title': '用 GitHub 登录',
    'login.pageTitle': '用 GitHub 登录 · DSH 插件社区',
    'login.pageDescription': '用 GitHub Device Flow 登录 DSH 插件社区：只需要输入一个 8 位验证码。',
    'login.intro': '不用在这里填任何表单，也不用交给我们任何密码或密钥。只要把这串码敲到 GitHub 上。',
    'login.alreadyIn': '你已经是登录状态（{login}）。',
    'login.backToIndex': '回到索引',
    'login.cannotStart': '现在发不起登录流程',
    'login.codeLabel': '在 GitHub 上输入这串码',
    'login.codeHint': '大约还剩 {seconds} 秒过期。点一下这串码就会整串选中。',
    'login.step1': '打开 {link}',
    'login.step1Link': 'github.com/login/device ↗',
    'login.step2': '把上面这串码敲进去',
    'login.step3': '点 Continue 并在 GitHub 上同意授权',
    'login.step4': '这个页面会自己跳到已登录状态，不用按任何按钮',
    'login.refreshNote': '本页每 {seconds} 秒自动刷新一次，只为看你在 GitHub 上有没有授权完。它不执行 JavaScript，也拿不到你的 GitHub 密码。',
    'login.whatWeGet': '我们拿到的是什么',
    'login.whatWeGetBody': '一份 GitHub 授权令牌，存在 DSH 的凭据服务里，只用来替你发帖和评论。它不会写进任何文件，也不会出现在日志里。',
    'login.howToLogout': '怎么退出',
    'login.howToLogoutBody': '登录之后在页面右上角的账号行点「换个账号」，或者在 {link} 直接撤销。',
    'login.revokeLink': 'GitHub 的授权应用页',
  },

  en: {
    // ---------------------------------- Shell ----------------------------------
    'html.lang': 'en',
    'site.name': 'DSH Plugin Community',
    'foot.disclaimer':
      'Data comes from public indexes and the GitHub API, provided as-is with no human review. Read the source before installing anything.',
    'foot.ssr': 'This page is server-rendered and runs no JavaScript — it works on phones and in browsers with JS disabled.',
    'nav.langSwitch': 'Language',

    // ---------------------------------- Account ----------------------------------
    'nav.loggedInAs': 'Signed in as',
    'nav.unknownUser': '(unknown user)',
    'nav.scopes': 'scopes',
    'nav.loggedOut': 'Not signed in: you can read, but cannot post or comment yet.',
    'nav.switchAccount': 'Switch account',
    'nav.login': 'Sign in with GitHub',

    // ---------------------------------- Index ----------------------------------
    'index.title': 'DSH Plugin Community',
    'index.titleQuery': 'Search “{query}” · DSH Plugin Community',
    'index.description': 'The DSH (DeepSeek Harness) plugin index — {known} entries in total.',
    'index.summary':
      'Indexed **{known}** plugin entries · **{total}** matched · {npm} have an npm package · {archived} archived',
    'index.searchPlaceholder': 'Search name, author, description, capability…',
    'index.searchLabel': 'Search plugins',
    'index.searchButton': 'Search',
    'index.byCategory': 'By category',
    'index.sort': 'Sort',
    'index.all': 'All',
    'index.empty': 'No matches. Try another keyword, or clear the filters.',
    'index.pagerPrev': '← Previous',
    'index.pagerNext': 'Next →',
    'index.byKind': 'By type',
    'index.kindTip':
      '**“Smart” order suppresses two kinds of noise**: `topic:dsh-plugin` is a self-declared label anyone can add, so the framework itself and “list” repositories get swept in. They are ranked down rather than removed — saying “it is here, but it is not a plugin” beats pretending it does not exist.',
    'index.kindAll': 'All types',
    'kind.framework': 'Framework',
    'kind.aggregator': 'List',
    'kind.plugin': 'Plugin',
    'kind.unknown': 'Unclassified',
    'card.kindTag': 'Type: {label}',
    'card.authorLink': 'Author page',

    // ---------------------------------- Sort ----------------------------------
    'sort.smart': 'Smart order',
    'sort.stars': 'By stars',
    'sort.downloads': 'By downloads',
    'sort.recent': 'By date added',
    'sort.name': 'By name',

    // ---------------------------------- Author page ----------------------------------
    'user.title': 'Plugins by {login} · DSH Plugin Community',
    'user.description': 'Entries by {login} in the DSH plugin index.',
    'user.heading': 'Author',
    'user.plugins': 'Indexed plugins',
    'user.none': 'No plugins by this author in the index yet.',
    'user.notFound': 'No GitHub user named {login}. Below are index entries from an author with the same name.',
    'user.unavailable': 'Could not read the GitHub profile right now ({reason}). Showing only index entries below.',
    'user.repos': 'Public repos',
    'user.followers': 'Followers',
    'user.joined': 'Joined',
    'user.profile': 'GitHub profile',
    'user.count': '{count} entries in the index',
    'user.backToUser': '← Back to {login}',
    'user.ownerBadge': 'Author page',

    // ---------------------------------- Card ----------------------------------
    'card.noDescription': '(this entry has no description)',
    'card.perWeek': '/wk',
    'card.archived': 'Archived',
    'card.lastPush': 'last commit {when}',
    'card.sources': 'from {list}',

    // ---------------------------------- Notices ----------------------------------
    'sources.partial': '**Some index sources returned nothing**: {list}. Showing what could be fetched.',
    'sources.stale': 'Some data is an older cached copy (the upstream is temporarily unreachable) and may be out of date.',

    // ---------------------------------- Detail ----------------------------------
    'detail.back': '← Back to the plugin index',
    'detail.title': '{name} · DSH Plugin Community',
    'detail.description': 'Community info for {repo}',
    'detail.archived': 'This repository is archived; the author no longer maintains it.',
    'detail.noDescription': '(no description)',
    'stat.stars': 'Stars',
    'stat.openIssues': 'Open issues',
    'stat.pushedAt': 'Last commit',
    'stat.license': 'License',
    'stat.starsIndexed': 'Stars (indexed)',
    'stat.sources': 'Sources',
    'stat.unknown': 'unknown',
    'stat.undeclared': 'not declared',
    'detail.install': 'Install',
    'detail.noInstall': 'No install command is registered for this plugin. Check the repository README.',
    'detail.capabilities': 'What it does',
    'detail.redLines': 'What it deliberately does not do',
    'detail.issuesHeading': 'Known issues (GitHub Issues)',
    'detail.discussionsHeading': 'Community discussions (GitHub Discussions)',
    'detail.issuesEmpty': 'No open issues right now.',
    'detail.issuesUnavailable': 'Could not fetch the issue list. You can go straight to {link}.',
    'detail.issuesUnavailableWhy': 'Could not fetch the issue list ({reason}). You can go straight to {link}.',
    'detail.discussionsEmpty': 'This repository has not enabled discussions yet.',
    'detail.discussionsUnavailable': 'The discussion list is not readable right now. Try {link}.',
    'detail.discussionsUnavailableWhy': 'The discussion list is not readable right now ({reason}). Try {link}.',
    'detail.discussionsTokenRequired':
      'Reading discussions requires a GitHub sign-in (the unauthenticated GraphQL quota is 0). Try {link} in the meantime.',
    'detail.repoIssuesLink': 'the repository issues',
    'detail.repoDiscussionsLink': 'the repository discussions',
    'detail.disclaimer': 'Everything here is raw content from GitHub. This community does not review or endorse it. Report plugin problems at {link}.',
    'detail.disclaimerLink': 'its own repository',
    'detail.colNumber': '#',
    'detail.colTitle': 'Title',
    'detail.colState': 'State',
    'detail.colCategory': 'Category',
    'detail.colReplies': 'Replies',

    // ---------------------------------- Error ----------------------------------
    'error.requestId': 'Request ID',
    'error.back': '← Back to the plugin index',
    'error.pluginNotFound': 'The index has no {repo} — either no index source covers it, or the repository name is misspelled.',
    'error.discussionNotHosted': 'Discussions are not hosted here. Read the original thread on GitHub Discussions.',
    'error.pageNotFound': 'No such page: {path}',

    // ---------------------------------- Login ----------------------------------
    'login.title': 'Sign in with GitHub',
    'login.pageTitle': 'Sign in with GitHub · DSH Plugin Community',
    'login.pageDescription': 'Sign in to the DSH Plugin Community with the GitHub device flow: one 8-character code is all it takes.',
    'login.intro': 'No form to fill in here, and no password or key to hand over. Just type this code into GitHub.',
    'login.alreadyIn': 'You are already signed in ({login}).',
    'login.backToIndex': 'Back to the index',
    'login.cannotStart': 'Sign-in cannot start right now',
    'login.codeLabel': 'Enter this code on GitHub',
    'login.codeHint': 'Expires in about {seconds} seconds. Click the code to select the whole thing.',
    'login.step1': 'Open {link}',
    'login.step1Link': 'github.com/login/device ↗',
    'login.step2': 'Type the code above',
    'login.step3': 'Click Continue and approve on GitHub',
    'login.step4': 'This page flips to signed-in by itself — no button to press',
    'login.refreshNote':
      'This page refreshes every {seconds} seconds, only to check whether you finished on GitHub. It runs no JavaScript and never sees your GitHub password.',
    'login.whatWeGet': 'What we get',
    'login.whatWeGetBody': 'A GitHub authorization token, kept in the DSH credential service, used only to post and comment on your behalf. It is never written to a file and never logged.',
    'login.howToLogout': 'How to sign out',
    'login.howToLogoutBody': 'Once signed in, use “Switch account” in the account row at the top, or revoke it directly at {link}.',
    'login.revokeLink': 'GitHub’s authorized applications page',
  },
}

/** 把 `en-US` / `zh-Hant` / `ZH` 这类标签收敛成我们支持的两种之一；认不出返回 `null`。 */
export function normalizeLocale(input) {
  const raw = String(input ?? '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  if (raw === '*') return null
  if (raw.startsWith('zh')) return 'zh'
  if (raw.startsWith('en')) return 'en'
  return null
}

/**
 * 按 q 值排序解析 `Accept-Language`。
 *
 * 只认 zh / en，但**先按 q 排再认**很重要 —— `en;q=0.8, zh;q=0.9` 这种顺序反着的头
 * 很常见，直接取第一个词会选错。
 */
export function localeFromAcceptLanguage(header, fallback = DEFAULT_LOCALE) {
  const raw = String(header ?? '')
  if (!raw.trim()) return normalizeLocale(fallback) ?? DEFAULT_LOCALE

  const candidates = raw
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.split(';')
      let q = 1
      for (const param of params) {
        const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
        if (match) {
          const parsed = Number.parseFloat(match[1])
          if (Number.isFinite(parsed)) q = parsed
        }
      }
      return { tag: tag.trim(), q }
    })
    .filter((item) => item.tag && item.q > 0)
    .sort((a, b) => b.q - a.q)

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate.tag)
    if (locale) return locale
  }
  return normalizeLocale(fallback) ?? DEFAULT_LOCALE
}

/**
 * 决定这一页用哪种语言。
 *
 * `?lang=` 优先：用户点过切换之后，页面里所有链接都会带上它，所以选择能一直粘住。
 */
export function resolveLocale({ query, headers } = {}) {
  const explicit = normalizeLocale(query?.lang)
  if (explicit) return explicit
  const header = typeof headers?.get === 'function' ? headers.get('accept-language') : headers?.['accept-language']
  return localeFromAcceptLanguage(header)
}

function interpolate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

/** 取一条文案。查不到时退到中文，再退到 key 本身 —— **永远不抛错，永远有东西可显示**。 */
export function t(locale, key, params) {
  const table = MESSAGES[normalizeLocale(locale) ?? DEFAULT_LOCALE] ?? MESSAGES[DEFAULT_LOCALE]
  const template = table[key] ?? MESSAGES[DEFAULT_LOCALE][key]
  if (template === undefined) return key
  return interpolate(template, params)
}

/** 绑定了语言的 `t`，渲染函数里用着顺手。 */
export function translator(locale) {
  const resolved = normalizeLocale(locale) ?? DEFAULT_LOCALE
  return (key, params) => t(resolved, key, params)
}

/** `<html lang>` 属性值。 */
export function htmlLang(locale) {
  return t(locale, 'html.lang')
}

/** 供测试与调试：某个语言下所有 key 的列表。 */
export function messageKeys(locale = DEFAULT_LOCALE) {
  return Object.keys(MESSAGES[normalizeLocale(locale) ?? DEFAULT_LOCALE] ?? {})
}

/**
 * 从索引源给的 `{ en, zh }` 双语文段里挑出当前语言那一份。
 *
 * 挑的顺序是「当前语言 → 另一种语言 → 空串」：**宁可显示另一种语言，也不要显示空白**。
 * 这条对插件描述尤其重要 —— 索引里大量条目只有中文或只有英文，挑不到就什么都不显示的话，
 * 一半的卡片会变成空白。
 */
export function pickLocalized(value, locale) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  const resolved = normalizeLocale(locale) ?? DEFAULT_LOCALE
  const other = resolved === 'zh' ? 'en' : 'zh'
  return String(value[resolved] || value[other] || '')
}
