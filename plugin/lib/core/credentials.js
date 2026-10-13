/**
 * token 存储层。
 *
 * 两条硬规矩（docs/04 §7）：
 *   1. **插件目录下不允许出现任何 token 文件** —— token 只存在 DSH 的 credentials 服务里。
 *   2. token 只在 host 侧出现：不回前端、不写日志。
 *
 * 为什么用 credentials 的「记录半边」（CredentialKey / readRecord / modifyRecord）而不是
 * 「引用半边」（CredentialRef / resolve / set）：
 *   - 引用半边回答的是「这个**环境变量名**背后是什么」，会层层覆盖 process env 与 .env；
 *     它的 `set` 在只读源遮蔽时会拒绝写入 —— 那是给配置型密钥用的。
 *   - 记录半边回答的是「这个插件为这个 id 持有什么凭据」，而 OAuth 授权没有环境可读，
 *     「记录存在」本身就是全部事实。官方文档也写明 `modifyRecord` 是记录的唯一写路径，
 *     因为正确的写入依赖于当前值（token 刷新就是一次加锁的 read-decide-replace）。
 * 我们持有的正是一份 OAuth 授权，所以用记录半边。
 *
 * 另外留了一条**只读**的环境变量口子 `DSH_PLUGIN_COMMUNITY_GITHUB_TOKEN`：
 * 给「我就想塞个 PAT 跑一下 CI / 本地预览」的人用，不落盘、优先级低于正式登录。
 */

/** 记录半边用的 key（运行时就是普通字符串，品牌只是 TypeScript 的幻影类型）。 */
export const CREDENTIAL_KEY = 'dsh-plugin-community:github'

/** 只读环境变量口子。 */
export const CREDENTIAL_REF = 'DSH_PLUGIN_COMMUNITY_GITHUB_TOKEN'

function splitScopes(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
  return String(value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
}

function payloadOf(record) {
  if (!record || typeof record !== 'object') return null
  if (record.kind === 'grant') return record.payload
  if (record.kind === 'api-key') return record.key ?? null
  return record
}

export function createTokenStore({ credentials, logger } = {}) {
  let cached = null
  let hydrated = false

  const warn = (message) => logger?.warn?.(`[community] ${message}`)

  function normalize(input) {
    if (!input || typeof input !== 'object') return null
    const accessToken = String(input.accessToken ?? '').trim()
    // 空值一律当不存在 —— 和 credentials 自己的规则保持一致（空值永不冒充已配置）
    if (!accessToken) return null
    return {
      accessToken,
      login: input.login ? String(input.login) : null,
      avatarUrl: input.avatarUrl ? String(input.avatarUrl) : null,
      scopes: splitScopes(input.scopes),
      tokenType: input.tokenType ?? 'bearer',
      obtainedAt: input.obtainedAt ?? null,
      source: input.source ?? 'unknown',
    }
  }

  /** 可能是 JSON 记录，也可能是一根裸 token（环境变量就是后者）。 */
  function decode(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return null
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text)
        const normalized = normalize(parsed)
        if (normalized) return normalized
      } catch {
        // 不是 JSON，按裸 token 继续处理
      }
    }
    return normalize({ accessToken: text })
  }

  /** 同步读，永远不返回 token 本身，只返回可以给前端看的字段。 */
  function get() {
    return cached
  }

  function accessToken() {
    return cached?.accessToken ?? null
  }

  function publicView() {
    if (!cached) return { authenticated: false }
    return {
      authenticated: true,
      login: cached.login,
      avatarUrl: cached.avatarUrl,
      scopes: cached.scopes,
      obtainedAt: cached.obtainedAt,
      source: cached.source,
      // 故意不返回 accessToken
    }
  }

  async function hydrate({ force = false } = {}) {
    if (hydrated && !force) return cached
    hydrated = true

    if (!credentials) {
      cached = null
      return cached
    }

    // 1) 只读环境变量口子（CI / 本地预览用）
    try {
      const resolved = await credentials.resolve?.(CREDENTIAL_REF)
      if (resolved?.value) {
        const fromRef = decode(resolved.value)
        if (fromRef) {
          cached = { ...fromRef, source: `env:${resolved.source ?? 'ref'}` }
          return cached
        }
      }
    } catch (error) {
      warn(`读环境凭据失败：${error?.message ?? error}`)
    }

    // 2) 插件自己持有的授权记录（登录流程写进去的）
    try {
      const record = await credentials.readRecord?.(CREDENTIAL_KEY)
      const fromRecord = decode(payloadOf(record))
      if (fromRecord) {
        cached = { ...fromRecord, source: 'record' }
        return cached
      }
    } catch (error) {
      warn(`读凭据记录失败：${error?.message ?? error}`)
    }

    cached = null
    return cached
  }

  /**
   * 落库。写入前先更新内存，这样紧接着的请求就能用上；
   * 写失败会把内存也回滚掉 —— 宁可当成没登录，也不要出现「内存里有、磁盘上没有」的假登录态。
   */
  async function save(input) {
    const next = normalize({ ...input, obtainedAt: input?.obtainedAt ?? new Date().toISOString() })
    if (!next) throw new Error('token 不能为空')

    const previous = cached
    cached = { ...next, source: 'memory' }
    hydrated = true

    if (!credentials || typeof credentials.modifyRecord !== 'function') {
      warn('没有可用的 credentials 服务，token 只存在内存里，进程一重启就得重新登录。')
      return cached
    }

    const payload = {
      accessToken: next.accessToken,
      login: next.login,
      avatarUrl: next.avatarUrl,
      scopes: next.scopes,
      tokenType: next.tokenType,
      obtainedAt: next.obtainedAt,
    }

    try {
      await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload }))
      cached = { ...cached, source: 'record' }
      return cached
    } catch (error) {
      cached = previous
      warn(`保存凭据失败：${error?.message ?? error}`)
      throw error
    }
  }

  /** 登录成功后补上 login / avatarUrl（这两个要额外打一次 API 才拿得到）。 */
  async function updateProfile(profile) {
    if (!cached) return null
    return save({ ...cached, ...profile })
  }

  async function clear() {
    cached = null
    hydrated = true
    if (!credentials || typeof credentials.deleteRecord !== 'function') return
    try {
      await credentials.deleteRecord(CREDENTIAL_KEY)
    } catch (error) {
      warn(`清除凭据失败：${error?.message ?? error}`)
    }
  }

  return {
    KEY: CREDENTIAL_KEY,
    REF: CREDENTIAL_REF,
    available: () => Boolean(credentials && typeof credentials.modifyRecord === 'function'),
    get,
    accessToken,
    publicView,
    hydrate,
    save,
    updateProfile,
    clear,
  }
}
