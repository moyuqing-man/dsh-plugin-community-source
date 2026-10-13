/**
 * GitHub Device Flow 登录（M2）。
 *
 * 为什么是 Device Flow（docs/04 §1）：本机插件**没有回调地址**，
 * 而 Web Flow 换 token 那一步的 `client_secret` 标着 Required ——
 * 嵌进桌面 App 等于把 secret 公开。Device Flow 的设计前提就是「公开客户端」：
 * **只要一个 client_id，不需要 secret，不需要回调域名。**
 *
 * 因此整个社区插件**不需要任何服务端秘密**，可以开源、可以被任何人自建实例。
 *
 * 几条从官方文档逐字核对来的硬事实（docs/08 §3.1 与 POC 实测）：
 *   - `device_code` **绝不能给前端**（前端只该拿到 user_code 那 8 位数字）。
 *   - 验证码有效期 `expires_in = 900`（15 分钟），`interval = 5` 秒。
 *   - 轮太快会回 `slow_down`，此时**间隔 +5 秒**。
 *   - 验证码提交有 **50 次/小时/应用** 的限制 —— 这是应用级的，
 *     撞上去等于全社区一起登不上，所以本地也要拦一道（见下面 nextPollAt）。
 */

import { badRequest, expired, forbidden, notConfigured, notFound, upstreamFailed } from './errors.js'

export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const VERIFICATION_URI = 'https://github.com/login/device'
export const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** 写公开仓库的 Discussions 必须要 public_repo；read:user 用来读自己的头像和用户名。 */
export const DEFAULT_SCOPE = 'read:user public_repo'

export const FLOW_TTL_MS = 15 * 60_000
export const DEFAULT_INTERVAL_MS = 5_000
export const SLOW_DOWN_STEP_MS = 5_000
export const MAX_LIVE_FLOWS = 20

/**
 * 轮询可能拿到的每一种 `error`。
 * `terminal: false` 的两种必须继续等 —— 它们不是错误，只是「还没好」。
 */
export const POLL_ERRORS = {
  authorization_pending: { terminal: false, message: '还没在 GitHub 上完成授权，继续等。' },
  slow_down: { terminal: false, slowDown: true, message: '轮询太密了，间隔已自动加 5 秒。' },
  expired_token: {
    terminal: true, status: 410, reason: 'EXPIRED',
    message: '验证码已过期（15 分钟），请重新发起登录。',
  },
  access_denied: {
    terminal: true, status: 403, reason: 'FORBIDDEN',
    message: '你在 GitHub 上取消或拒绝了这次授权。',
  },
  incorrect_client_credentials: {
    terminal: true, status: 503, reason: 'NOT_CONFIGURED',
    message: 'client_id 不对。检查一下 OAuth App 的 Client ID 有没有抄错。',
  },
  device_flow_disabled: {
    terminal: true, status: 503, reason: 'NOT_CONFIGURED',
    message: '这个 OAuth App 没有开启 Device Flow。去 App 设置页把 Enable Device Flow 勾上再试。',
  },
  unsupported_grant_type: {
    terminal: true, status: 500, reason: 'INTERNAL',
    message: '请求类型不被支持 —— 这是插件的问题，不是你操作错了。',
  },
  incorrect_grant_type: {
    terminal: true, status: 500, reason: 'INTERNAL',
    message: '请求类型不被支持 —— 这是插件的问题，不是你操作错了。',
  },
  incorrect_device_code: {
    terminal: true, status: 400, reason: 'BAD_REQUEST',
    message: '设备码不对，请重新发起登录。',
  },
}

// 说明：这里是**纯文本**，会原样进 HTML 的 <pre>，所以不要写 markdown 语法
// （写成 **粗体** 的话用户在页面上看到的就是一串星号）。
const HOWTO = [
  '1. 打开 https://github.com/settings/developers → New OAuth App',
  '2. Application name / Homepage URL 随便填；Authorization callback URL 也必须填一个合法 URL（Device Flow 不用它，但表单必填）',
  '3. 创建后复制 Client ID（这是公开值，不是秘密）',
  '4. 在这个 OAuth App 的设置页把 Enable Device Flow 勾上 ← 漏了这一步会得到 device_flow_disabled',
  '5. 把 Client ID 填进插件配置的 clientId（或改 cordis.patch.yml）',
].join('\n')

const splitScopes = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean)

function newFlowId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createAuthService({
  http,
  tokenStore,
  github,
  cache,
  logger,
  clientId = '',
  scope = DEFAULT_SCOPE,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  flowTtlMs = FLOW_TTL_MS,
} = {}) {
  /** flowId -> 进行中的设备码流程。device_code 只存在这里，绝不出这个对象。 */
  const flows = new Map()

  const knownError = (code) => {
    const spec = POLL_ERRORS[code]
    if (!spec) return null
    switch (spec.status) {
      case 410:
        return expired(spec.message)
      case 403:
        return forbidden(spec.message)
      case 400:
        return badRequest(spec.message)
      case 503:
        return notConfigured(spec.message)
      default:
        return upstreamFailed(spec.message)
    }
  }

  function trimFlows() {
    if (flows.size <= MAX_LIVE_FLOWS) return
    const oldest = [...flows.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [id] of oldest.slice(0, flows.size - MAX_LIVE_FLOWS)) flows.delete(id)
  }

  /** 登录态变化后，所有带 token 才读得到的缓存都得作废。 */
  function invalidateGithubCache() {
    if (!cache?.keys || !cache?.delete) return
    for (const key of cache.keys()) {
      if (String(key).startsWith('gh:')) cache.delete(key)
    }
  }

  async function start() {
    if (!clientId) {
      throw notConfigured('还没配置 GitHub OAuth App 的 Client ID，没法发起登录。', [
        { name: 'howto', value: HOWTO },
      ])
    }

    const response = await http.json(DEVICE_CODE_URL, {
      method: 'POST',
      retries: 0,
      resource: 'auth',
      accept: 'application/json',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, scope }).toString(),
      label: '申请设备码',
    })

    const data = response.json ?? {}
    if (data.error) {
      const known = knownError(String(data.error))
      if (known) throw known
      throw upstreamFailed(`申请设备码失败：${data.error}`)
    }

    const deviceCode = String(data.device_code ?? '')
    const userCode = String(data.user_code ?? '')
    if (!deviceCode || !userCode) throw upstreamFailed('GitHub 没有返回设备码')

    const intervalMs = Math.max(DEFAULT_INTERVAL_MS, Number(data.interval ?? 0) * 1000 || DEFAULT_INTERVAL_MS)
    const expiresInMs = (Number(data.expires_in ?? 0) || 900) * 1000
    const flowId = newFlowId()
    const createdAt = now()

    flows.set(flowId, {
      deviceCode,
      userCode,
      intervalMs,
      createdAt,
      expiresAt: createdAt + Math.min(expiresInMs, flowTtlMs),
      // 刚拿到码就先等一个间隔，免得客户端立刻轮询白费一次配额
      nextPollAt: createdAt + intervalMs,
      slowDowns: 0,
    })
    trimFlows()

    // 注意这里没有任何 device_code
    return {
      status: 'ok',
      flowId,
      userCode,
      verificationUri: String(data.verification_uri ?? VERIFICATION_URI),
      expiresIn: Math.round(Math.min(expiresInMs, flowTtlMs) / 1000),
      interval: Math.round(intervalMs / 1000),
    }
  }

  function pending(flow, reason, message) {
    const waitMs = Math.max(0, flow.nextPollAt - now())
    return {
      status: 'pending',
      reason,
      message,
      interval: Math.round(flow.intervalMs / 1000),
      retryAfterMs: waitMs,
      expiresIn: Math.max(0, Math.round((flow.expiresAt - now()) / 1000)),
    }
  }

  async function poll(flowId) {
    const id = String(flowId ?? '').trim()
    if (!id) throw badRequest('缺少 flowId', ['flowId'])

    const flow = flows.get(id)
    if (!flow) {
      throw notFound('这个登录流程不存在、已经完成，或者已经过期了。请重新点一次「用 GitHub 登录」。')
    }

    const at = now()
    if (at > flow.expiresAt) {
      flows.delete(id)
      throw expired('验证码已过期（15 分钟），请重新发起登录。')
    }

    // 客户端轮得太快时我们自己先挡一道，**不去打 GitHub** ——
    // 官方对验证码提交的限制是 50 次/小时/**应用**，撞上去全社区一起登不上。
    if (at < flow.nextPollAt) {
      return pending(flow, 'slow_down', '轮询太密了，已自动放慢。')
    }

    const response = await http.json(ACCESS_TOKEN_URL, {
      method: 'POST',
      retries: 0,
      resource: 'auth',
      accept: 'application/json',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: flow.deviceCode,
        grant_type: GRANT_TYPE,
      }).toString(),
      label: '轮询登录',
    })

    const data = response.json ?? {}

    if (data.access_token) {
      const accessToken = String(data.access_token)
      const scopes = splitScopes(data.scope)
      await tokenStore.save({
        accessToken,
        scopes,
        tokenType: data.token_type ?? 'bearer',
      })
      flows.delete(id)
      invalidateGithubCache()

      // 拿用户名和头像（这一次调用要花 1 次 core 配额，但一次登录只花一次）
      let profile = null
      try {
        profile = await github.viewer()
      } catch (error) {
        logger?.debug?.(`[community] 登录成功但取用户资料失败：${error?.message ?? error}`)
      }
      if (profile) await tokenStore.updateProfile({ login: profile.login, avatarUrl: profile.avatarUrl })

      return {
        status: 'ok',
        authenticated: true,
        login: profile?.login ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        scopes,
      }
    }

    const code = String(data.error ?? '')
    const spec = POLL_ERRORS[code]
    if (!spec) {
      flows.delete(id)
      throw upstreamFailed(`GitHub 返回了没见过的错误：${code || '(空)'}`)
    }

    if (spec.terminal) {
      flows.delete(id)
      const known = knownError(code)
      if (known) throw known
      throw upstreamFailed(`登录失败：${code}`)
    }

    if (spec.slowDown) {
      flow.intervalMs += SLOW_DOWN_STEP_MS
      flow.slowDowns += 1
    }
    flow.nextPollAt = now() + flow.intervalMs
    return pending(flow, code, spec.message)
  }

  /** 给页面渲染用。**故意不含 device_code** —— 页面只需要那 8 位数字。 */
  function describeFlow(flowId) {
    const id = String(flowId ?? '').trim()
    const flow = flows.get(id)
    if (!flow) return null
    return {
      flowId: id,
      userCode: flow.userCode,
      verificationUri: VERIFICATION_URI,
      expiresIn: Math.max(0, Math.round((flow.expiresAt - now()) / 1000)),
      interval: Math.round(flow.intervalMs / 1000),
      slowDowns: flow.slowDowns,
    }
  }

  async function status() {
    await tokenStore.hydrate()
    return {
      ...tokenStore.publicView(),
      configured: Boolean(clientId),
      verificationUri: VERIFICATION_URI,
      scope: splitScopes(scope),
    }
  }

  async function logout() {
    await tokenStore.clear()
    invalidateGithubCache()
    return { authenticated: false }
  }

  return {
    start,
    poll,
    status,
    logout,
    describeFlow,
    configured: () => Boolean(clientId),
    liveFlows: () => flows.size,
    SCOPE: scope,
  }
}
