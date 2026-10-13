/**
 * GitHub OAuth Device Flow（POC-1）
 *
 * 契约来自官方文档 content/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps.md
 * 此处是逐字核对过的部分，不要凭印象改：
 *
 *   POST https://github.com/login/device/code
 *     client_id  必填
 *     scope      空格分隔
 *     → device_code / user_code / verification_uri / expires_in(900) / interval(5)
 *
 *   POST https://github.com/login/oauth/access_token
 *     client_id / device_code / grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     ⚠️ 不需要 client_secret —— 这是 device flow 相对 web flow 的关键差异
 *
 *   错误码：authorization_pending / slow_down / expired_token / unsupported_grant_type
 *           incorrect_client_credentials / incorrect_device_code / access_denied
 *           device_flow_disabled  ← 必须先在 OAuth App 设置里勾 Enable Device Flow
 *
 *   slow_down 会让 interval +5 秒，且【错误响应里会带上新的 interval】，应当采信它。
 *
 *   验证码提交限流：50 次/小时/应用。
 */

import { DEVICE_GRANT_TYPE, oauth, sleep } from './gh.mjs';

/** 把官方错误码翻译成能直接照着做的中文提示 */
const ERROR_HINTS = {
  authorization_pending: null, // 正常中间态，继续轮询
  slow_down: null, // 正常中间态，放宽间隔
  expired_token: '设备码已过期（默认 15 分钟）。重新运行一次即可。',
  token_expired: '设备码已过期（默认 15 分钟）。重新运行一次即可。',
  access_denied: '你在授权页面点了取消。该验证码已作废，重新运行一次。',
  unsupported_grant_type:
    `grant_type 必须是 ${DEVICE_GRANT_TYPE}。如果你看到这条，说明脚本被改坏了。`,
  incorrect_client_credentials:
    'client_id 不对。注意 device flow 不需要 client_secret —— 如果这里报错，多半是 client_id 填成了 client_secret。',
  incorrect_device_code: 'device_code 无效。通常是中间手动干扰了轮询，重新运行一次。',
  device_flow_disabled:
    '该 OAuth App 没有启用 Device Flow。' +
    '去 https://github.com/settings/developers → 选中这个 App → 勾选「Enable Device Flow」→ 保存。',
};

export async function requestDeviceCode(clientId, scope) {
  const r = await oauth('/login/device/code', { client_id: clientId, scope });
  if (!r.ok || !r.data?.device_code) {
    const err = r.data?.error;
    const hint = err && ERROR_HINTS[err] ? ERROR_HINTS[err] : `返回 ${r.status}：${r.text}`;
    throw new Error(`申请 device code 失败。${hint}`);
  }
  return {
    deviceCode: r.data.device_code,
    userCode: r.data.user_code,
    verificationUri: r.data.verification_uri,
    expiresIn: r.data.expires_in ?? 900,
    interval: r.data.interval ?? 5,
  };
}

/**
 * 轮询直到拿到 token 或超时/被拒。
 * onPrompt 会在第一次需要用户操作时被调用一次（用于打印提示）。
 */
export async function pollForToken(clientId, dc, { onPrompt, onTick } = {}) {
  onPrompt?.(dc);

  let wait = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  let attempt = 0;
  const trace = [];

  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    attempt += 1;

    const r = await oauth('/login/oauth/access_token', {
      client_id: clientId,
      device_code: dc.deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    });

    if (r.data?.access_token) {
      trace.push({ attempt, result: 'success', waitedSeconds: wait });
      return {
        accessToken: r.data.access_token,
        scope: r.data.scope ?? '',
        tokenType: r.data.token_type ?? 'bearer',
        refreshToken: r.data.refresh_token ?? null,
        expiresIn: r.data.expires_in ?? null,
        attempts: attempt,
        intervalTrace: trace,
      };
    }

    const err = r.data?.error ?? `http_${r.status}`;
    trace.push({ attempt, result: err, waitedSeconds: wait, newInterval: r.data?.interval ?? null });

    if (err === 'authorization_pending') {
      onTick?.({ attempt, err });
      continue;
    }

    if (err === 'slow_down') {
      // 官方：slow_down 会把 interval +5，且响应里会带新的 interval —— 优先采信响应
      const fromServer = Number(r.data?.interval);
      wait = Number.isFinite(fromServer) && fromServer > 0 ? fromServer : wait + 5;
      onTick?.({ attempt, err, newInterval: wait });
      continue;
    }

    const hint = ERROR_HINTS[err] ?? `未预期的错误码 ${err}（HTTP ${r.status}）：${r.text}`;
    throw Object.assign(new Error(hint), { errorCode: err, trace });
  }

  throw Object.assign(new Error('轮询超时：设备码窗口已过，请重新运行。'), {
    errorCode: 'timeout',
    trace,
  });
}

/** 一次完整的登录流程 */
export async function login(clientId, scope, hooks) {
  const dc = await requestDeviceCode(clientId, scope);
  return pollForToken(clientId, dc, hooks);
}
