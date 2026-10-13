/**
 * client 半边（形态①）。
 *
 * 这是一个**手写的** `__ModuleLoader__` bundle —— 没有构建步骤，不写 JSX。
 * 原因很实在：Android 上跑不动原生模块，而且本机 npm registry 不可达，
 * 装不了 esbuild/rollup 之类的打包器。React 由宿主提供（`require('react')`）。
 *
 * 与 host 半边的唯一通道是**同源 fetch**：本插件在 host 侧注册了
 * `/api/v1/community/*`，client 侧直接打它。没有跨域、没有共享密钥、
 * 也没有把 token 交给浏览器的任何一步。
 *
 * 七个座位（对应 docs/07 §5 的六条交付物 + M4 的工具卡片）：
 *   1. sidebar.panellist   —— 侧栏图标（id 与 main 的 key 同为 `community`，自动成对）
 *   2. main (keyed)        —— 社区主面板
 *   3. plugins.detail.section —— 插件详情页里的社区区块
 *   4. plugins.detail.badge   —— 插件详情页标题旁的活跃标签
 *   5. settings.section    —— 设置页：配置与登录状态
 *   6. shell.overlay       —— 登录浮层
 *   7. tool.call.toolview  —— 四个 Agent 工具的自定义卡片（keyed，key = 工具名）
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-community',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const inject = ['slots']

    const MAIN_PANEL_KEY = 'community'
    const API_PREFIX = '/api/v1/community'
    const PAGE_PREFIX = '/community'

    /* ------------------------------- 小工具 ------------------------------- */

    /*
     * 语言。
     *
     * 默认跟浏览器（`navigator.languages[0]`），但**允许在设置页手动覆盖**并记住 ——
     * 浏览器语言是「这台机器给所有人用的设置」，而界面语言是「我个人此刻想看的」。
     * 一个中文系统上想用英文界面的用户，不该只能去改操作系统。
     *
     * 状态很小，所以手写一个订阅式 store，不引任何依赖：
     * 覆盖值变化时派发一个事件，挂在 `useLang()` 上的组件立刻重渲染。
     * （侧栏那个图标按钮的文字是宿主在投影时算的，要下次加载才会跟着变 —— 已知且可接受。）
     */
    const LANG_KEY = 'dsh-plugin-community:lang'
    const LANG_EVENT = 'dsh-plugin-community:lang'
    const SUPPORTED = ['zh', 'en']

    let langOverride = null
    let langLoaded = false

    function browserLocale() {
      try {
        const list = navigator.languages
        const first = (list && list[0]) || navigator.language || 'en'
        return String(first).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    function currentLang() {
      if (!langLoaded) {
        langLoaded = true
        try {
          const stored = window.localStorage.getItem(LANG_KEY)
          if (SUPPORTED.includes(stored)) langOverride = stored
        } catch {
          // 隐私模式 / 存储被禁时 localStorage 会抛，这时就用浏览器语言，不影响使用
        }
      }
      return langOverride || browserLocale()
    }

    function setLang(code) {
      const next = SUPPORTED.includes(code) ? code : browserLocale()
      langOverride = next
      langLoaded = true
      try {
        window.localStorage.setItem(LANG_KEY, next)
      } catch {
        /* 存不下就算了，本次会话内仍然有效 */
      }
      try {
        window.dispatchEvent(new Event(LANG_EVENT))
      } catch {
        /* 派发失败只是不能即时刷新，下次渲染照样是对的 */
      }
    }

    function useLang() {
      const [code, setCode] = React.useState(currentLang)
      React.useEffect(() => {
        const sync = () => setCode(currentLang())
        window.addEventListener(LANG_EVENT, sync)
        // `storage` 事件让同一个 DSH 里的其它标签页也跟着切
        window.addEventListener('storage', sync)
        return () => {
          window.removeEventListener(LANG_EVENT, sync)
          window.removeEventListener('storage', sync)
        }
      }, [])
      return code
    }

    function text(localeArg) {
      const z = (localeArg || currentLang()) === 'zh'
      return {
        locale: z ? 'zh' : 'en',
        panel: z ? '社区' : 'Community',
        title: z ? 'DSH 插件社区' : 'DSH Plugin Community',
        subtitle: z
          ? '插件索引、讨论与已知问题。内容托管在 GitHub。'
          : 'Plugin index, discussions and known issues. Hosted on GitHub.',
        search: z ? '搜索插件…' : 'Search plugins…',
        open: z ? '打开完整社区页' : 'Open full community page',
        stars: z ? '星标' : 'stars',
        loading: z ? '加载中…' : 'Loading…',
        empty: z ? '索引里还没有匹配的插件。' : 'No matching plugin in the index.',
        failed: z ? '读不到索引。' : 'Could not read the index.',
        retry: z ? '重试' : 'Retry',
        badge: z ? '看社区口碑' : 'Community',
        section: z ? '社区讨论与已知问题' : 'Community discussions and known issues',
        discussions: z ? '讨论' : 'Discussions',
        issues: z ? '待办问题' : 'Open issues',
        known: z ? '已知问题' : 'Known issues',
        needsLogin: z
          ? '讨论列表需要登录 GitHub 后才能读取（未认证时 GraphQL 配额为 0）。'
          : 'Discussion lists need a GitHub login (unauthenticated GraphQL quota is 0).',
        notIndexed: z ? '这个插件还没被任何索引源收录。' : 'Not covered by any index source yet.',
        viewOnCommunity: z ? '在社区里看' : 'View in community',
        settings: z ? '社区' : 'Community',
        repo: z ? '社区仓库' : 'Community repo',
        account: z ? 'GitHub 账号' : 'GitHub account',
        signedInAs: z ? '已登录为' : 'Signed in as',
        anonymous: z ? '未登录（只能看，不能发）' : 'Not signed in (read-only)',
        login: z ? '用 GitHub 登录' : 'Sign in with GitHub',
        logout: z ? '登出' : 'Sign out',
        notConfigured: z
          ? '还没配置 GitHub OAuth App 的 Client ID，登录暂时不可用。'
          : 'No GitHub OAuth App Client ID configured yet, sign-in is unavailable.',
        codeHint: z ? '在 GitHub 输入这个验证码：' : 'Enter this code on GitHub:',
        openGithub: z ? '打开 GitHub 授权页' : 'Open GitHub',
        waiting: z ? '等待授权…' : 'Waiting for authorization…',
        language: z ? '界面语言' : 'Interface language',
        langZh: '中文',
        langEn: 'English',
        langHint: z ? '默认跟随浏览器，改了会记住。' : 'Follows your browser by default; your choice is remembered.',
        // Agent 工具卡片（第 7 个座位）
        toolUnknown: z ? '社区工具' : 'Community tool',
        toolPreparing: z ? '正在准备参数…' : 'Preparing arguments…',
        toolPending: z ? '等待结果…' : 'Waiting for a result…',
        toolArgsCut: z ? '参数已被上下文窗口截断。' : 'Arguments were trimmed from the context window.',
        toolFailed: z ? '工具返回了错误。' : 'The tool returned an error.',
        toolPhasePreparing: z ? '准备中' : 'preparing',
        toolPhaseStart: z ? '执行中' : 'running',
        toolPhaseResult: z ? '已完成' : 'done',
        toolName_community_search: z ? '搜索插件' : 'Search plugins',
        toolName_community_plugin: z ? '插件详情' : 'Plugin detail',
        toolName_community_post: z ? '发帖 / 评论' : 'Post / comment',
        toolName_community_triage: z ? '社区巡检' : 'Community triage',
      }
    }

    function fmtCount(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return ''
      if (n < 1000) return String(n)
      if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      if (n < 1000000) return Math.round(n / 1000) + 'k'
      return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
    }

    function packageOf(subject) {
      if (!subject || typeof subject !== 'object') return ''
      const pkg = subject.pkg && subject.pkg.name
      if (typeof pkg === 'string' && pkg) return pkg
      const row = subject.row && subject.row.moduleName
      if (typeof row === 'string' && row) return row
      return ''
    }

    async function apiGet(path, params, signal) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      const res = await fetch(`${API_PREFIX}${path}${qs}`, {
        credentials: 'same-origin',
        signal,
        headers: { accept: 'application/json' },
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body || body.ok === false) {
        const error = new Error((body && body.message) || `HTTP ${res.status}`)
        error.status = res.status
        error.reason = body && body.reason
        throw error
      }
      return body.data
    }

    async function apiPost(path, payload, signal) {
      const res = await fetch(`${API_PREFIX}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body || body.ok === false) {
        const error = new Error((body && body.message) || `HTTP ${res.status}`)
        error.status = res.status
        error.reason = body && body.reason
        throw error
      }
      return body.data
    }

    function useAsync(loader, deps) {
      const [state, setState] = React.useState({ kind: 'loading' })
      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        setState({ kind: 'loading' })
        loader(controller.signal)
          .then((data) => {
            if (alive) setState({ kind: 'ok', data })
          })
          .catch((error) => {
            if (alive && !controller.signal.aborted) setState({ kind: 'error', error })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, deps || [])
      return state
    }

    /* --------------------------------- 样式 --------------------------------- */

    // 全部走宿主的主题变量：这样明暗主题、字号、配色都自动跟随，
    // 不需要（也不应该）自己写死颜色。
    const CSS = [
      '.dcom{display:flex;flex-direction:column;gap:10px;padding:14px;box-sizing:border-box;min-height:100%;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dcom-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dcom-title{font-size:15px;font-weight:600}',
      '.dcom-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dcom-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.dcom-list{display:flex;flex-direction:column;gap:2px}',
      '.dcom-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;min-width:0}',
      '.dcom-row:hover{background:var(--dsw-alias-bg-layer-3)}',
      '.dcom-name{font-weight:500;color:inherit;text-decoration:none;white-space:nowrap}',
      '.dcom-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dcom-star{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dcom-pill{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dcom-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}',
      '.dcom-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.dcom-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dcom-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;letter-spacing:.14em;user-select:all}',
      '.dcom-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dcom-link{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.dcom-overlay{position:fixed;right:16px;bottom:16px;z-index:60;pointer-events:auto;max-width:320px}',
      '.dcom-inline{display:flex;align-items:center;gap:6px}',
      '.dcom-tool{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;font-size:12px;box-sizing:border-box}',
      '.dcom-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dcom-tool-name{font-weight:600}',
      '.dcom-tool-args{color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.dcom-tool-body{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:220px;overflow:auto}',
    ].join('')

    function Style() {
      return h('style', null, CSS)
    }

    /* ------------------------------ 1. 侧栏图标 ------------------------------ */

    // 侧栏自己拥有那个按钮（它会按 list id 派发到同名的 main 面板），
    // 所以这里只负责画图标；`active` 由侧栏传入，用来高亮。
    function CommunityIcon(props) {
      const size = Number(props && props.size) || 18
      const active = Boolean(props && props.active)
      return h(
        'span',
        {
          className: 'dcom-inline',
          style: { opacity: active ? 1 : 0.75, color: active ? 'var(--dsw-alias-brand-primary)' : 'inherit' },
          'aria-hidden': true,
        },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M8.6 17.2 6 20v-2.8A7 7 0 0 1 4 12.2C4 8.5 7.6 5.6 12 5.6s8 2.9 8 6.6-3.6 6.6-8 6.6a9.6 9.6 0 0 1-3.4-.6Z' }),
          h('path', { d: 'M9 11.8h.01M12 11.8h.01M15 11.8h.01' }),
        ),
      )
    }

    /* ------------------------------ 2. 社区主面板 ----------------------------- */

    function PluginRow(props) {
      const card = props.card
      const t = text(useLang())
      const desc = card.description ? card.description[t.locale] || card.description.zh || card.description.en : ''
      return h(
        'div',
        { className: 'dcom-row' },
        h('a', { className: 'dcom-name', href: card.url, target: '_blank', rel: 'noreferrer noopener' }, card.name),
        h('span', { className: 'dcom-desc' }, desc),
        h('span', { className: 'dcom-star' }, card.stars ? '★ ' + fmtCount(card.stars) : ''),
      )
    }

    function CommunityPanel() {
      const t = text(useLang())
      const [query, setQuery] = React.useState('')
      const [term, setTerm] = React.useState('')
      const state = useAsync(
        (signal) => apiGet('/plugins', { q: term, sort: 'stars', perPage: 30 }, signal),
        [term],
      )

      const items = state.kind === 'ok' ? state.data.items || [] : []

      return h(
        'div',
        { className: 'dcom' },
        h(Style),
        h(
          'div',
          { className: 'dcom-head' },
          h('span', { className: 'dcom-title' }, t.title),
          h('span', { className: 'dcom-sub' }, t.subtitle),
        ),
        h(
          'form',
          {
            className: 'dcom-actions',
            onSubmit: (event) => {
              event.preventDefault()
              setTerm(query.trim())
            },
          },
          h('input', {
            className: 'dcom-row',
            style: { flex: '1 1 200px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', font: 'inherit', padding: '5px 8px' },
            value: query,
            placeholder: t.search,
            onChange: (event) => setQuery(event.target.value),
            'aria-label': t.search,
          }),
          h('button', { className: 'dcom-btn', type: 'submit' }, t.search),
          h('a', { className: 'dcom-btn', href: `${PAGE_PREFIX}/`, target: '_blank', rel: 'noreferrer noopener' }, t.open),
        ),
        state.kind === 'loading' ? h('div', { className: 'dcom-muted' }, t.loading) : null,
        state.kind === 'error'
          ? h(
              'div',
              { className: 'dcom-card' },
              h('span', { className: 'dcom-muted' }, t.failed + ' ' + (state.error && state.error.message ? state.error.message : '')),
              h('div', { className: 'dcom-actions' },
                h('button', { className: 'dcom-btn', type: 'button', onClick: () => setTerm(term + ' ') }, t.retry)),
            )
          : null,
        state.kind === 'ok' && items.length === 0 ? h('div', { className: 'dcom-muted' }, t.empty) : null,
        items.length
          ? h('div', { className: 'dcom-card' }, h('div', { className: 'dcom-list' }, items.map((card) => h(PluginRow, { key: card.slug || card.repo, card }))))
          : null,
      )
    }

    /* --------------------------- 3/4. 插件详情页区块 --------------------------- */

    function detailState(subject) {
      const pkg = packageOf(subject)
      return useAsync(
        (signal) => (pkg ? apiGet('/plugin', { pkg }, signal) : Promise.resolve(null)),
        [pkg],
      )
    }

    function PluginBadge(props) {
      const pkg = packageOf(props && props.subject)
      const state = detailState(props && props.subject)
      if (!pkg) return null
      if (state.kind === 'loading') return h('span', { className: 'dcom-pill' }, '…')
      // 索引里没有这个插件时**什么都不画** —— 详情页已经有它自己的标签了，
      // 不要用占位符把标题挤乱（catalog 原文：renders null for a subject it has nothing for）。
      if (state.kind !== 'ok' || !state.data) return null
      const card = state.data.card || {}
      const stars = fmtCount(card.stars)
      if (!stars) return null
      return h('span', { className: 'dcom-pill' }, '★ ' + stars)
    }

    function PluginSection(props) {
      const t = text(useLang())
      const pkg = packageOf(props && props.subject)
      const state = detailState(props && props.subject)
      if (!pkg) return null
      if (state.kind === 'loading') return h('div', { className: 'dcom dcom-muted' }, t.loading)
      if (state.kind === 'error') {
        return h('div', { className: 'dcom' }, h(Style), h('div', { className: 'dcom-muted' }, t.notIndexed))
      }
      const detail = state.data
      if (!detail) return null
      const card = detail.card || {}
      const discussions = detail.discussions || {}
      const issues = detail.issues || {}

      return h(
        'div',
        { className: 'dcom' },
        h(Style),
        h('div', { className: 'dcom-head' }, h('span', { className: 'dcom-title' }, t.section)),
        h(
          'div',
          { className: 'dcom-actions' },
          card.stars ? h('span', { className: 'dcom-pill' }, '★ ' + fmtCount(card.stars)) : null,
          Number.isFinite(card.openIssues) ? h('span', { className: 'dcom-pill' }, t.issues + ' ' + card.openIssues) : null,
          card.archived ? h('span', { className: 'dcom-pill' }, 'archived') : null,
          card.license ? h('span', { className: 'dcom-pill' }, card.license) : null,
        ),
        // 读不到讨论就**如实说读不到**，不给空列表 —— 空列表会被误读成「没有讨论」。
        discussions && discussions.available === false
          ? h('div', { className: 'dcom-muted' }, t.needsLogin)
          : null,
        discussions && discussions.available && (discussions.items || []).length
          ? h(
              'div',
              { className: 'dcom-card' },
              h('div', { className: 'dcom-sub' }, t.discussions),
              h(
                'div',
                { className: 'dcom-list' },
                (discussions.items || []).slice(0, 8).map((item) =>
                  h(
                    'div',
                    { className: 'dcom-row', key: item.id || item.url },
                    h('a', { className: 'dcom-name', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, item.title),
                    h('span', { className: 'dcom-star' }, item.category || ''),
                  ),
                ),
              ),
            )
          : null,
        (issues.items || []).length
          ? h(
              'div',
              { className: 'dcom-card' },
              h('div', { className: 'dcom-sub' }, t.known),
              h(
                'div',
                { className: 'dcom-list' },
                (issues.items || []).slice(0, 5).map((item) =>
                  h(
                    'div',
                    { className: 'dcom-row', key: String(item.number) },
                    h('a', { className: 'dcom-name', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, '#' + item.number + ' ' + item.title),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dcom-actions' },
          h(
            'a',
            { className: 'dcom-btn primary', href: `${PAGE_PREFIX}/plugin?repo=${encodeURIComponent(card.repo || '')}`, target: '_blank', rel: 'noreferrer noopener' },
            t.viewOnCommunity,
          ),
        ),
      )
    }

    /* ----------------------------- 5. 设置页 ----------------------------- */

    function CommunitySettings() {
      const t = text(useLang())
      const [busy, setBusy] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      const meta = useAsync((signal) => apiGet('/meta', null, signal), [nonce])
      const me = useAsync((signal) => apiGet('/me', null, signal), [nonce])

      async function logout() {
        setBusy(true)
        try {
          await apiPost('/auth/logout', {})
          setNonce((n) => n + 1)
        } finally {
          setBusy(false)
        }
      }

      const metaData = meta.kind === 'ok' ? meta.data : null
      const meData = me.kind === 'ok' ? me.data : null

      return h(
        'div',
        { className: 'dcom' },
        h(Style),
        h('div', { className: 'dcom-head' }, h('span', { className: 'dcom-title' }, t.settings)),
        h(
          'div',
          { className: 'dcom-card' },
          h(
            'div',
            { className: 'dcom-inline' },
            h('span', { className: 'dcom-sub' }, t.repo),
            metaData
              ? h('a', { className: 'dcom-link', href: metaData.communityUrl, target: '_blank', rel: 'noreferrer noopener' }, metaData.fullName)
              : h('span', { className: 'dcom-muted' }, t.loading),
          ),
          h(
            'div',
            { className: 'dcom-inline' },
            h('span', { className: 'dcom-sub' }, t.account),
            meData && meData.authenticated
              ? h('span', null, t.signedInAs + ' ' + meData.login)
              : h('span', { className: 'dcom-muted' }, t.anonymous),
          ),
          h(
            'div',
            { className: 'dcom-inline' },
            h('span', { className: 'dcom-sub' }, t.language),
            h(
              'span',
              { className: 'dcom-inline' },
              h(
                'button',
                { type: 'button', className: 'dcom-btn' + (t.locale === 'zh' ? ' primary' : ''), onClick: () => setLang('zh') },
                t.langZh,
              ),
              h(
                'button',
                { type: 'button', className: 'dcom-btn' + (t.locale === 'en' ? ' primary' : ''), onClick: () => setLang('en') },
                t.langEn,
              ),
            ),
          ),
          h('div', { className: 'dcom-muted' }, t.langHint),
          metaData && metaData.clientIdConfigured === false
            ? h('div', { className: 'dcom-muted' }, t.notConfigured)
            : null,
          h(
            'div',
            { className: 'dcom-actions' },
            !(meData && meData.authenticated) && metaData && metaData.clientIdConfigured
              ? h('a', { className: 'dcom-btn primary', href: `${PAGE_PREFIX}/login`, target: '_blank', rel: 'noreferrer noopener' }, t.login)
              : null,
            meData && meData.authenticated
              ? h('button', { className: 'dcom-btn', type: 'button', disabled: busy, onClick: logout }, t.logout)
              : null,
            h('a', { className: 'dcom-btn', href: `${PAGE_PREFIX}/`, target: '_blank', rel: 'noreferrer noopener' }, t.open),
          ),
        ),
      )
    }

    /* ----------------------------- 6. 登录浮层 ----------------------------- */

    // shell.overlay 整层是「点击穿透」的，占位者必须自己 opt-in 指针事件，
    // 否则它下面的界面会被挡住。
    function LoginOverlay() {
      const t = text(useLang())
      const [flow, setFlow] = React.useState(null)
      const [note, setNote] = React.useState('')
      const me = useAsync((signal) => apiGet('/me', null, signal), [])
      const authenticated = me.kind === 'ok' && me.data && me.data.authenticated
      const configured = me.kind === 'ok' && me.data && me.data.configured

      React.useEffect(() => {
        if (authenticated || configured !== true || flow) return undefined
        const controller = new AbortController()
        apiPost('/auth/start', {}, controller.signal)
          .then((data) => setFlow(data))
          .catch((error) => setNote(error && error.message ? error.message : ''))
        return () => controller.abort()
      }, [authenticated, configured])

      React.useEffect(() => {
        if (!flow || !flow.flowId) return undefined
        const controller = new AbortController()
        let timer = null
        const interval = Math.max(3, Number(flow.interval) || 5) * 1000
        const tick = () => {
          apiPost('/auth/poll', { flowId: flow.flowId }, controller.signal)
            .then(() => {
              // poll 成功 = 拿到 token 了，宿主侧已经存好，这里刷新即可
              window.location.reload()
            })
            .catch((error) => {
              if (error && error.reason === 'EXPIRED') {
                setFlow(null)
                setNote('')
              } else {
                timer = setTimeout(tick, interval)
              }
            })
        }
        timer = setTimeout(tick, interval)
        return () => {
          controller.abort()
          if (timer) clearTimeout(timer)
        }
      }, [flow])

      if (authenticated || configured === false) return null

      if (!flow) {
        if (!note) return null
        return h('div', { className: 'dcom-overlay' }, h('div', { className: 'dcom-card' }, h(Style), h('div', { className: 'dcom-muted' }, note)))
      }

      return h(
        'div',
        { className: 'dcom-overlay' },
        h(
          'div',
          { className: 'dcom-card' },
          h(Style),
          h('div', { className: 'dcom-sub' }, t.codeHint),
          h('div', { className: 'dcom-code' }, flow.userCode),
          h(
            'div',
            { className: 'dcom-actions' },
            h('a', { className: 'dcom-btn primary', href: flow.verificationUri, target: '_blank', rel: 'noreferrer noopener' }, t.openGithub),
            h('span', { className: 'dcom-muted' }, t.waiting),
          ),
        ),
      )
    }

    /* --------------------------- 7. Agent 工具卡片 --------------------------- */

    /*
     * `tool.call.toolview` 是 **keyed** 槽，key 就是 wire 工具名。也就是说
     * 注册这四个 key 只覆盖本插件自己的工具，不会碰到官方 UI —— 但这件事
     * 必须先查过再动：`cordis_inspect_query` 给出的 `policy.replaceRisk` 是
     * `shadows-shipped-ui`，key 域是 open 的，写错一个名字就会把别人的卡片顶掉。
     * 已占名单里没有 `community_*`，所以这里四个纯属增量。
     *
     * props 的权威形状来自 `@deepseek-ai/dsh-client-ui-conversation` 的
     * `lib/types/client/contract/records.d.ts`：
     *   { phase:'preparing', block:{ phase:'preparing', callId, name, turn, step, time, subCalls } }
     *   { phase:'start',     block:{ phase:'start',     ..., argsRaw } }
     *   { phase:'result',    block:{ kind:'tool-result', call:{name,argsRaw}|null,
     *                                content:ContentBlock[], isError, error?, callId, subCalls } }
     * 三个要点：① `phase` 在 block **外面**（props 上），block 自己没有；
     * ② `preparing` 阶段类型上就没有参数，别去猜；③ `call` 可能是 `null`
     * （结果还在、参数已被上下文窗口截断），这时不能假装参数为空字符串。
     */
    const TOOLVIEW_TOOLS = ['community_search', 'community_plugin', 'community_post', 'community_triage']

    // `ToolResultNode.content` 是 `ContentBlock[]`。本插件自己的工具只产出文本块
    // （host 侧 `output.render` 返回 `[{type:'text', text}]`），但这里是别人交给
    // 我们的运行时数据，所以每种可能都留一条退路，认不出来就当空。
    function contentText(content) {
      if (typeof content === 'string') return content.trim()
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const item of content) {
        if (!item) continue
        if (typeof item === 'string') {
          parts.push(item)
          continue
        }
        if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      }
      return parts.join('\n').trim()
    }

    // `argsRaw` 是模型给出的原始 JSON 字符串。流式期间它可能是半截 JSON ——
    // 解析失败不是错误，直接显示原文就对了（不要吞掉，也不要显示 "{}"）。
    function prettyArgs(raw) {
      if (typeof raw !== 'string' || !raw.trim()) return ''
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return String(raw)
        return Object.keys(parsed)
          .filter((key) => parsed[key] !== '' && parsed[key] !== null && parsed[key] !== undefined)
          .map((key) => key + ': ' + (typeof parsed[key] === 'object' ? JSON.stringify(parsed[key]) : String(parsed[key])))
          .join(' · ')
      } catch {
        return String(raw)
      }
    }

    function toolViewModel(props) {
      const block = (props && props.block) || {}
      const phase = (props && props.phase) || block.phase || 'result'
      const name = (props && props.toolName) || block.name || (block.call && block.call.name) || ''
      if (phase !== 'result') {
        return {
          name,
          phase,
          args: phase === 'start' ? prettyArgs(block.argsRaw) : '',
          argsLost: false,
          text: '',
          isError: false,
          error: '',
        }
      }
      return {
        name,
        phase,
        // result 阶段的参数在 `block.call` 里；`call` 为 null 表示参数已被窗口截断。
        args: block.call ? prettyArgs(block.call.argsRaw) : '',
        argsLost: !block.call,
        text: contentText(block.content),
        isError: Boolean(block.isError),
        error: block.isError && block.error ? block.error.reason || block.error.name || block.error.code || '' : '',
      }
    }

    function CommunityToolCall(props) {
      const t = text(useLang())
      let vm
      try {
        vm = toolViewModel(props)
      } catch {
        // 视图层永远不该把对话流搞崩。形状对不上时退化成一行说明，
        // 而不是抛出去让整条消息渲染失败。
        return h('div', { className: 'dcom-tool' }, h('span', { className: 'dcom-muted' }, t.toolUnknown))
      }

      const title = t['toolName_' + vm.name] || vm.name || t.toolUnknown
      const phaseLabel =
        vm.phase === 'preparing' ? t.toolPhasePreparing : vm.phase === 'start' ? t.toolPhaseStart : t.toolPhaseResult

      const body = []
      if (vm.args) body.push(h('div', { className: 'dcom-tool-args' }, vm.args))
      if (vm.argsLost) body.push(h('div', { className: 'dcom-tool-args' }, t.toolArgsCut))
      if (vm.isError) body.push(h('div', { className: 'dcom-tool-args' }, '⚠ ' + (vm.error || t.toolFailed)))
      if (vm.text) body.push(h('div', { className: 'dcom-tool-body' }, vm.text))
      if (!body.length) {
        body.push(h('div', { className: 'dcom-tool-args' }, vm.phase === 'preparing' ? t.toolPreparing : t.toolPending))
      }

      return h(
        'div',
        { className: 'dcom-tool' },
        h(Style),
        h(
          'div',
          { className: 'dcom-tool-head' },
          h('span', { className: 'dcom-tool-name' }, title),
          h('span', { className: 'dcom-pill' }, phaseLabel),
        ),
        h('div', null, body),
      )
    }

    /* -------------------------------- 接线 -------------------------------- */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) {
        console.error('[community] 拿不到 slots 服务，client 半边不注册任何座位')
        return
      }

      const t = text()

      // 侧栏图标与主面板用同一个字符串 `community`：catalog 明确说
      // 「Each list id addresses the matching main panel」，两边同名即自动成对。
      ctx.effect(
        () =>
          slots.inject('sidebar.panellist', () =>
            slots.register(
              { name: 'sidebar.panellist', id: MAIN_PANEL_KEY, order: 30, label: () => text().panel },
              CommunityIcon,
            ),
          ),
        'dsh-plugin-community: sidebar entry',
      )

      ctx.effect(
        () => slots.inject('main', () => slots.register({ name: 'main', key: MAIN_PANEL_KEY }, CommunityPanel)),
        'dsh-plugin-community: main panel',
      )

      ctx.effect(
        () =>
          slots.inject('plugins.detail.section', () =>
            slots.register(
              { name: 'plugins.detail.section', id: MAIN_PANEL_KEY, order: 40, label: () => text().section },
              PluginSection,
            ),
          ),
        'dsh-plugin-community: plugin detail section',
      )

      ctx.effect(
        () =>
          slots.inject('plugins.detail.badge', () =>
            slots.register(
              { name: 'plugins.detail.badge', id: MAIN_PANEL_KEY, order: 20, label: () => text().badge },
              PluginBadge,
            ),
          ),
        'dsh-plugin-community: plugin detail badge',
      )

      ctx.effect(
        () =>
          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: MAIN_PANEL_KEY, order: 45, label: () => text().settings },
              CommunitySettings,
            ),
          ),
        'dsh-plugin-community: settings section',
      )

      ctx.effect(
        () =>
          slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: 'community-login', order: 70 }, LoginOverlay),
          ),
        'dsh-plugin-community: login overlay',
      )

      // 四个 Agent 工具各占一个 keyed 座位，key 必须与 host 侧 `tools.register`
      // 里的 `name` 一字不差 —— 对不上就静默回落到官方通用卡片（不会报错，
      // 所以有测试盯着这两边的名字是不是同一组）。
      for (const toolName of TOOLVIEW_TOOLS) {
        ctx.effect(
          () =>
            slots.inject('tool.call.toolview', () =>
              slots.register({ name: 'tool.call.toolview', key: toolName }, CommunityToolCall),
            ),
          'dsh-plugin-community: tool view ' + toolName,
        )
      }

      void t
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
