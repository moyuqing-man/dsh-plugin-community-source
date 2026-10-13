/**
 * 统一错误信封。
 *
 * 形状直接沿用 `dsh-workspace` 的实现：
 *   { status, reason, message, fields, requestId }
 * 这样一个用户同时用 DSH 自带路由和社区路由时，错误体感是一致的。
 */

export const Reason = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CONFLICT: 'CONFLICT',
  EXPIRED: 'EXPIRED',
  INTERNAL: 'INTERNAL',
}

export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} reason Reason 里的取值
   * @param {string} message 给用户看的中文说明
   * @param {Array<{name: string, value: unknown}>} fields 结构化补充信息
   * @param {Record<string, unknown>} [details] 不进信封的附加数据（如 retryAfterMs）
   */
  constructor(status, reason, message, fields = [], details = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason
    this.fields = fields
    this.details = details
  }
}

const field = (name, value) => ({ name, value })

export const badRequest = (message, fields = []) => new ApiError(400, Reason.BAD_REQUEST, message, fields)
export const notFound = (message, fields = []) => new ApiError(404, Reason.NOT_FOUND, message, fields)
export const forbidden = (message, fields = []) => new ApiError(403, Reason.FORBIDDEN, message, fields)
export const methodNotAllowed = (allow = 'GET') =>
  new ApiError(405, Reason.METHOD_NOT_ALLOWED, `仅支持 ${allow} 请求`, [field('allow', allow)])
export const unauthorized = (message = '这个操作需要先登录 GitHub') =>
  new ApiError(401, Reason.UNAUTHORIZED, message)
export const notConfigured = (message, fields = []) =>
  new ApiError(503, Reason.NOT_CONFIGURED, message, fields)
export const upstreamFailed = (message, details = {}) =>
  new ApiError(502, Reason.UPSTREAM_FAILED, message, [], details)
export const upstreamTimeout = (message, details = {}) =>
  new ApiError(504, Reason.UPSTREAM_TIMEOUT, message, [], details)
export const rateLimited = (message, retryAfterMs = 0) =>
  new ApiError(429, Reason.RATE_LIMITED, message, [field('retryAfterMs', retryAfterMs)], { retryAfterMs })
/** 同一内容短时间重复提交。**绝不能转发给 GitHub** —— 见 docs/04 §3.5。 */
export const conflict = (message, fields = []) => new ApiError(409, Reason.CONFLICT, message, fields)
/** 设备码过期（410 而非 404：资源确实存在过，只是没了）。 */
export const expired = (message, fields = []) => new ApiError(410, Reason.EXPIRED, message, fields)

/** 把任意抛出物转成信封。非 ApiError 一律按 500 处理，且不泄漏堆栈。 */
export function envelopeOf(error, requestId) {
  if (error instanceof ApiError) return envelope(error.status, error.reason, error.message, error.fields, requestId)
  const message = error instanceof Error ? error.message : String(error)
  return envelope(500, Reason.INTERNAL, message || '内部错误', [], requestId)
}

export function envelope(status, reason, message, fields = [], requestId) {
  const body = { status, reason, message, fields }
  if (requestId) body.requestId = requestId
  return body
}
