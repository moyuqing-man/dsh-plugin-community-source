/**
 * 本地状态：配置、token、证据落盘。
 *
 * 约定：
 *   poc/config.json    用户手填（gitignored，因为 repo 名等可能带个人信息）
 *   poc/.token.json    登录产物（gitignored，权限 0600）
 *   poc/results/*      每次运行的证据（gitignored —— 里面有真实接口返回值）
 *
 * token 永远不会被打进 results。writeResult 里做了兜底脱敏。
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(POC_DIR, 'config.json');
export const TOKEN_PATH = join(POC_DIR, '.token.json');
export const RESULTS_DIR = join(POC_DIR, 'results');

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, value, { secret = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  if (secret) {
    try {
      await chmod(path, 0o600);
    } catch {
      /* Windows 上 chmod 语义有限，忽略 */
    }
  }
}

export async function loadConfig() {
  const cfg = await readJson(CONFIG_PATH, null);
  if (!cfg) {
    throw new Error(
      `找不到 ${CONFIG_PATH}\n` +
        `请先复制 config.example.json 为 config.json 并填写 clientId。`,
    );
  }
  return {
    clientId: cfg.clientId ?? '',
    scope: cfg.scope ?? 'read:user public_repo',
    repo: cfg.repo ?? '',
    categoryName: cfg.categoryName ?? '',
  };
}

export async function loadToken() {
  const t = await readJson(TOKEN_PATH, null);
  return t?.accessToken ?? null;
}

export async function saveToken(payload) {
  await writeJson(TOKEN_PATH, { ...payload, savedAt: new Date().toISOString() }, { secret: true });
}

/** 脱敏：任何看起来像 token 的字符串都不允许进证据文件 */
function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\b(gh[opsu]_[A-Za-z0-9]{16,})\b/g, 'gh?_***REDACTED***')
      .replace(/\b([0-9a-f]{40})\b/g, (m) => (m === value ? JSON.stringify(m) : m)); // device_code 形态
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|device_code|deviceCode/i.test(k)) {
        out[k] = v ? '***REDACTED***' : v;
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * 落盘一次运行的证据。返回文件路径。
 * 证据 = 「我看到了什么」，后续写文档时直接引用它，不用再复现。
 */
export async function writeResult(command, payload) {
  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RESULTS_DIR, `${stamp}-${command}.json`);
  await writeJson(path, redact({ command, at: new Date().toISOString(), ...payload }));
  return path;
}

/** 极简 markdown 表格打印，避免引依赖 */
export function printTable(rows, headers) {
  const all = headers ? [headers, ...rows] : rows;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  const line = (row) => row.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  if (headers) {
    console.log('  ' + line(headers));
    console.log('  ' + widths.map((w) => '─'.repeat(w)).join('  '));
  }
  for (const row of rows) console.log('  ' + line(row));
}

export function banner(text) {
  const bar = '─'.repeat(Math.max(4, 64 - text.length));
  console.log(`\n${text} ${bar}`);
}

/** 统一的「判定」输出。POC 的价值就在于把判定写死，而不是让人读原始 JSON 猜。 */
export function verdict(pass, label, detail = '') {
  const mark = pass === true ? '✅ PASS' : pass === false ? '❌ FAIL' : '⚠️  UNKNOWN';
  console.log(`  ${mark}  ${label}${detail ? `\n           ${detail}` : ''}`);
  return pass;
}
