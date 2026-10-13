#!/usr/bin/env node
/**
 * DSH 插件社区 · POC 验证器
 *
 * 用途：把 docs/08-GitHub-API-契约.md 里的每一条结论变成可复现的证据。
 * 不给插件骨架、不碰 DSH 运行时 —— 只回答「GitHub 到底能不能这么用」。
 *
 * 用法：
 *   node run.mjs probe                    # 匿名只读探测（POC-0，不吃 token）
 *   node run.mjs probe --etag             # 附带 POC-6 的 ETag 配额实测
 *   node run.mjs login                    # POC-1 Device Flow 登录并落 token
 *   node run.mjs status                   # 当前身份 + 配额面板
 *   node run.mjs poc2                     # 写接口到底走 REST 还是 GraphQL
 *   node run.mjs poc3                     # 只读预演 createDiscussion 全流程
 *   node run.mjs poc3 --yes               # 真的发帖 + 评论 + 回读
 *   node run.mjs poc4                     # scope 实测核验
 *   node run.mjs all                      # probe → login → status → poc2 → poc4
 *
 * 证据会落到 poc/results/，token 不会进证据文件。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { api, budget, ensureBudget, graphql, sleep } from './lib/gh.mjs';
import { login } from './lib/deviceflow.mjs';
import {
  CONFIG_PATH,
  POC_DIR,
  banner,
  loadConfig,
  loadToken,
  printTable,
  saveToken,
  verdict,
  writeResult,
} from './lib/store.mjs';

// 匿名探测默认拿一个有 Discussions 的公开仓库当靶子
const DEFAULT_PROBE_REPO = 'giscus/giscus';
const NPM_SAMPLE_PACKAGE = 'dsh-find-plugins';

// ────────────────────────────────────────────── 参数

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v === undefined ? true : v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'help';

class Skip extends Error {}

async function needToken() {
  const t = await loadToken();
  if (!t) throw new Error(`没有 token。先跑：node run.mjs login`);
  return t;
}

async function needRepo(required = true) {
  const cfg = await loadConfig();
  const repo = args.repo ?? cfg.repo;
  if (!repo && required) {
    throw new Error(
      `config.json 里没填 repo。请填成 "owner/name"（例如 "your-name/dsh-plugin-community"）。`,
    );
  }
  return { repo, cfg };
}

function splitRepo(repo) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error(`repo 格式应为 owner/name，收到 "${repo}"`);
  return { owner, name };
}

// ────────────────────────────────────────────── POC-0 / 匿名只读探测

async function cmdProbe() {
  const repo = args.repo ?? DEFAULT_PROBE_REPO;
  const { owner, name } = splitRepo(repo);
  banner(`POC-0 · 匿名（未认证）只读探测  →  ${repo}`);

  const b = await budget(null);
  console.log('\n  免费预算探针 GET /rate_limit（实测该端点自身不消耗配额）：');
  printTable(
    [
      ['core', b.core?.limit ?? '—', b.core?.remaining ?? '—'],
      ['search', b.search?.limit ?? '—', b.search?.remaining ?? '—'],
      ['graphql', b.graphql?.limit ?? '—', b.graphql?.remaining ?? '—'],
    ],
    ['资源', 'limit', 'remaining'],
  );
  console.log(`  重置时间：${b.raw.rate?.resetLocal ?? '—'}`);
  console.log('  ⚠️  graphql limit = 0 意味着未认证时【完全无法】读 Discussions 的 GraphQL 路径');

  const checks = [
    ['GET /repos/{r}', `/repos/${repo}`, true],
    ['GET /repos/{r}/releases', `/repos/${repo}/releases?per_page=1`, true],
    ['GET /repos/{r}/contributors', `/repos/${repo}/contributors?per_page=1`, true],
    ['GET /repos/{r}/readme', `/repos/${repo}/readme`, true],
    ['POC-0 GET discussions', `/repos/${repo}/discussions?per_page=2`, true],
    ['GET discussions/categories', `/repos/${repo}/discussions/categories`, false],
    ['GET dependents', `/repos/${repo}/dependents`, false],
    ['GET ISSUE_TEMPLATE', `/repos/${repo}/contents/.github/ISSUE_TEMPLATE`, null],
    ['GET /search/repositories', `/search/repositories?q=dsh-plugin&per_page=1`, true],
  ];

  const evidence = { repo, rateLimitPanel: b, checks: [] };
  let firstDiscussionNumber = null;

  for (const [label, path, expectOk] of checks) {
    const r = await api(path, {});
    let note = '';
    if (path.includes('/discussions?') && r.ok && Array.isArray(r.data)) {
      firstDiscussionNumber = r.data[0]?.number ?? null;
      note = `拿到 ${r.data.length} 条，字段：${
        r.data[0] ? Object.keys(r.data[0]).slice(0, 8).join(',') + '…' : '（空）'
      }`;
    }
    if (path.includes('/discussions/categories')) note = '预期 404 —— 该端点不存在，分类只能走 GraphQL';
    if (path.includes('/dependents')) note = '预期 404 —— dependents 无公开 API';
    if (path.includes('ISSUE_TEMPLATE')) note = '404/403 都正常，取决于模板是否存在';

    evidence.checks.push({ label, path, status: r.status, ok: r.ok, note, rate: r.rate, sample: r.data });

    // expectOk: true=必须 2xx / false=必须非 2xx / null=存在与否都正常
    let mark;
    if (expectOk === false) mark = r.ok ? '⚠️' : '✅';
    else if (expectOk === null) mark = 'ℹ️';
    else mark = r.ok ? '✅' : '⚠️';

    const suffix =
      expectOk === false
        ? '   (预期非 2xx)'
        : expectOk === null
          ? '   (存在与否都正常)'
          : r.ok
            ? ''
            : `  ${r.text.slice(0, 120)}`;

    console.log(`  ${mark} ${label.padEnd(32)} HTTP ${r.status}${suffix}`);
    if (note) console.log(`     ${note}`);

    await sleep(150);
  }

  // 讨论正文 + 评论：证明「匿名读完整个帖子」是可行的
  if (firstDiscussionNumber) {
    console.log('');
    for (const [label, path] of [
      ['POC-0 GET 单帖正文', `/repos/${repo}/discussions/${firstDiscussionNumber}`],
      ['POC-0 GET 帖内评论', `/repos/${repo}/discussions/${firstDiscussionNumber}/comments?per_page=3`],
    ]) {
      const r = await api(path, {});
      const hasBody = Boolean(r.data?.body);
      console.log(`  ${r.ok ? '✅' : '⚠️'} ${label.padEnd(32)} HTTP ${r.status}${hasBody ? '  含 body 字段' : ''}`);
      evidence.checks.push({ label, path, status: r.status, ok: r.ok, hasBody });
      await sleep(150);
    }
  }

  // POC-2（免 token 版）：REST 到底有没有 discussions 写接口？
  // 判据：未认证时「端点存在但需要鉴权」返回 401，「端点不存在」返回 404。
  // 用一对已知端点做对照组夹逼，就不需要任何 token 也能定论。
  banner('POC-2 · REST 是否有 discussions 写接口（免 token 对照实验）');
  const postProbes = [
    ['对照A 存在的可写端点', `/repos/${repo}/issues`],
    ['待判定 discussions', `/repos/${repo}/discussions`],
    ['待判定 discussions/comments', `/repos/${repo}/discussions/1/comments`],
    ['对照B 不存在的端点', `/repos/${repo}/nonexistent-xyz-123`],
  ];
  const postResults = [];
  for (const [label, path] of postProbes) {
    const r = await api(path, { method: 'POST', body: {} });
    const msg = r.data?.message ?? r.text.slice(0, 60);
    postResults.push({ label, path, method: 'POST', status: r.status, message: msg, rate: r.rate });
    console.log(`  • ${label.padEnd(32)} HTTP ${r.status}   ${msg}`);
    await sleep(200);
  }
  const ctrlExists = postResults[0];
  const targetMain = postResults[1];
  const targetCmt = postResults[2];
  const ctrlMissing = postResults[3];
  const poc2Holds =
    ctrlExists.status === 401 && targetMain.status === 404 && targetCmt.status === 404;
  console.log('');
  verdict(
    poc2Holds,
    'REST 不提供 discussions 写接口 → 建帖/评论只能走 GraphQL mutation',
    `对照实验未复现：对照A=${ctrlExists.status}(期望401) discussions=${targetMain.status}(期望404) comments=${targetCmt.status}(期望404) 对照B=${ctrlMissing.status}`,
  );
  evidence.poc2Anonymous = {
    probes: postResults,
    verdict: poc2Holds ? 'REST has no discussions write route; writes are GraphQL-only' : 'inconclusive',
  };

  // npm 下载量：不吃 GitHub 配额
  console.log('');
  const npm = await fetch(
    `https://api.npmjs.org/downloads/point/last-week/${NPM_SAMPLE_PACKAGE}`,
  ).then((r) => r.json());
  console.log(
    `  ✅ npm 周下载量（不经过 api.github.com，不吃 GH 配额）  ${NPM_SAMPLE_PACKAGE} = ${npm.downloads ?? '—'}`,
  );
  evidence.npm = npm;

  // POC-6：ETag 是否计入配额
  if (args.etag) {
    banner('POC-6 · 304 条件请求是否计入配额');
    const url = `/repos/${repo}/discussions?per_page=1`;
    const reps = [];
    for (let i = 1; i <= 3; i++) {
      const a = await api(url, {});
      await sleep(1200);
      const bres = await api(url, { extraHeaders: { 'If-None-Match': a.headers.etag ?? '' } });
      const delta = (a.rate.remaining ?? 0) - (bres.rate.remaining ?? 0);
      reps.push({ rep: i, first: a.status, rem1: a.rate.remaining, second: bres.status, rem2: bres.rate.remaining, delta });
      console.log(
        `  rep${i}  200:rem=${a.rate.remaining}  ${bres.status}:rem=${bres.rate.remaining}  delta=${delta}`,
      );
      await sleep(600);
    }
    const allCounted = reps.every((r) => r.delta === 1);
    const any304 = reps.some((r) => r.second === 304);
    console.log('');
    verdict(any304 && allCounted, '304 条件请求照样计入配额', '3/3 复现 → 条件请求只省带宽，不省配额');
    evidence.etag = reps;
  } else {
    console.log(`\n  (跳过 POC-6 —— 加 --etag 复现「304 是否吃配额」)  `);
  }

  const file = await writeResult('probe', evidence);
  console.log(`\n  证据已落盘：${rel(file)}`);
}

function rel(p) {
  return p.startsWith(POC_DIR) ? p.slice(POC_DIR.length + 1).replace(/\\/g, '/') : p;
}

// ────────────────────────────────────────────── POC-1 Device Flow

async function cmdLogin() {
  const cfg = await loadConfig();
  const looksPlaceholder = !cfg.clientId || /在此填|your[-_ ]?name|placeholder|xxx/i.test(cfg.clientId);
  if (looksPlaceholder) {
    throw new Error(
      `config.json 的 clientId 还是占位符（当前值：${JSON.stringify(cfg.clientId)}）。\n` +
        `\n  方案 A（更省事，推荐先做）—— 不建 OAuth App，直接贴一个 Personal Access Token：\n` +
        `      node run.mjs token <你的 PAT>\n` +
        `      到 https://github.com/settings/tokens 建 classic token，勾 read:user + public_repo。\n` +
        `\n  方案 B（要验证 Device Flow 本身）—— 到 https://github.com/settings/developers → New OAuth App，\n` +
        `      把 Client ID 填进 config.json，并【务必勾选 Enable Device Flow】，否则会拿到 device_flow_disabled。`,
    );
  }

  banner('POC-1 · GitHub OAuth Device Flow');
  console.log(`  client_id : ${cfg.clientId.slice(0, 8)}…（已隐藏）`);
  console.log(`  scope     : ${cfg.scope}`);
  console.log(`  ⚠️  不要勾 offline_access —— 那会让 token 8 小时过期并需要 refresh 流程。`);

  const started = Date.now();
  const result = await login(cfg.clientId, cfg.scope, {
    onPrompt: (dc) => {
      console.log(`\n  ┌─ 请在浏览器完成授权 ───────────────────────`);
      console.log(`  │  1. 打开 ${dc.verificationUri}`);
      console.log(`  │  2. 输入一次性代码：  ${dc.userCode}`);
      console.log(`  └────────────────────────────────────────────`);
      console.log(`  有效期 ${dc.expiresIn}s，轮询间隔 ${dc.interval}s。等待中…`);
    },
    onTick: (t) => {
      if (t.err === 'slow_down') console.log(`  · 第 ${t.attempt} 次：slow_down → 间隔放宽到 ${t.newInterval}s`);
      else if (t.attempt % 4 === 0) console.log(`  · 已轮询 ${t.attempt} 次，仍在等待授权…`);
    },
  });

  await saveToken({
    accessToken: result.accessToken,
    scope: result.scope,
    tokenType: result.tokenType,
    refreshToken: result.refreshToken,
  });

  console.log(`\n  ✅ 拿到 access_token（已存到 poc/.token.json，不会进证据文件）`);
  console.log(`     用时 ${((Date.now() - started) / 1000).toFixed(1)}s，轮询 ${result.attempts} 次`);
  console.log(`     实际授予的 scope：${result.scope || '（空）'}`);

  const file = await writeResult('login', {
    attempts: result.attempts,
    elapsedMs: Date.now() - started,
    grantedScope: result.scope,
    intervalTrace: result.intervalTrace,
    hasRefreshToken: Boolean(result.refreshToken),
  });
  console.log(`  证据已落盘：${rel(file)}`);

  await cmdStatus();
}

// ────────────────────────────────────────────── status

/**
 * 用 Personal Access Token 直接登录，跳过 Device Flow。
 * 目的：POC-3 / POC-4 验证的是「API 能不能这么用」，与「怎么拿到 token」无关。
 * 所以不该为了让 API 验证跑起来，先去建一个 OAuth App。
 * ⚠️ 真插件当然要走 Device Flow —— 这条命令只是验证期的捷径。
 */
async function cmdToken() {
  // 注意：args._[0] 就是命令名 'token' 本身，PAT 在 args._[1]
  const raw = typeof args._[1] === 'string' ? args._[1].trim() : '';
  if (!raw) {
    throw new Error(
      '用法：node run.mjs token <你的 Personal Access Token>\n' +
        '  到 https://github.com/settings/tokens → Generate new token (classic)\n' +
        '  勾选 read:user 和 public_repo，生成后复制（形如 ghp_… 或 github_pat_…）。\n' +
        '  它只用于本地验证，脚本会存到 poc/.token.json（已在 .gitignore 里）。',
    );
  }

  banner('保存本地 token（绕过 Device Flow，仅用于验证 API）');
  const r = await api('/user', { token: raw });
  if (!r.ok) {
    throw new Error(
      `token 校验失败：HTTP ${r.status} ${r.data?.message ?? r.text.slice(0, 120)}\n` +
        '  确认：① token 没过期 ② 没被撤销 ③ 至少勾了 read:user。',
    );
  }

  await saveToken({
    accessToken: raw,
    kind: 'pat',
    login: r.data?.login ?? null,
    scopes: r.scopes,
  });

  console.log(`  ✅ 已保存到 poc/.token.json（权限 0600；不会被打进 results）`);
  console.log(`  login  : ${r.data?.login}`);
  console.log(`  scopes : ${r.scopes ?? '(未返回 —— 细粒度 token 不返回此头)'}`);
  console.log(`  额度   : ${r.rate.remaining}/${r.rate.limit}（重置 ${r.rate.resetLocal}）`);
  console.log('');
  console.log('  接下来：');
  console.log('    node run.mjs status      # 身份 + 配额 + 门控');
  console.log('    node run.mjs poc3        # 默认只预演，确认无误再加 --yes');
  console.log('    node run.mjs poc4        # scope 实测');
}

async function cmdStatus() {
  const token = await needToken();
  banner('身份 + 配额');
  const me = await api('/user', { token });
  if (!me.ok) {
    console.log(`  ❌ GET /user 返回 ${me.status}：${me.text.slice(0, 200)}`);
    console.log(`     token 可能已失效，重新跑 node run.mjs login`);
    return;
  }
  console.log(`  登录身份：${me.data.login}  (id ${me.data.id})`);
  console.log(`  响应头 x-oauth-scopes    : ${me.scopes ?? '（无）'}`);
  console.log(`  响应头 x-accepted-oauth-scopes: ${me.acceptedScopes ?? '（无）'}`);

  const b = await budget(token);
  console.log('');
  printTable(
    [
      ['core', b.core?.limit ?? '—', b.core?.remaining ?? '—'],
      ['search', b.search?.limit ?? '—', b.search?.remaining ?? '—'],
      ['graphql', b.graphql?.limit ?? '—', b.graphql?.remaining ?? '—'],
    ],
    ['资源', 'limit', 'remaining'],
  );
  console.log(`  重置：${b.raw.rate?.resetLocal ?? '—'}`);

  const gate = await ensureBudget(token, 5, 3);
  console.log(`\n  配额门控：${gate.allowed ? '✅ 放行' : '⛔ 拦截'} —— ${gate.reason}`);
  await writeResult('status', { login: me.data.login, scopes: me.scopes, budget: b });
}

// ────────────────────────────────────────────── POC-2 REST vs GraphQL

async function cmdPoc2() {
  const token = await needToken();
  const { repo } = await needRepo();
  const { owner, name } = splitRepo(repo);
  banner('POC-2 · 写接口到底是 REST 还是 GraphQL');

  const gate = await ensureBudget(token, 4);
  console.log(`  配额门控：${gate.allowed ? '✅ 放行' : '⛔ 拦截'} —— ${gate.reason}\n`);

  // (a) REST 读
  const read = await api(`/repos/${repo}/discussions?per_page=1`, { token });
  console.log(`  (a) 带 token REST 读讨论      HTTP ${read.status}`);
  verdict(read.ok, 'REST 读路径可用', `remaining=${read.rate.remaining}`);

  await sleep(200);

  // (b) GraphQL 读
  const gql = await graphql('{ viewer { login } }', {}, token);
  console.log(`  (b) 带 token GraphQL          HTTP ${gql.status}  errors=${gql.gqlErrors ? gql.gqlErrors.length : 0}`);
  verdict(gql.status === 200 && !gql.gqlErrors, 'GraphQL 认证后可用', JSON.stringify(gql.gqlData ?? gql.text.slice(0, 120)));

  await sleep(200);

  // (c) REST 写：核心问题
  const write = await api(`/repos/${repo}/discussions`, {
    method: 'POST',
    token,
    body: { title: 'POC-2 REST write probe', body: 'if you can read this, REST write exists' },
  });
  console.log(`  (c) REST POST 建讨论          HTTP ${write.status}`);
  const restWriteExists = write.status !== 404;
  verdict(
    restWriteExists === false,
    '结论：REST 没有建讨论的接口 → 写必须走 GraphQL',
    `HTTP ${write.status} ${write.status === 404 ? '(404 = 端点不存在，与预期一致)' : `← 意外！${write.text.slice(0, 200)}`}`,
  );

  await sleep(200);

  // (d) GraphQL 里有没有 createDiscussion
  const introspect = await graphql(
    `{ __schema { mutationType { fields { name } } } }`,
    {},
    token,
  );
  const mutations = introspect.gqlData?.__schema?.mutationType?.fields?.map((f) => f.name) ?? [];
  const hasCreate = mutations.includes('createDiscussion');
  const hasComment = mutations.includes('addDiscussionComment');
  console.log(`  (d) GraphQL mutation 总数     ${mutations.length}`);
  verdict(hasCreate, 'createDiscussion 存在于 GraphQL mutation');
  verdict(hasComment, 'addDiscussionComment 存在于 GraphQL mutation');

  const file = await writeResult('poc2', {
    repo,
    restRead: { status: read.status, ok: read.ok },
    graphqlRead: { status: gql.status, errors: gql.gqlErrors },
    restWrite: { status: write.status, body: write.data ?? write.text.slice(0, 500) },
    restWriteExists,
    mutations,
  });
  console.log(`\n  证据已落盘：${rel(file)}`);

  if (restWriteExists) {
    console.log(`\n  ⚠️  REST 写居然存在！docs/08 的结论需要修正 —— 请人工核查。`);
  }
}

// ────────────────────────────────────────────── POC-3 createDiscussion 全流程

async function cmdPoc3() {
  const token = await needToken();
  const { repo, cfg } = await needRepo();
  const { owner, name } = splitRepo(repo);
  const doIt = Boolean(args.yes);

  banner(`POC-3 · createDiscussion 全流程  →  ${repo}${doIt ? '' : '  (预演，未发帖)'}`);

  const gate = await ensureBudget(token, 6);
  console.log(`  配额门控：${gate.allowed ? '✅ 放行' : '⛔ 拦截'} —— ${gate.reason}\n`);

  // 1) 仓库 id + 讨论分类
  const q = `query($owner:String!,$name:String!){
    repository(owner:$owner,name:$name){
      id
      nameWithOwner
      hasDiscussionsEnabled
      discussionCategories(first:25){ nodes{ id name } }
    }
  }`;
  const r1 = await graphql(q, { owner, name }, token);
  if (r1.gqlErrors) {
    console.log(`  ❌ GraphQL 取仓库失败：${JSON.stringify(r1.gqlErrors)}`);
    return;
  }
  const repository = r1.gqlData.repository;
  console.log(`  仓库：${repository.nameWithOwner}`);
  console.log(`  hasDiscussionsEnabled = ${repository.hasDiscussionsEnabled}`);
  const cats = repository.discussionCategories.nodes;
  console.log(`  讨论分类 ${cats.length} 个：`);
  for (const c of cats) console.log(`    · ${c.name}   ${c.id}`);

  if (!repository.hasDiscussionsEnabled) {
    console.log(`\n  ⛔ 该仓库未开启 Discussions。`);
    console.log(`     去仓库 Settings → General → Features 勾选 Discussions，再重跑。`);
    await writeResult('poc3', { repo, aborted: 'discussions_disabled' });
    return;
  }

  const wantName = args.category ?? cfg.categoryName;
  const category =
    (wantName && cats.find((c) => c.name.toLowerCase() === String(wantName).toLowerCase())) ||
    cats.find((c) => /general|公告|general/i.test(c.name)) ||
    cats[0];
  if (!category) {
    console.log(`\n  ⛔ 该仓库没有任何讨论分类，无法建帖。`);
    return;
  }
  console.log(`\n  选用分类：${category.name}`);

  const title = args.title ?? `[POC] 创建链路验证 ${new Date().toISOString().slice(0, 16)}`;
  const body =
    args.body ??
    '这是一条自动化 POC 验证帖，用于确认 `createDiscussion` + `addDiscussionComment` 在真实 token 下可用。\n\n可以忽略或删除。';

  if (!doIt) {
    console.log(`\n  将要发送的 mutation：`);
    console.log(`    createDiscussion({ repositoryId, categoryId, title: ${JSON.stringify(title)} })`);
    console.log(`\n  加 --yes 才会真的发帖。`);
    await writeResult('poc3', { repo, dryRun: true, repositoryId: repository.id, categoryId: category.id, title, categories: cats });
    return;
  }

  // 2) 建讨论
  const m1 = `mutation($input:CreateDiscussionInput!){
    createDiscussion(input:$input){ discussion{ id number url title } }
  }`;
  const r2 = await graphql(
    m1,
    { input: { repositoryId: repository.id, categoryId: category.id, title, body } },
    token,
  );
  if (r2.gqlErrors) {
    console.log(`\n  ❌ createDiscussion 失败：${JSON.stringify(r2.gqlErrors)}`);
    await writeResult('poc3', { repo, failed: 'createDiscussion', errors: r2.gqlErrors });
    return;
  }
  const d = r2.gqlData.createDiscussion.discussion;
  console.log(`  ✅ 建帖成功 #${d.number} ${d.url}`);

  await sleep(300);

  // 3) 评论
  const m2 = `mutation($input:AddDiscussionCommentInput!){
    addDiscussionComment(input:$input){ comment{ id url } }
  }`;
  const r3 = await graphql(
    m2,
    { input: { discussionId: d.id, body: 'POC-3 自动评论：确认评论写入链路可用。' } },
    token,
  );
  const comment = r3.gqlData?.addDiscussionComment?.comment;
  if (r3.gqlErrors) console.log(`  ❌ 评论失败：${JSON.stringify(r3.gqlErrors)}`);
  else console.log(`  ✅ 评论成功 ${comment?.url ?? ''}`);

  await sleep(300);

  // 4) 回读：证明「GraphQL 写 → REST 读」这条跨协议链路成立（这是架构的关键假设）
  const rb = await api(`/repos/${repo}/discussions/${d.number}`, { token });
  const cr = await api(`/repos/${repo}/discussions/${d.number}/comments`, { token });
  console.log(`\n  回读（架构关键假设：GraphQL 写进去的东西 REST 能立刻读到）`);
  verdict(rb.ok, `REST 读到刚建的帖 #${d.number}`, `HTTP ${rb.status}`);
  verdict(Array.isArray(cr.data) && cr.data.length > 0, `REST 读到 ${cr.data?.length ?? 0} 条评论`);

  const file = await writeResult('poc3', {
    repo,
    repositoryId: repository.id,
    category: category.name,
    categoryId: category.id,
    discussion: d,
    comment,
    readback: { discussion: rb.status, comments: cr.status, commentCount: cr.data?.length ?? null },
  });
  console.log(`\n  证据已落盘：${rel(file)}`);
}

// ────────────────────────────────────────────── POC-4 scope

async function cmdPoc4() {
  const token = await needToken();
  const { repo } = await needRepo(false);
  banner('POC-4 · scope 交叉验证（官方文档已定论 → 公开仓库用 public_repo）');

  const me = await api('/user', { token });
  if (!me.ok) {
    console.log(`  ❌ GET /user ${me.status}：${me.text.slice(0, 200)}`);
    return;
  }

  const granted = String(me.scopes ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`  实际授予 scope：${granted.length ? granted.join(', ') : '（空）'}`);
  console.log('');

  verdict(granted.includes('read:user'), 'read:user 在列', '读取用户身份所需');
  verdict(granted.includes('public_repo'), 'public_repo 在列', '写公开仓库的 Discussion 所需');
  verdict(
    !granted.some((s) => /discussion/i.test(s)),
    '未出现 read:discussion / write:discussion',
    '这两个名字不是 OAuth scope —— 出现才奇怪',
  );

  // 真正有说服力的不是看 scope 列表，而是「能不能写」
  if (repo) {
    const { owner, name } = splitRepo(repo);
    console.log(`\n  决定性验证：用这套 scope 去实际写一次（只读预演，不发帖）`);
    const can = await graphql(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id hasDiscussionsEnabled}}`,
      { owner, name },
      token,
    );
    const repoId = can.gqlData?.repository?.id;
    verdict(Boolean(repoId), 'GraphQL 能读到 repository.id（写操作的必需输入）', repoId ?? JSON.stringify(can.gqlErrors));
    console.log(`\n  → 拿到 repositoryId 即证明 public_repo 足够，不需要任何 discussion scope。`);
    console.log(`  → 完整写入验证请跑：node run.mjs poc3 --yes`);
  } else {
    console.log(`\n  (config.json 未填 repo，跳过写入前的能力验证)  `);
  }

  await writeResult('poc4', { login: me.data.login, grantedScopes: granted, acceptedScopes: me.acceptedScopes });
}

// ────────────────────────────────────────────── all

async function cmdAll() {
  await cmdProbe();
  await cmdLogin();
  await cmdPoc2();
  await cmdPoc4();
  console.log(`\n  下一步：准备好测试仓库后跑  node run.mjs poc3 --yes`);
}

// ────────────────────────────────────────────── help

function cmdHelp() {
  console.log(`
DSH 插件社区 · POC 验证器

  node run.mjs probe [--repo=owner/name] [--etag]   匿名探测：POC-0 + POC-2（--etag 再加 POC-6）
  node run.mjs login                                POC-1 Device Flow（需要 config.json 的 clientId）
  node run.mjs token <PAT>                          ⭐ 捷径：贴一个 Personal Access Token，跳过 Device Flow
  node run.mjs status                               当前身份 + 配额面板 + 门控判定
  node run.mjs poc2 [--repo=owner/name]             POC-2 认证版交叉验证（免 token 版已在 probe 内）
  node run.mjs poc3 [--repo=o/n] [--yes]            POC-3 建帖+评论+回读（默认只预演）
  node run.mjs poc4 [--repo=owner/name]             POC-4 scope 交叉验证（官方文档已定论）
  node run.mjs all                                  probe → login → status → poc2 → poc4

配置：${CONFIG_PATH}
证据：poc/results/
`);
}

// ────────────────────────────────────────────── 入口

try {
  switch (command) {
    case 'probe':
      await cmdProbe();
      break;
    case 'login':
      await cmdLogin();
      break;
    case 'token':
      await cmdToken();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'poc2':
      await cmdPoc2();
      break;
    case 'poc3':
      await cmdPoc3();
      break;
    case 'poc4':
      await cmdPoc4();
      break;
    case 'all':
      await cmdAll();
      break;
    default:
      cmdHelp();
  }
} catch (err) {
  if (err instanceof Skip) {
    console.log(`\n  跳过：${err.message}`);
    process.exit(0);
  }
  console.error(`\n  ❌ ${err.message}\n`);
  process.exit(1);
}
