/**
 * 服务端渲染。
 *
 * 三条硬要求决定了这里为什么一行前端 JS 都没有：
 *   1. **关闭 JavaScript 也要能看到帖子列表**（docs/07 的 M1 准出条件）
 *   2. **必须在手机上可用** —— 一台没装任何 DSH 插件的手机，打开 `/community` 就该看到内容
 *   3. **页面体积要够大**：Android host 的已知故障是「客户端插件图没能注入 → 页面只有 3709 字节」，
 *      DoD 里把「首页 HTML > 10000 字节」当作注入成功的判据之一
 *
 * 所以要搜索、要翻页、要筛选，全部走普通 `<a>` 和 `<form method="get">`。
 *
 * 多语言：所有用户可见文案都走 `./i18n.js`，语言由 `api.js` 从 `?lang=` / `Accept-Language`
 * 解出来后传进来。**页面里每一条链接都会带上 `lang`**，这样用户点过切换之后选择能一直粘住。
 */

import { escapeHtml, formatCount, relativeTime, safeUrl } from './text.js'
import { LOCALES, LOCALE_LABELS, htmlLang, pickLocalized, translator } from './i18n.js'

const e = escapeHtml

/** 相对时间，跟着页面语言走（`12 天前` / `12 days ago`）。 */
const rel = (value, locale) => relativeTime(value, undefined, locale)

const STYLES = `
*{box-sizing:border-box}
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--dim:#666;--line:#e3e3e3;--card:#fafafa;--accent:#3b6ef6}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--dim:#9a9a9a;--line:#2b2b2b;--card:#1c1c1c;--accent:#7aa2ff}}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:16px}
header.top{border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:24px 0 8px}
.sub{color:var(--dim);font-size:13px;margin:0}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
input[type=search]{flex:1 1 200px;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:15px}
button{padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:14px;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:8px 0}
.chips a{display:inline-block;padding:3px 9px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--dim)}
.chips a.on{background:var(--accent);border-color:var(--accent);color:#fff}
ul.lang{justify-content:flex-end;margin:0 0 6px}
ul.lang a{font-size:11px;padding:2px 8px}
ul.plugins{list-style:none;padding:0;margin:0}
ul.plugins>li{border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--card)}
.pname{font-size:16px;font-weight:600;margin:0 0 2px;word-break:break-all}
.avatar{width:28px;height:28px;border-radius:50%;vertical-align:-4px;margin-right:8px;background:var(--line)}
.powner{color:var(--dim);font-size:12px;margin:0 0 6px;word-break:break-all}
.pdesc{margin:0 0 8px}
.meta{color:var(--dim);font-size:12px;display:flex;flex-wrap:wrap;gap:10px}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12px;word-break:break-all}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px}
.notice{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:10px 12px;margin:12px 0;background:var(--card);font-size:13px}
.warn{border-left-color:#d9822b}
.pager{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.pager a,.pager span{padding:6px 11px;border:1px solid var(--line);border-radius:8px;font-size:13px}
.pager span.now{background:var(--accent);border-color:var(--accent);color:#fff}
.nav{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:0 0 10px}
.codebox{border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;background:var(--card);text-align:center}
.codelabel{color:var(--dim);font-size:13px;margin:0 0 6px}
.usercode{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.16em;margin:6px 0 10px;user-select:all;-webkit-user-select:all;word-break:break-all}
ol.steps{padding-left:20px}
ol.steps li{margin:6px 0}
footer.foot{margin-top:28px;padding-top:12px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
@media (max-width:640px){
 .wrap{padding:12px}
 h1{font-size:18px}
 ul.plugins>li{padding:10px}
 table{font-size:13px}
 th:nth-child(3),td:nth-child(3){display:none}
}
`

function qs(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * `**粗体**` → `<strong>`，然后把 `{name}` 换成调用方给的 HTML 片段。
 *
 * **顺序是这里唯一的要点**：先转义整段文案再替换占位符。
 *   - 先转义 → 文案里的 `<` 会被挡掉，而调用方作为参数传进来的 `<a>` 能原样落地；
 *   - 反过来（先替换再转义）会把链接一起转义掉 —— 页面上就会出现
 *     `&lt;a href=&quot;...&quot;&gt;`，链接变成一串源码。这是真踩过的坑。
 *
 * 所以规矩是：**文案永远走模板（会被转义），HTML 永远走参数（原样输出）**。
 * 参数里的动态文本由调用方自己 `escapeHtml`。
 */
function rich(template, params) {
  const markup = e(String(template)).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  if (!params) return markup
  return markup.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  )
}

function shell({ title, description, body, base, canonical, refresh, locale }) {
  return `<!doctype html>
<html lang="${e(htmlLang(locale))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
${refresh ? `<meta http-equiv="refresh" content="${e(String(refresh.content))}; url=${e(refresh.url)}">` : ''}
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="canonical" href="${e(safeUrl(canonical) ?? base)}">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${body}
<footer class="foot">
  <p>${e(translator(locale)('foot.disclaimer'))}</p>
  <p>${e(translator(locale)('foot.ssr'))}</p>
</footer>
</div>
</body>
</html>`
}

/**
 * 语言切换器。
 *
 * 用的是纯 `<a>`（没有 JS），所以**每个页面都要把当前查询参数一起带走** ——
 * 不然点一下「English」就丢了搜索结果或正在轮的验证码流程，那种体验比不提供切换更糟。
 */
function langSwitcher({ locale, base, params, T }) {
  const items = LOCALES.map((code) => {
    const on = code === locale ? ' class="on"' : ''
    const href = `${base}${qs({ ...params, lang: code })}`
    return `<li><a${on} href="${e(href)}" aria-label="${e(LOCALE_LABELS[code])}">${e(LOCALE_LABELS[code])}</a></li>`
  })
  return `<ul class="chips lang" title="${e(T('nav.langSwitch'))}">${items.join('')}</ul>`
}

function sourcesNote(list, T) {
  const parts = []
  if (list.errors?.length) {
    const detail = list.errors.map((item) => `${e(item.id)}（${e(item.message)}）`).join('、')
    parts.push(`<div class="notice warn">${rich(T('sources.partial'), { list: detail })}</div>`)
  }
  if (list.stale) {
    parts.push(`<div class="notice warn">${e(T('sources.stale'))}</div>`)
  }
  return parts.join('\n')
}

function accountNav(status, base, params, locale, T) {
  if (!status) return ''
  const who = status.authenticated
    ? `${e(T('nav.loggedInAs'))} <strong>${e(status.login ?? T('nav.unknownUser'))}</strong>${
        status.scopes?.length ? ` · ${e(T('nav.scopes'))} ${e(status.scopes.join(' '))}` : ''
      }`
    : e(T('nav.loggedOut'))
  const action = status.authenticated
    ? `<a href="${e(`${base}/login${qs({ ...params, lang: locale, force: 1 })}`)}">${e(T('nav.switchAccount'))}</a>`
    : `<a href="${e(`${base}/login${qs({ ...params, lang: locale })}`)}">${e(T('nav.login'))}</a>`
  return `<p class="nav"><span class="sub">${who}</span> ${action}</p>`
}

export function renderIndex({ list, config, origin, status, locale }) {
  const T = translator(locale)
  const base = `${origin}/community`
  const params = { q: list.query, category: list.category, sort: list.sort, kind: list.kind }
  const link = (extra) => `${base}${qs({ ...params, ...extra, lang: locale })}`

  const categoryChips = [{ slug: '', count: list.total, label: T('index.all') }].concat(
    list.facets.categories.map((item) => ({ ...item, label: item.slug })),
  )

  const chipHtml = categoryChips
    .map((item) => {
      const on = (list.category ?? '') === item.slug ? ' class="on"' : ''
      const label = item.slug === '' ? e(T('index.all')) : e(item.label)
      return `<li><a${on} href="${e(link({ category: item.slug, page: undefined }))}">${label}<span> ${item.count}</span></a></li>`
    })
    .join('\n')

  /**
   * 类型 chips。**顺序固定**（插件在前）而不是按数量排：
   * 这几个标签是「解释为什么某条排得靠后」用的，位置固定才认得出。
   */
  const kindOrder = ['plugin', 'framework', 'aggregator', 'unknown']
  const byKind = new Map((list.facets.kinds ?? []).map((item) => [item.kind, item.count]))
  const kindChips = [{ kind: '', count: list.total, label: T('index.kindAll') }].concat(
    kindOrder.map((kind) => ({
      kind,
      count: byKind.get(kind) ?? 0,
      label: T(`kind.${kind}`),
    })),
  )
  const kindHtml = kindChips
    .map((item) => {
      const on = (list.kind ?? '') === item.kind ? ' class="on"' : ''
      return `<li><a${on} href="${e(link({ kind: item.kind, page: undefined }))}">${e(item.label)}<span> ${item.count}</span></a></li>`
    })
    .join('\n')

  const sorts = [
    ['smart', 'sort.smart'],
    ['stars', 'sort.stars'],
    ['downloads', 'sort.downloads'],
    ['recent', 'sort.recent'],
    ['name', 'sort.name'],
  ]
  const activeSort = list.sort ?? 'smart'
  const sortHtml = sorts
    .map(([key, labelKey]) => {
      const on = activeSort === key ? ' class="on"' : ''
      return `<li><a${on} href="${e(link({ sort: key, page: undefined }))}">${e(T(labelKey))}</a></li>`
    })
    .join('\n')

  const items = list.items.length
    ? list.items.map((card) => renderCard(card, origin, locale)).join('\n')
    : `<li><p class="pdesc">${e(T('index.empty'))}</p></li>`

  const pager = []
  if (list.pages > 1) {
    const pageLink = (page, label, now) =>
      now
        ? `<span class="now">${e(label)}</span>`
        : `<a href="${e(link({ page }))}">${e(label)}</a>`
    if (list.page > 1) pager.push(pageLink(list.page - 1, T('index.pagerPrev'), false))
    pager.push(pageLink(list.page, `${list.page} / ${list.pages}`, true))
    if (list.page < list.pages) pager.push(pageLink(list.page + 1, T('index.pagerNext'), false))
  }

  const body = `
${langSwitcher({ locale, base, params, T })}

<header class="top">
  <h1>${e(T('index.title'))}</h1>
  <p class="sub">${rich(
    T('index.summary'),
    {
      known: formatCount(list.knownTotal),
      total: formatCount(list.total),
      npm: formatCount(list.facets.withNpm),
      archived: formatCount(list.facets.archived),
    },
  )}</p>
</header>

${accountNav(status, base, params, locale, T)}

<form class="bar" method="get" action="${e(base)}">
  <input type="search" name="q" value="${e(list.query)}" placeholder="${e(T('index.searchPlaceholder'))}" aria-label="${e(T('index.searchLabel'))}">
  <input type="hidden" name="sort" value="${e(activeSort)}">
  <input type="hidden" name="category" value="${e(list.category)}">
  <input type="hidden" name="kind" value="${e(list.kind ?? '')}">
  <input type="hidden" name="lang" value="${e(locale)}">
  <button type="submit">${e(T('index.searchButton'))}</button>
</form>

<h2>${e(T('index.byCategory'))}</h2>
<ul class="chips">${chipHtml}</ul>

<h2>${e(T('index.byKind'))}</h2>
<ul class="chips">${kindHtml}</ul>

<h2>${e(T('index.sort'))}</h2>
<ul class="chips">${sortHtml}</ul>

${activeSort === 'smart' ? `<div class="notice">${rich(T('index.kindTip'), {})}</div>` : ''}

${sourcesNote(list, T)}

<ul class="plugins">
${items}
</ul>

<div class="pager">${pager.join('\n')}</div>
`
  return shell({
    title: list.query ? T('index.titleQuery', { query: list.query }) : T('index.title'),
    description: T('index.description', { known: list.knownTotal }),
    body,
    base,
    locale,
  })
}

function renderCard(card, origin, locale) {
  const T = translator(locale)
  const detail = `${origin}/community/plugin${qs({ repo: card.repo, lang: locale })}`
  const authorPage = `${origin}/community/u${qs({ login: card.owner, lang: locale })}`
  const desc = pickLocalized(card.description, locale) || T('card.noDescription')
  const bits = []
  if (card.stars !== null && card.stars !== undefined) bits.push(`★ ${formatCount(card.stars)}`)
  if (card.downloads !== null && card.downloads !== undefined) {
    bits.push(`↓ ${formatCount(card.downloads)}${e(T('card.perWeek'))}`)
  }
  if (card.category) bits.push(e(pickLocalized(card.categoryLabel, locale) || card.category))
  // 类型标签：只有「不是普通插件」的时候才显示，否则每张卡片都挂一个「插件」等于噪音
  const kindLabel = card.kind && card.kind !== 'plugin' ? T(`kind.${card.kind}`) : ''
  if (kindLabel) bits.push(`<strong>${e(kindLabel)}</strong>`)
  if (card.npm) bits.push(`npm <code>${e(card.npm)}</code>`)
  if (card.version) bits.push(e(card.version))
  if (card.archived) bits.push(`<strong>${e(T('card.archived'))}</strong>`)
  if (card.pushedAt) bits.push(e(T('card.lastPush', { when: rel(card.pushedAt, locale) })))
  bits.push(e(T('card.sources', { list: (card.sources ?? []).map(e).join(' + ') })))

  return `<li>
  <p class="pname"><a href="${e(detail)}">${e(card.name)}</a></p>
  <p class="powner"><a href="${e(authorPage)}">${e(card.owner)}</a> · <a href="${e(safeUrl(card.url) ?? '#')}">${e(card.repo)}</a></p>
  <p class="pdesc">${e(desc)}</p>
  <p class="meta">${bits.join(' · ')}</p>
</li>`
}

export function renderDetail({ detail, origin, status, locale }) {
  const T = translator(locale)
  const { card, meta, issues, discussions } = detail
  const base = `${origin}/community`
  const params = { repo: card.repo }
  const repoUrl = safeUrl(card.url) ?? '#'

  const lines = [
    `<p class="pname">${e(card.name)}</p>`,
    `<p class="powner">${e(card.owner)} · <a href="${e(repoUrl)}">${e(card.repo)}</a></p>`,
    card.archived ? `<div class="notice warn"><strong>${e(T('detail.archived'))}</strong></div>` : '',
    `<p class="pdesc">${e(pickLocalized(card.description, locale) || T('detail.noDescription'))}</p>`,
  ]

  const stats = []
  if (meta?.found !== false && meta) {
    stats.push([T('stat.stars'), formatCount(meta.stars)])
    stats.push([T('stat.openIssues'), formatCount(meta.openIssues)])
    stats.push([T('stat.pushedAt'), meta.pushedAt ? rel(meta.pushedAt, locale) : T('stat.unknown')])
    stats.push([T('stat.license'), meta.license ?? T('stat.undeclared')])
  } else if (card.stars !== null) {
    stats.push([T('stat.starsIndexed'), formatCount(card.stars)])
  }
  stats.push([T('stat.sources'), (card.sources ?? []).join(' + ') || T('stat.unknown')])

  const install = card.install
    ? `<h2>${e(T('detail.install'))}</h2><pre>${e(card.install)}</pre>`
    : card.npm
      ? `<h2>${e(T('detail.install'))}</h2><pre>dsh plugin add ${e(card.npm)}</pre>`
      : `<div class="notice">${e(T('detail.noInstall'))}</div>`

  const capabilities = (card.capabilities ?? []).length
    ? `<h2>${e(T('detail.capabilities'))}</h2><ul>${card.capabilities.map((c) => `<li>${e(c)}</li>`).join('')}</ul>`
    : ''
  const redLines = (card.capabilityRedLines ?? []).length
    ? `<h2>${e(T('detail.redLines'))}</h2><ul>${card.capabilityRedLines.map((c) => `<li>${e(c)}</li>`).join('')}</ul>`
    : ''

  const issuesLink = `<a href="${e(repoUrl)}/issues">${e(T('detail.repoIssuesLink'))}</a>`
  const issueTable = issues?.available
    ? issues.items.length
      ? `<table><thead><tr><th>${e(T('detail.colNumber'))}</th><th>${e(T('detail.colTitle'))}</th><th>${e(T('detail.colState'))}</th></tr></thead><tbody>${issues.items
          .map(
            (item) =>
              `<tr><td>${item.number}</td><td><a href="${e(safeUrl(item.url) ?? '#')}">${e(item.title)}</a></td><td>${e(item.state)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<p>${e(T('detail.issuesEmpty'))}</p>`
    : `<div class="notice">${rich(
        issues?.message ? T('detail.issuesUnavailableWhy') : T('detail.issuesUnavailable'),
        { reason: e(issues?.message ?? ''), link: issuesLink },
      )}</div>`

  const discussionsLink = `<a href="${e(repoUrl)}/discussions">${e(T('detail.repoDiscussionsLink'))}</a>`
  // 「读不到」有几种原因，别都糊成一句话：
  //   TOKEN_REQUIRED —— 未登录时 GraphQL 配额为 0，这是**设计如此**，要说清楚怎么解决；
  //   其他 —— 上游挂了，把上游的原话带上。
  const discussionNotice = discussions?.reason === 'TOKEN_REQUIRED'
    ? T('detail.discussionsTokenRequired')
    : discussions?.message
      ? T('detail.discussionsUnavailableWhy')
      : T('detail.discussionsUnavailable')
  const discussionBlock = discussions?.available
    ? discussions.items.length
      ? `<table><thead><tr><th>${e(T('detail.colTitle'))}</th><th>${e(T('detail.colCategory'))}</th><th>${e(T('detail.colReplies'))}</th></tr></thead><tbody>${discussions.items
          .map(
            (item) =>
              `<tr><td><a href="${e(safeUrl(item.url) ?? '#')}">${e(item.title)}</a>${item.answered ? ' ✅' : ''}</td><td>${e(item.category?.name ?? '')}</td><td>${e(String(item.comments))}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<p>${e(T('detail.discussionsEmpty'))}</p>`
    : `<div class="notice">${rich(discussionNotice, { reason: e(discussions?.message ?? ''), link: discussionsLink })}</div>`

  const body = `
${langSwitcher({ locale, base, params, T })}

<header class="top">
  <p class="sub"><a href="${e(`${base}${qs({ lang: locale })}`)}">${e(T('detail.back'))}</a></p>
  ${lines.filter(Boolean).join('\n')}
</header>

${accountNav(status, base, params, locale, T)}

<table><tbody>
${stats.map(([key, value]) => `<tr><th>${e(key)}</th><td>${e(String(value))}</td></tr>`).join('')}
</tbody></table>

${install}
${capabilities}
${redLines}

<h2>${e(T('detail.issuesHeading'))}</h2>
${issueTable}

<h2>${e(T('detail.discussionsHeading'))}</h2>
${discussionBlock}

<div class="notice">
  ${rich(T('detail.disclaimer'), { link: `<a href="${e(repoUrl)}/issues">${e(T('detail.disclaimerLink'))}</a>` })}
</div>
`
  return shell({
    title: T('detail.title', { name: card.name }),
    description: card.description?.en || card.description?.zh || T('detail.description', { repo: card.repo }),
    body,
    base,
    locale,
    canonical: `${origin}/community/plugin${qs({ repo: card.repo })}`,
  })
}

/**
 * 作者页（M4 新增）。
 *
 * 两块信息拼起来的：**GitHub 上的公开资料**（REST `/users/{login}`，未登录也能读）
 * 加 **索引里属于他的条目**。
 *
 * 关键取舍：GitHub 资料读不到时**页面照样 200**，只把「为什么读不到」写清楚，
 * 下面照样列出索引里的条目。因为「他是谁」是附加值，「他有哪些插件」才是这一页
 * 存在的理由 —— 让整个页面因为头像拉不到就 502，是把主次搞反了。
 */
export function renderUser({ profile, plugins, login, origin, status, locale, reason }) {
  const T = translator(locale)
  const base = `${origin}/community`
  const params = { login }
  const name = profile?.found ? profile.login : login
  const profileUrl = safeUrl(profile?.htmlUrl) ?? `https://github.com/${encodeURIComponent(login)}`

  const facts = []
  if (profile?.found) {
    if (profile.name) facts.push([T('user.heading'), profile.name])
    facts.push([T('user.repos'), formatCount(profile.repos)])
    facts.push([T('user.followers'), formatCount(profile.followers)])
    if (profile.createdAt) facts.push([T('user.joined'), rel(profile.createdAt, locale)])
  }

  const items = plugins.length
    ? plugins.map((card) => renderCard(card, origin, locale)).join('\n')
    : `<li><p class="pdesc">${e(T('user.none'))}</p></li>`

  const notice = profile?.found
    ? ''
    : reason
      ? `<div class="notice warn">${rich(T('user.unavailable'), { reason: e(reason) })}</div>`
      : `<div class="notice warn">${rich(T('user.notFound'), { login: e(login) })}</div>`

  const avatar = profile?.found && profile.avatarUrl
    ? `<img class="avatar" src="${e(safeUrl(profile.avatarUrl) ?? '')}" alt="" width="56" height="56">`
    : ''

  const body = `
${langSwitcher({ locale, base, params, T })}

<header class="top">
  <p class="sub"><a href="${e(`${base}${qs({ lang: locale })}`)}">${e(T('detail.back'))}</a></p>
  <h1>${avatar}${e(name)}</h1>
  <p class="sub">${e(T('user.count', { count: plugins.length }))} · <a href="${e(profileUrl)}">${e(T('user.profile'))}</a></p>
</header>

${accountNav(status, base, params, locale, T)}

${notice}
${profile?.bio ? `<p class="pdesc">${e(profile.bio)}</p>` : ''}

${
  facts.length
    ? `<table><tbody>${facts.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(String(v))}</td></tr>`).join('')}</tbody></table>`
    : ''
}

<h2>${e(T('user.plugins'))}</h2>
<ul class="plugins">
${items}
</ul>
`
  return shell({
    title: T('user.title', { login: name }),
    description: T('user.description', { login: name }),
    body,
    base,
    locale,
  })
}

export function renderError({ status, reason, message, origin, requestId, locale }) {  const T = translator(locale)
  const base = `${origin}/community`
  const body = `
${langSwitcher({ locale, base, params: {}, T })}

<header class="top">
  <h1>${e(String(status))} · ${e(reason)}</h1>
  <p class="sub">${e(message)}</p>
</header>
<div class="notice">
  <p>${e(T('error.requestId'))}：<code>${e(requestId ?? '-')}</code></p>
  <p><a href="${e(`${base}${qs({ lang: locale })}`)}">${e(T('error.back'))}</a></p>
</div>
`
  return shell({ title: `${status} ${reason}`, description: message, body, base, locale })
}

/**
 * 登录面板。
 *
 * **一行前端 JS 都没有，也照样能用**：轮询靠 `<meta http-equiv="refresh">`，
 * 验证码靠 `user-select:all`（点一下整串选中，比复制按钮更少一层）。
 *
 * 这是对 docs/07 §4 第 5 条的一处**有意偏离**：那一条写的是「大号验证码 + 复制按钮」。
 * 复制按钮需要 JS（`navigator.clipboard`），而 M1/M2 的页面红线是「不执行 JavaScript
 * 也能用」。所以这里用「选中即整串」+ 手输两条路替代复制按钮 —— 已验证的收益是
 * 手机浏览器里不会出现「点了复制但没权限」的死角。
 */
export function renderLogin({ flow, status, origin, pending, note, error, locale }) {
  const T = translator(locale)
  const base = `${origin}/community`
  const live = Boolean(flow && flow.flowId)
  const waitSeconds = Math.max(
    3,
    Math.min(20, Math.round((pending?.retryAfterMs ?? (flow?.interval ?? 5) * 1000) / 1000) || 5),
  )
  const refresh =
    live && !status?.authenticated
      ? { content: waitSeconds, url: `${base}/login${qs({ flow: flow.flowId, lang: locale })}` }
      : null

  const howto = Array.isArray(error?.fields)
    ? error.fields.find((item) => item?.name === 'howto')?.value
    : null

  const body = `
${langSwitcher({ locale, base, params: live ? { flow: flow.flowId } : {}, T })}

<header class="top">
  <p class="sub"><a href="${e(`${base}${qs({ lang: locale })}`)}">${e(T('error.back'))}</a></p>
  <h1>${e(T('login.title'))}</h1>
  <p class="sub">${e(T('login.intro'))}</p>
</header>

${
  status?.authenticated
    ? `<div class="notice"><strong>${e(T('login.alreadyIn', { login: status.login ?? '' }))}</strong> <a href="${e(`${base}${qs({ lang: locale })}`)}">${e(T('login.backToIndex'))}</a></div>`
    : ''
}
${note ? `<div class="notice warn">${e(note)}</div>` : ''}
${
  error
    ? `<div class="notice warn"><strong>${e(T('login.cannotStart'))}</strong>：${e(error.message)}${
        howto ? `<pre>${e(howto)}</pre>` : ''
      }</div>`
    : ''
}
${
  live && !error
    ? `<div class="codebox">
  <p class="codelabel">${e(T('login.codeLabel'))}</p>
  <p class="usercode">${e(flow.userCode)}</p>
  <p class="sub">${e(T('login.codeHint', { seconds: flow.expiresIn }))}</p>
</div>
<ol class="steps">
  <li>${rich(T('login.step1'), { link: `<a href="${e(flow.verificationUri)}" target="_blank" rel="noopener noreferrer">${e(T('login.step1Link'))}</a>` })}</li>
  <li>${e(T('login.step2'))}</li>
  <li>${e(T('login.step3'))}</li>
  <li>${e(T('login.step4'))}</li>
</ol>
<p class="sub">${e(T('login.refreshNote', { seconds: waitSeconds }))}</p>`
    : ''
}

<div class="notice">
  <p><strong>${e(T('login.whatWeGet'))}</strong>：${e(T('login.whatWeGetBody'))}</p>
  <p><strong>${e(T('login.howToLogout'))}</strong>：${rich(T('login.howToLogoutBody'), {
    link: `<a href="https://github.com/settings/applications">${e(T('login.revokeLink'))}</a>`,
  })}</p>
</div>
`

  return shell({
    title: T('login.pageTitle'),
    description: T('login.pageDescription'),
    body,
    base,
    locale,
    refresh,
  })
}
