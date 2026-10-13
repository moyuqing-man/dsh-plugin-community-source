/**
 * M2 登录流程的测试。
 *
 * 这里测的都是**不看代码就想不到的**行为，尤其是三条：
 *   1. `device_code` 绝不出现在任何返回值里；
 *   2. 轮询太快时**本地就拦掉、不去打 GitHub**（验证码提交有 50 次/小时/应用的上限，
 *      撞上去是全社区一起登不上）；
 *   3. `slow_down` 之后间隔真的 +5 秒。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCESS_TOKEN_URL,
  DEFAULT_SCOPE,
  DEVICE_CODE_URL,
  POLL_ERRORS,
  createAuthService,
} from '../lib/core/auth.js'
import { createCache } from '../lib/core/cache.js'

function makeHttp(script) {
  const calls = []
  const queue = [...script]
  return {
    calls,
    async json(url, options = {}) {
      calls.push({ url, options })
      const reply = queue.shift()
      if (reply instanceof Error) throw reply
      return { ok: true, status: 200, headers: new Headers(), text: '', url, durationMs: 1, json: reply ?? {} }
    },
  }
}

function makeTokenStore() {
  const state = { saved: [], cleared: 0, profile: null, current: null }
  return {
    state,
    accessToken: () => state.current?.accessToken ?? null,
    publicView: () => ({
      authenticated: Boolean(state.current),
      login: state.profile?.login ?? null,
      avatarUrl: state.profile?.avatarUrl ?? null,
      scopes: state.current?.scopes ?? [],
    }),
    hydrate: async () => {},
    async save(input) {
      state.saved.push(input)
      state.current = input
    },
    async updateProfile(profile) {
      state.profile = profile
    },
    async clear() {
      state.cleared += 1
      state.current = null
      state.profile = null
    },
  }
}

function setup({ script = [], clientId = 'Iv1.test', token = true } = {}) {
  let t = 1_000_000
  const now = () => t
  const advance = (ms) => {
    t += ms
  }
  const http = makeHttp(script)
  const tokenStore = makeTokenStore()
  const cache = createCache({ now })
  const viewerCalls = []
  const github = {
    viewer: async () => {
      viewerCalls.push(1)
      return token ? { login: 'moyuqingman', avatarUrl: 'https://avatars/x.png' } : null
    },
  }
  const auth = createAuthService({
    http,
    tokenStore,
    github,
    cache,
    logger: { debug() {}, warn() {} },
    clientId,
    now,
    sleep: async () => {},
  })
  return { auth, http, tokenStore, cache, now, advance, viewerCalls }
}

const deviceCodeReply = {
  device_code: 'DEVICE-CODE-SECRET',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

test('start：申请设备码并**绝不**把 device_code 交出去', async () => {
  const { auth, http } = setup({ script: [deviceCodeReply] })
  const started = await auth.start()

  assert.equal(http.calls.length, 1)
  assert.equal(http.calls[0].url, DEVICE_CODE_URL)
  assert.equal(http.calls[0].options.method, 'POST')
  assert.equal(http.calls[0].options.retries, 0)
  assert.match(http.calls[0].options.body, /client_id=Iv1\.test/)
  assert.match(http.calls[0].options.body, /scope=/)

  assert.equal(started.userCode, 'ABCD-1234')
  assert.equal(started.verificationUri, 'https://github.com/login/device')
  assert.equal(started.expiresIn, 900)
  assert.equal(started.interval, 5)
  assert.ok(started.flowId)

  const serialized = JSON.stringify(started)
  assert.equal(serialized.includes('DEVICE-CODE-SECRET'), false, 'device_code 泄漏了')
  assert.equal(Object.prototype.hasOwnProperty.call(started, 'deviceCode'), false)

  // describeFlow 同样不能泄漏
  const described = auth.describeFlow(started.flowId)
  assert.equal(described.userCode, 'ABCD-1234')
  assert.equal(JSON.stringify(described).includes('DEVICE-CODE-SECRET'), false)
})

test('start：没配 clientId 时报 notConfigured，并带上怎么做', async () => {
  const { auth, http } = setup({ clientId: '' })
  await assert.rejects(
    () => auth.start(),
    (error) => {
      assert.equal(error.status, 503)
      assert.equal(error.reason, 'NOT_CONFIGURED')
      const howto = error.fields?.find((f) => f.name === 'howto')?.value ?? ''
      assert.match(howto, /Enable Device Flow/)
      return true
    },
  )
  assert.equal(http.calls.length, 0, '没配 clientId 就不该打 GitHub')
})

test('poll：间隔没到就在本地挡掉，**不打 GitHub**（保护 50 次/小时/应用 的上限）', async () => {
  const { auth, http } = setup({ script: [deviceCodeReply] })
  const { flowId } = await auth.start()
  assert.equal(http.calls.length, 1)

  // 刚拿到码就立刻轮询 —— 必须被本地拦下
  const first = await auth.poll(flowId)
  assert.equal(first.status, 'pending')
  assert.equal(first.reason, 'slow_down')
  assert.ok(first.retryAfterMs > 0)
  assert.equal(http.calls.length, 1, '本地拦截失败：打到了 GitHub')
})

test('poll：authorization_pending 不当作错误，继续等；间隔到点才真的去问', async () => {
  const { auth, http, advance } = setup({
    script: [deviceCodeReply, { error: 'authorization_pending' }],
  })
  const { flowId } = await auth.start()

  advance(5_000)
  const pending = await auth.poll(flowId)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.reason, 'authorization_pending')
  assert.equal(http.calls.length, 2)
  assert.equal(http.calls[1].url, ACCESS_TOKEN_URL)
  assert.match(http.calls[1].options.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/)
  // 也是 POST，也绝不重试
  assert.equal(http.calls[1].options.retries, 0)
})

test('poll：slow_down 之后间隔 +5 秒，并且下一次更晚才允许轮询', async () => {
  const { auth, http, advance } = setup({
    script: [deviceCodeReply, { error: 'slow_down' }, { error: 'authorization_pending' }],
  })
  const { flowId } = await auth.start()

  advance(5_000)
  const slowed = await auth.poll(flowId)
  assert.equal(slowed.reason, 'slow_down')
  assert.equal(slowed.interval, 10, 'slow_down 之后间隔应该是 5+5=10 秒')

  // 再过 5 秒还不该打 GitHub（因为间隔已经变成 10 秒）
  advance(5_000)
  const blocked = await auth.poll(flowId)
  assert.equal(blocked.reason, 'slow_down')
  assert.equal(http.calls.length, 2, 'slow_down 的间隔没生效')

  advance(5_000)
  const after = await auth.poll(flowId)
  assert.equal(after.reason, 'authorization_pending')
  assert.equal(http.calls.length, 3)
})

test('poll：拿到 token → 存起来、清掉 gh: 缓存、取回用户名', async () => {
  const { auth, tokenStore, cache, http, advance } = setup({
    script: [deviceCodeReply, { access_token: 'FAKE-TOKEN-A', token_type: 'bearer', scope: 'read:user public_repo' }],
  })
  cache.set('gh:discussions:repo', { a: 1 }, { ttlMs: 60_000 })
  cache.set('source:awesome', { a: 2 }, { ttlMs: 60_000 })

  const { flowId } = await auth.start()
  advance(5_000)
  const done = await auth.poll(flowId)

  assert.equal(done.status, 'ok')
  assert.equal(done.authenticated, true)
  assert.equal(done.login, 'moyuqingman')
  assert.deepEqual(done.scopes, ['read:user', 'public_repo'])
  assert.equal(tokenStore.state.saved.length, 1)
  assert.equal(tokenStore.state.saved[0].accessToken, 'FAKE-TOKEN-A')
  assert.equal(tokenStore.state.profile.login, 'moyuqingman')

  // 登录后讨论读得到了，旧缓存必须作废
  assert.equal(cache.peek('gh:discussions:repo').state, 'miss')
  assert.equal(cache.peek('source:awesome').state, 'fresh', '索引源缓存不该被清')

  // 流程用完就销毁，不能重复兑换同一个 device_code
  await assert.rejects(() => auth.poll(flowId), (error) => error.status === 404)
  assert.equal(http.calls.length, 2)
})

test('poll：expired_token → 410 EXPIRED；access_denied → 403', async () => {
  const expired = setup({ script: [deviceCodeReply, { error: 'expired_token' }] })
  const a = await expired.auth.start()
  expired.advance(5_000)
  await assert.rejects(
    () => expired.auth.poll(a.flowId),
    (error) => error.status === 410 && error.reason === 'EXPIRED',
  )

  const denied = setup({ script: [deviceCodeReply, { error: 'access_denied' }] })
  const b = await denied.auth.start()
  denied.advance(5_000)
  await assert.rejects(
    () => denied.auth.poll(b.flowId),
    (error) => error.status === 403,
  )
})

test('poll：device_flow_disabled 给出「去把开关勾上」而不是一句内部错误', async () => {
  const { auth, advance } = setup({ script: [deviceCodeReply, { error: 'device_flow_disabled' }] })
  const { flowId } = await auth.start()
  advance(5_000)
  await assert.rejects(
    () => auth.poll(flowId),
    (error) => {
      assert.equal(error.status, 503)
      assert.match(error.message, /Enable Device Flow/)
      return true
    },
  )
})

test('poll：不存在的 flowId → 404；空 flowId → 400', async () => {
  const { auth } = setup({ script: [deviceCodeReply] })
  await auth.start()
  await assert.rejects(() => auth.poll('nope'), (error) => error.status === 404)
  await assert.rejects(() => auth.poll(''), (error) => error.status === 400)
})

test('poll：超过 15 分钟 → 410，且不去打 GitHub', async () => {
  const { auth, http, advance } = setup({ script: [deviceCodeReply] })
  const { flowId } = await auth.start()
  advance(16 * 60_000)
  await assert.rejects(() => auth.poll(flowId), (error) => error.status === 410)
  assert.equal(http.calls.length, 1, '过期的流程不该再打 GitHub')
})

test('status / logout：登录态可查，logout 清空', async () => {
  const { auth, tokenStore, advance } = setup({
    script: [deviceCodeReply, { access_token: 'FAKE-TOKEN-B', scope: 'read:user' }],
  })
  assert.equal((await auth.status()).authenticated, false)

  const { flowId } = await auth.start()
  advance(5_000)
  await auth.poll(flowId)

  const after = await auth.status()
  assert.equal(after.authenticated, true)
  assert.equal(after.login, 'moyuqingman')
  assert.equal(after.configured, true)
  assert.equal(JSON.stringify(after).includes('FAKE-TOKEN-B'), false, 'status 泄漏了 token')

  await auth.logout()
  assert.equal(tokenStore.state.cleared, 1)
  assert.equal((await auth.status()).authenticated, false)
})

test('POLL_ERRORS 表：终止与非终止分得清', () => {
  assert.equal(POLL_ERRORS.authorization_pending.terminal, false)
  assert.equal(POLL_ERRORS.slow_down.terminal, false)
  assert.equal(POLL_ERRORS.slow_down.slowDown, true)
  for (const key of ['expired_token', 'access_denied', 'incorrect_client_credentials', 'device_flow_disabled']) {
    assert.equal(POLL_ERRORS[key].terminal, true, key)
  }
  assert.equal(DEFAULT_SCOPE, 'read:user public_repo')
})
