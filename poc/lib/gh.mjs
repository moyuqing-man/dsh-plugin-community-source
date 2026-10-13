/**
 * GitHub API 访问层（零依赖，Node 18+，纯 ESM）
 *
 * 设计依据来自 POC-0 / POC-6 的实测结论（见 docs/08-GitHub-API-契约.md）：
 *   1. Unauthenticated REST core = 60/hr 且【按来源 IP】计费 → 必须缓存 + 门控
 *   2. GET /rate_limit 自身【不消耗配额】(delta=0) → 这是唯一的免费预算探针
 *   3. 304 条件请求【照样计入配额】(delta=1) → ETag 只省带宽，不省配额
 *
 * 安全约定：本文件所有函数都不会把 token 写进返回值或日志。
 */

export const API = 'https://api.github.com';
export const OAUTH_HOST = 'https://github.com';
export const UA = 'dsh-community-poc/0.1';
export const API_VERSION = '2022-11-28';

/** Device flow 官方契约里的 grant_type，写错会得到 unsupported_grant_type */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export class GhError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'GhError';
    this.status = info.status ?? null;
    this.body = info.body ?? null;
    this.url = info.url ?? null;
  }
}

/** 把 Headers 拍平成小写 key 的普通对象，方便断言 */
export function headersToObject(res) {
  const out = {};
  for (const [k, v] of res.headers) out[k.toLowerCase()] = v;
  return out;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 从响应头提取限流状态。这是「预算调速器」的数据来源。 */
export function rateInfo(headers) {
  return {
    limit: toNum(headers['x-ratelimit-limit']),
    remaining: toNum(headers['x-ratelimit-remaining']),
    used: toNum(headers['x-ratelimit-used']),
    reset: toNum(headers['x-ratelimit-reset']),
    resetLocal: headers['x-ratelimit-reset']
      ? new Date(Number(headers['x-ratelimit-reset']) * 1000).toLocaleString('zh-CN')
      : null,
    resource: headers['x-ratelimit-resource'] ?? null,
  };
}

async function parseBody(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { text, data };
}

/**
 * 打 api.github.com。永远不抛异常——把状态码交给调用方判断，
 * 因为本 POC 的核心就是「看看到底返回几零几」。
 */
export async function api(path, { method = 'GET', token, body, extraHeaders = {} } = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const headers = {
    'User-Agent': UA,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...extraHeaders,
  };
  // 注意：这里只在确实传了 token 时才加 Authorization，空串不加
  if (token) headers.Authorization = `Bearer ${token}`;

  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const h = headersToObject(res);
  const { text, data } = await parseBody(res);
  return {
    url,
    status: res.status,
    ok: res.ok,
    headers: h,
    data,
    text: text.slice(0, 4000),
    rate: rateInfo(h),
    scopes: h['x-oauth-scopes'] ?? null,
    acceptedScopes: h['x-accepted-oauth-scopes'] ?? null,
  };
}

/**
 * 打 GitHub 的 OAuth 端点（不是 api.github.com）。
 * 这两个端点要 form-urlencoded，并且必须带 Accept: application/json 才返回 JSON。
 */
export async function oauth(path, params) {
  const url = OAUTH_HOST + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const { text, data } = await parseBody(res);
  return { url, status: res.status, ok: res.ok, data, text: text.slice(0, 2000) };
}

/** GraphQL。未认证时配额为 0（实测），必须带 token。 */
export async function graphql(query, variables, token) {
  const r = await api('/graphql', { method: 'POST', token, body: { query, variables: variables ?? {} } });
  // GraphQL 即使业务失败也常返回 200，错误在 body.errors 里
  const gqlErrors = r.data?.errors ?? null;
  return { ...r, gqlErrors, gqlData: r.data?.data ?? null };
}

/**
 * 免费预算探针。实测该端点自身不消耗配额，所以可以随时调用。
 * 这是调速器唯一允许依赖的额度来源——不要靠「条件请求应该免费」来猜。
 */
export async function budget(token) {
  const r = await api('/rate_limit', { token });
  const res = r.data?.resources ?? {};
  return {
    raw: r,
    core: res.core ?? null,
    search: res.search ?? null,
    graphql: res.graphql ?? null,
    integrationManifest: res.integration_manifest ?? null,
  };
}

/**
 * 配额门控：在跑一批请求之前调用。
 * 返回 { allowed, reason, core }。
 * 这里是「调速器」的最小可用版本——真插件里还要加上按优先级的降级。
 */
export async function ensureBudget(token, need = 5, floor = 3) {
  const b = await budget(token);
  const remaining = b.core?.remaining ?? 0;
  const allowed = remaining - need >= floor;
  return {
    allowed,
    remaining,
    need,
    floor,
    reason: allowed
      ? `core 剩余 ${remaining}，够跑 ${need} 次（保留底线 ${floor}）`
      : `core 仅剩 ${remaining}，本轮需要 ${need} 次且需保留 ${floor} 次底线 → 拒绝并降级为纯缓存`,
    resetLocal: b.raw.rate?.resetLocal ?? null,
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
