# dsh-plugin-community

**A community layer for DSH plugins** — turns GitHub Discussions into a discussion board for plugins,
GitHub Issues into a bug-report inbox, and stars into a rating.

> 中文版见 [README.md](./README.md)。

> ⚠️ **This is a demo (0.1.0), not a stable release.** The code is complete and all 153 tests pass, but
> three things have **not been verified in a real environment yet**: the tool cards (they need a real DSH
> with this plugin installed), the `dsh.so` / `dsh.works` / Lanshu index sources (unreachable from the
> development machine, so only their parsing logic was tested against offline fixtures), and the actual
> npm packing result. Sign-in additionally requires you to register your own GitHub OAuth App and put its
> Client ID into the config. Fine to evaluate and play with; **not recommended for anything that depends
> on it yet**.

This package has **two halves**:

- **the host half** (`lib/index.js`) — mounts two routes (one HTML page for humans, one JSON API for
  programs). Everything it shows is read from existing plugin indexes and from GitHub. It **stores
  nothing and runs no database of its own**.
- **the client half** (`lib/client.js`) — inserts seven seats into the DSH interface so the community
  **lives inside DSH**, instead of hanging off an external web page.

Both halves are **hand-written plain JS with zero build step**: the client half is just a factory
function wrapped in `window.__ModuleLoader__.load({ id, factory })`, written with
`React.createElement` instead of JSX.
(This is not a style preference — the npm registry is unreachable on this machine, so esbuild/rollup
cannot be installed, and pulling in a build tool just to ship would add CI dependencies for nothing.)

> Positioning: the world does not lack another "plugin marketplace"; it lacks a "plugin community".
> So this package only does **bridging and organising**. It is not a second marketplace.

---

## What actually works right now (honest version)

| Capability | Status |
|---|---|
| Index several plugin sources and merge them into one card shape | ✅ works |
| `/community` page (server-rendered HTML) | ✅ works |
| `/community/plugin?repo=` detail page | ✅ works |
| `/api/v1/community/*` read endpoints | ✅ works |
| Layered cache + serve stale data when an upstream is down | ✅ works |
| Read-only when logged out; every write returns 401 | ✅ works |
| Login (GitHub Device Flow, 8-character code) | ✅ works (**requires `clientId` to be configured** — see below) |
| Actually posting / commenting / reacting | ✅ works (`public_repo` scope) |
| Sidebar entry + main-panel community page (`sidebar.panellist` + `main`) | ✅ works |
| Community discussion embedded in the plugin detail page (without leaving it) | ✅ works |
| Agent tools (`community_search` and 3 more) | ⏳ M4 |
| Publish to npm | ⏳ M4 |

**When `clientId` is not configured it neither crashes nor pretends to be able to log you in**: the
page spells out the setup steps (5 of them, and step 4 — "tick Enable Device Flow" — is the one
everyone misses), while the API returns `503 NOT_CONFIGURED`.
That inconsistency is **deliberate**: a human gets instructions they can follow, a script gets an
unambiguous status code.

**Logged out, "read the discussion list" is also unreadable**: GitHub's GraphQL quota for
unauthenticated requests is **0**, and the REST side has **no discussions endpoint at all**
(measured, not guessed).
So the endpoint returns `{available:false, reason:"TOKEN_REQUIRED"}` rather than pretending "this
plugin has no discussions" — conflating "couldn't read" with "nothing there" is worse than an error.

---

## Quick start

### Just want to see what the page looks like (without installing into DSH)

```bash
node scripts/preview.mjs
# open http://127.0.0.1:3221/community in a browser
```

To view it from a phone:

```bash
ALLOW_REMOTE=1 PORT=3221 node scripts/preview.mjs
# open http://<your-computer-LAN-IP>:3221/community on the phone
```

### Installing into DSH

After installing into a profile, add a block to `cordis.patch.yml` (or just take the defaults below):

```yaml
- insert:
    - id: dsh-plugin-community
      name: 'dsh-plugin-community'
      config:
        owner: 'moyuqing-man'
        repo: 'dsh-plugin-community'
```

Then restart DSH and open `http://127.0.0.1:<port>/community`.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `owner` | `moyuqing-man` | Owner of the community repository |
| `repo` | `dsh-plugin-community` | Name of the community repository |
| `allowRemote` | `false` | **Localhost-only by default.** Exposing it to your phone/LAN requires explicitly setting `true` |
| `cacheTtlMinutes` | `60` | How long an index stays fresh |
| `sources` | `['github-topic','awesome']` | Which index sources to enable |
| `userAgent` | `dsh-plugin-community/0.1.0` | UA sent with GitHub requests |
| `prewarm` | `true` | Warm the large sources shortly after startup |

`owner` / `repo` **are configuration, not hardcoded** — switching repositories means changing those
two lines and nothing else.

---

## Routes

### Pages (server-rendered; they work with JavaScript turned off)

| Path | Meaning |
|---|---|
| `/community` | Plugin list; accepts `?q=&category=&sort=&page=` |
| `/community/plugin?repo=owner/name` | Plugin detail |
| `/community/t?id=<discussion>` | 302 redirect to GitHub — **discussion bodies are never re-hosted here** |
| `/community/u?login=<user>` | Posts by author |

The pages contain **zero front-end JS**: search is a `<form method="get">`, paging and filtering are
`<a>` links.
That is not fastidiousness, it is a hard requirement — a client-side plugin icon may fail to load
inside a mobile WebView, and the page still has to be usable when it does.

**Language**: every page accepts `?lang=zh` / `?lang=en`; without it the language comes from
`Accept-Language`. There is a language switcher in the top-right corner, and switching **carries your
current search terms and filters over**, so switching never throws away your results.

### JSON API

| Path | Method | Meaning |
|---|---|---|
| `/api/v1/community/plugins` | GET | List |
| `/api/v1/community/plugin` | GET | One plugin; `?repo=owner/name` or **`?pkg=<npm package name>`** (see below) |
| `/api/v1/community/meta` | GET | Public configuration facts (repo URL, prefix, whether a clientId is set); **public values only** |
| `/api/v1/community/discussions` | GET | Discussion list |
| `/api/v1/community/discussion` | GET / POST | Read / post (POST returns **201**) |
| `/api/v1/community/reaction` | POST | React (one of 8) |
| `/api/v1/community/issues` | GET | Issue list |
| `/api/v1/community/me` | GET | Current login state (**never returns a token**) |
| `/api/v1/community/auth/start` | POST | Start Device Flow; returns the 8-character code |
| `/api/v1/community/auth/poll` | POST | Poll for the token; returns **202** while waiting |
| `/api/v1/community/auth/logout` | POST | Log out (clears the `credentials` record) |

Errors share one envelope: `{ ok: false, status, reason, message, fields, requestId }`.

**Two preconditions for every write**: ① you must be logged in; ② the request must carry
`Content-Type: application/json` and a same-origin `Origin`. The second is not formalism —
without that header the request is a "simple request" and **triggers no CORS preflight**, so a
malicious page could post using your logged-in browser. A JSON content type forces a preflight, the
browser asks first, and that is the moment we get to say no.

---

### Why `/plugin` also accepts `?pkg=`

Because **the client half only ever holds an npm package name, never a repository URL**. The
plugin detail page hands it a `subject` shaped like this:
`{ kind: 'bundle' | 'row', pkg?: { name }, row?: { moduleName } }` — so to show "this plugin's
community discussion, without leaving the detail page", the package name has to be resolved to a
repository first.

Resolution uses the `npm` field already present in the index sources (case-insensitive; `@scope/name`
works too). There is a real trap here: **not every index source carries an `npm` field** —
`github-topic` does not. With only that kind of source enabled the lookup returns 400, which is a
difference in source capability, not a bug. The default configuration includes `awesome`, so the
lookup works out of the box.

---

## The seven seats the client half fills

| Seat | Registration id / key | What it does |
|---|---|---|
| `sidebar.panellist` | `community` (order 30) | Sidebar icon; **its id matches the main panel's key, and DSH wires the two together automatically** |
| `main` | key `community` | Main-panel community page (search + list + link to the full page) |
| `plugins.detail.badge` | `community` (order 20) | Badge next to the plugin title; **renders null** when there is no matching plugin |
| `plugins.detail.section` | `community` (order 40) | Community block on the detail page: stars, issues, discussions, known issues |
| `settings.section` | `community` (order 45) | Settings page: community repo URL + login/logout |
| `shell.overlay` | `community-login` (order 70) | Bottom-right login overlay; appears only when logged out *and* a `clientId` is configured |
| `tool.call.toolview` × 4 | key = tool name (`community_search` / `_plugin` / `_post` / `_triage`) | Custom cards for the four agent tools: title, arguments, output, error |

Four deliberate choices:

1. **`main` uses a key nobody else occupies.** Reusing an occupied key **replaces** its current
   owner (collide with `conversation`, for example, and you displace the conversation panel), so
   every new entry point uses its own id.
2. **A tool card's key must match the host-side tool name exactly.** When it does not, DSH falls back
   to the generic shipped card **silently** — no UI error, no log line — so a test reads
   `lib/core/tools.js` directly and compares the two name sets. This was checked before it was
   written: `tool.call.toolview` is a keyed slot with an open `keyDomain`, and none of the four
   `community_*` names is taken, so these registrations are purely additive and shadow nobody.
3. **Styling uses theme variables only** (`--dsw-alias-*`), never hardcoded colours — it follows both
   the light and the dark theme.
4. **The client half only calls the host half's own route** (same-origin `fetch` with
   `credentials: 'same-origin'`) and never touches GitHub. Credentials stay in the host and never
   reach the browser.

---

## Red lines this plugin holds itself to

1. **Zero runtime dependencies** (`dependencies` and `peerDependencies` are both empty) and
   `lib/` **imports no `@deepseek-ai/*`**.
   The payoff: the host half can be tested entirely locally against a fake ctx, with no build tooling.
2. **Zero native modules.** Android cannot run any precompiled `.node` file, and "DSH for Android"
   happens to be the one mobile option whose plugin support is complete.
3. **A totally dead upstream still does not white-screen.** The cache has a "stale but usable" tier:
   when fresh data is unavailable it shows the old data plus a notice, not an error page.
4. **Logged out means read-only.** Every write checks login state first, returns 401 when logged out,
   and never produces a write while unauthenticated; even when logged in it must pass the
   `Content-Type` + `Origin` same-origin checks.
5. **No token in logs, no token in the repository.** Tokens live only in `ctx.credentials`, and there
   is **no token file anywhere** in the plugin directory. Self-check command (written with character
   classes so that this very sentence does not trip its own check):

   ```bash
   grep -riE "gh[opsu]_|github[_]pat_" plugin/ && echo "matched — go look" || echo "clean"
   ```
6. **A repeat submission does not create a second post.** Identical title + body within 60 seconds
   returns the earlier result tagged `deduped`; writes are forced at least 1.2 seconds apart; and
   **POST is never retried** — a duplicate post is far more annoying to clean up than a few seconds
   of latency.

---

## Languages

The interface ships **Chinese and English**, and each of the three surfaces decides independently:

| Surface | How the language is chosen | Can it be changed? |
|---|---|---|
| Server-rendered pages (`/community*`, login page, error pages) | `?lang=` → `Accept-Language` → Chinese | Change the link; there is a switcher in the top-right corner |
| The client half (sidebar panel, detail-page section, settings, login overlay) | a manual `localStorage` override → browser language | Two buttons under "interface language" in settings; **the choice is remembered** |
| Agent tool output | follows the language of the underlying index entry (`description.zh` first) | — |

A few deliberate decisions:

- **An English string may not contain a Chinese character** (a test watches for exactly this).
  Mixed strings are the easiest way to look fine in a Chinese environment and only discover the
  missing translation once you are in an English one.
- That constraint covers **interface copy only, never the data in the index sources**. On a real
  install the English pages still contain Chinese — those are descriptions written by plugin
  authors, and many entries exist in Chinese only. Such descriptions are shown as-is through the
  `pickLocalized` fallback rather than left blank. Measured: the `?lang=en` list page carries 270
  Chinese characters, almost all of them plugin descriptions (the only two that belong to the
  interface are the 「中文」 label in the language switcher).
- Descriptions in the index sources very often exist in only one language, so when `pickLocalized`
  cannot find the current language it **falls back to the other one** instead of rendering blank —
  "can't read it" beats "nothing there".
- Relative times ("3 天前" / "3 days ago") are hand-written rather than delegated to
  `Intl.RelativeTimeFormat`: zero dependencies is a red line, and older Android WebViews may not
  have it.
- The label on that sidebar icon button is computed by the host at projection time, so it **only
  follows a language change on the next load**; everything inside the panel switches on the click.

---

## Known limitations

- **Sorting by stars puts the framework itself on top.** `topic:dsh-plugin` is self-declared
  (GitHub's matching is exact — verified), and `deepseek-ai/deepseek-harness` carries the tag too.
  19,055 repositories in the ecosystem carry this topic, so "hottest plugins" ends up mixed with a
  lot of large repositories that are not plugins. The default sort stays on stars (it is the
  intuitive one); a blended score or a configurable exclusion list is planned.
- **The unauthenticated quota is a hard wall**: `api.github.com` allows 60 requests per hour and
  10 per minute on the search bucket (counted per egress IP). So the list page eats only the indexes
  and only the detail page fetches live metadata — otherwise 30 cards would burn an hour's quota.
- Native packages such as `@vscode/ripgrep-android-arm64` simply do not exist on Android, which is
  why this plugin touches no native dependencies at all.

---

## Development

```bash
node --test "test/*.test.mjs"     # 151 tests
node scripts/pack-check.mjs       # pre-publish check: pack list + relative-import graph + manifest fields
```

> On Windows do not use `node --test test/` — Node 24 resolves it as a module path and fails with
> `Cannot find module ...\test`. Use the glob form.

Test coverage: text and URL safety, card normalisation and merging, the error envelope, caching
(stale fallback and concurrent de-duplication), index parsing (6 sources + install-command parsing),
routing (JSON/HTML/status codes/works with JS off), host wiring (route registration and teardown,
localhost restriction, still renders when every upstream is down), the write path (idempotency /
write spacing / never retried / GraphQL errors hidden inside a 200), Device Flow (code never leaks /
cold-start polling blocked locally / `slow_down` increases the interval), **languages** (resolution
and precedence / identical key sets in zh and en / no Chinese characters on English pages / plural
handling in relative times), the **client half** (bundle shape / zero dependencies / seven seats /
requires react and nothing else / a language override is remembered / **tool-card keys match the
host tool names exactly** plus all three phases and bad shapes), and the **publish boundary**
(every packed file exists on disk, `test/` and `node_modules/` stay out, size ceiling, zero runtime
dependencies, the entry point is always in the package).

**151 tests** in total.

Every index source's `parse()` is a pure function tested against offline fixtures — no network needed.
The client half is tested by swapping `globalThis.window.__ModuleLoader__` and capturing the bundle,
so it needs **no browser** either.

The release procedure is **not part of this repository** (it is the maintainer's own notes).
The check script `node scripts/pack-check.mjs` tells you exactly which files would ship and how npm
computes `files`.

## License

MIT
