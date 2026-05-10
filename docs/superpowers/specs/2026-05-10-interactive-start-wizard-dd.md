# DD: Interactive Start / Setup Wizard

**Date**: 2026-05-10
**Status**: ✅ **LOCKED** (decisions accepted by user 2026-05-10; see §10)
**Author**: multi-cc-im maintainer
**Scope**: how to redesign the user-facing CLI flow for `multi-cc-im` so that a **single** entry command initialises both adapter selection and credential setup, with sensible defaults when re-entering and a clean handover into the long-running daemon. Affects `apps/multi-cc-im/src/cli.ts`, every IM adapter package's setup surface, and how future TG / WeChat adapters plug in.

---

## 1. Why this is a "重大决策"

Per [`CLAUDE.md`](../../../CLAUDE.md) DD heuristic, four triggers fire:

- **安全模型** — credentials are now entered interactively + persisted via the wizard; default-display strategy directly controls how secrets surface on screen (shoulder-surfing / screenshot risk).
- **跨包接口** — every IM adapter package (`im-lark`, future `im-tg`, possibly `im-wechat` reborn) must expose a setup surface the wizard can drive. The contract here outlives any one adapter.
- **反悔代价 > 1 周** — once the wizard framework is shipped, every adapter has to follow it; reversing means re-touching every adapter package + the CLI + docs.
- **"用现有 SDK 不造轮子"准则** — choosing an interactive prompt library vs hand-rolling on `node:readline` is exactly the rule's job.

Reversal cost: ≈ 1.5 weeks (CLI redesign + 1 adapter retrofit + tests + docs). Above DD threshold.

---

## 2. Use-case constraints (locked)

1. **Local-first** — wizard writes only to `~/.multi-cc-im/` (credentials/<adapter>.json mode 0600 + non-secret config.toml). No external services.
2. **No new daemon process model** — wizard is part of the foreground `multi-cc-im start` invocation; once setup is complete it hands the same process over to the daemon main loop (no exec / fork / re-spawn).
3. **Existing credential format respected** — `~/.multi-cc-im/credentials/lark.json` schema (DD #86) must keep working; the wizard reads + writes the same file.
4. **CI / scripted automation must stay unblocked** — there must remain a non-interactive code path so CI bots / tests can launch the daemon without TTY (e.g. `--non-interactive` or auto-detect `!process.stdin.isTTY`).
5. **No telemetry on user input** — input never leaves the local process. Logs must mask any secret-shaped value.

---

## 3. Decision dimensions

| Dim | Question | Status |
|---|---|---|
| **D1** | Single command vs separate `setup` + `start` | ✅ locked (§4) |
| **D2** | Interactive prompt library | ✅ locked (§9.D2 + §10) |
| **D3** | Configuration-guide presentation | ✅ locked (§9.D3 + §10) |
| **D4** | Default-value display strategy for stored credentials | ✅ locked (§9.D4 + §10) |
| **D5** | Multi-adapter wizard interface | ✅ locked (§9.D5 + §10) |

---

## 4. D1 — locked decision (single `start` command)

**Decision**: single entry `multi-cc-im start [<adapter>]`.

**Behavior**:
- No argument → arrow-key menu of adapters; cursor defaults to the previously-configured one (detected by `~/.multi-cc-im/credentials/<adapter>.json` presence). Enter on the default to use it; arrows pick another.
- With argument `multi-cc-im start lark` → skip the menu, jump straight to the chosen adapter.
- After selection, check `<adapter>.json` presence:
  - **Configured** → enter daemon main loop (current `start` behavior).
  - **Not configured** → render an inline prompt:
    > ❌ `lark` 未配置 ｜ [开始配置] [返回]
    - **开始配置** → invoke that adapter's setup flow (D5). On success, daemon main loop starts in the same process.
    - **返回** → without argument, returns to the adapter menu; with argument, exits with non-zero (user explicitly named a missing adapter and bailed).
- Non-interactive guard: if `!process.stdin.isTTY` and no argument was supplied, exit 1 with `multi-cc-im start: not a TTY — pass adapter name explicitly (e.g. \`start lark\`) for headless invocation`.

**Why locked**: the user picked this shape after reviewing four CLI-form candidates (A: two commands; B: single `start` with inline wizard; C: separate `setup` + `start`; D: opt-in flag). The variant settled on collapses adapter selection and credential check into the daemon entry without making the user remember a separate command, which is the strongest argument from the user's earlier feedback.

**Discarded sub-candidates** (recorded for future readers):

- D1.1.a — explicit `active_adapter` field in `~/.multi-cc-im/config.toml` written by setup, read by start. Rejected: every-time-prompt-with-default already covers single-adapter ergonomics; an explicit field adds a state-sync failure mode.
- D1.1.b — purely credentials-directory-driven default. Rejected: doesn't compose with the user's "default focus + arrow override" spec.
- D1.1.c — required `start <adapter>` argument. Rejected: pushes friction onto every invocation.
- D1.1.e — wizard auto-tail-calls daemon. Accepted as part of D1's "after success, daemon starts in same process".

---

## 5. D2 — interactive prompt library

### 5.1 Candidates

1. **node:readline** (stdlib, 0 deps) — hand-roll menu / input / default display.
2. **inquirer** (`inquirer`) — long-running, monolithic, classic Node CLI prompt lib.
3. **@inquirer/prompts** (`@inquirer/prompts`) — inquirer's modular rewrite, per-prompt imports.
4. **prompts** (`prompts`) — small single-package alternative.
5. **@clack/prompts** (`@clack/prompts`) — modern boxed UI, maintained by the natemoo-re / clack team.
6. **enquirer** (`enquirer`) — mid-popularity, customizable.

### 5.2 Due-diligence matrix

Window for "commits in last 90d": `2026-02-09 → 2026-05-09`. `unpacked` size is `npm view <pkg> dist.unpackedSize` in bytes; bundlephobia's min+gzip column is marked `?` because every bundlephobia request returned HTTP 429 during research.

| # | Candidate | A. Maintenance | B. Bundle / deps | C. TS / ESM | D. API stability | E. Ctrl-C | F. Prompt types | G. License | H. Maintainer |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **node:readline** (stdlib) | Tracks Node LTS; ships with runtime, no separate npm release | 0 bytes added; 0 deps; we hand-roll menu / masked input / default | TS via [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node); ESM via `import * as readline from 'node:readline'` | Stable since Node 0.x; [Promises API](https://nodejs.org/api/readline.html#promises-api) added Node 17 | No built-in cancel; default = process exits on Ctrl-C unless we listen on `rl.on('SIGINT', …)` ([readline events](https://nodejs.org/api/readline.html#event-sigint)) | Single-select arrow menu **NO**; masked password **NO**; text+default YES; confirm **NO** | Node.js [LICENSE](https://github.com/nodejs/node/blob/main/LICENSE) | Node.js core team |
| 2 | **inquirer** v13.4.2 (legacy facade) | Last commit [2026-05-08](https://github.com/SBoudrias/Inquirer.js/commits/main); ≥127 commits in 90d ([API](https://api.github.com/repos/SBoudrias/Inquirer.js/commits?since=2026-02-09T00:00:00Z)); 19 open issues; latest release [inquirer@13.4.2 2026-04-19](https://github.com/SBoudrias/Inquirer.js/releases/tag/inquirer%4013.4.2) | Unpacked 49,234 B [npm](https://www.npmjs.com/package/inquirer/v/13.4.2); 7 direct deps incl. `rxjs ^7.8.2`, `@inquirer/core ^11`, `mute-stream`, `run-async` ([package.json](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/inquirer/package.json)); bundlephobia ? | `"type": "module"` (ESM-only since v10) [package.json](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/inquirer/package.json); src TS-native; ships `.d.ts` | majors v10 [2024-07-07](https://github.com/SBoudrias/Inquirer.js/releases/tag/inquirer%4010.0.0), v11 [2024-09-15](https://github.com/SBoudrias/Inquirer.js/releases/tag/inquirer%4011.0.0), v12 [2024-10-06](https://github.com/SBoudrias/Inquirer.js/releases/tag/inquirer%4012.0.0), v13 [2025-11-16](https://github.com/SBoudrias/Inquirer.js/releases/tag/inquirer%4013.0.0) — **4 majors in 16 months** | Throws `ExitPromptError("User force closed the prompt with SIGINT")` ([core/create-prompt.ts](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/core/src/lib/create-prompt.ts)); legacy facade also calls `process.kill(process.pid, 'SIGINT')` ([ui/prompt.ts](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/inquirer/src/ui/prompt.ts)) — **re-raises SIGINT to host process** | menu (`list`) YES; password (`password`+mask) YES; text+default (`input`) YES; confirm YES | MIT | Individual: Simon Boudrias ([SBoudrias](https://github.com/SBoudrias)) |
| 3 | **@inquirer/prompts** v8.4.2 | Same monorepo as #2; latest release [@inquirer/prompts@8.4.2 2026-04-19](https://github.com/SBoudrias/Inquirer.js/releases/tag/%40inquirer%2Fprompts%408.4.2) | Unpacked 23,379 B [npm](https://www.npmjs.com/package/@inquirer/prompts/v/8.4.2) — ~2.1× smaller than legacy; 10 deps (one per prompt type); **no rxjs** ([package.json](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/prompts/package.json)); bundlephobia ? | `"type": "module"`, ESM-only; full `.d.ts` per sub-pkg ([tsconfig.json](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/prompts/tsconfig.json)) | majors v5 [2024-04-12](https://github.com/SBoudrias/Inquirer.js/releases/tag/%40inquirer%2Fprompts%405.0.0), v6 [2024-09-15](https://github.com/SBoudrias/Inquirer.js/releases/tag/%40inquirer%2Fprompts%406.0.0), v7 [2024-10-06](https://github.com/SBoudrias/Inquirer.js/releases/tag/%40inquirer%2Fprompts%407.0.0), v8 — **3 majors in 18 months** | Throws `ExitPromptError` on Ctrl-C — same core as #2 ([create-prompt.ts](https://github.com/SBoudrias/Inquirer.js/blob/main/packages/core/src/lib/create-prompt.ts)). Does **not** re-raise SIGINT; legacy `ui/prompt.ts` is bypassed. Catchable via `try/catch` | menu (`select`) YES; password YES; text+default (`input` + `default`) YES; confirm YES | MIT | Same as #2 |
| 4 | **prompts** v2.4.2 | Last `pushed_at` [2025-05-14](https://api.github.com/repos/terkelg/prompts) (1y old); **0 commits in 90d**; 152 open issues; last release [v2.4.2 2021-10-07](https://github.com/terkelg/prompts/releases/tag/v2.4.2) — **4.5y stale** | Unpacked 186,815 B [npm](https://www.npmjs.com/package/prompts/v/2.4.2); 2 deps `kleur`, `sisteransi`; bundlephobia ? | **CJS only** (no `"type"` field [package.json](https://github.com/terkelg/prompts/blob/master/package.json)); ships hand-written [index.d.ts](https://github.com/terkelg/prompts/blob/master/index.d.ts) | v2 since 2018-12-06 ([npm time](https://www.npmjs.com/package/prompts?activeTab=versions)); **no v3 in 7y** — frozen | Returns answers object **without the cancelled key** ([readme.md](https://github.com/terkelg/prompts#-usage)); also supports user `onCancel` callback ([lib/index.js](https://github.com/terkelg/prompts/blob/master/lib/index.js)) — does not throw | menu (`select`) YES; password YES; text+default (`text`+`initial`) YES; confirm YES | MIT | Individual: Terkel Gjervig ([terkelg](https://github.com/terkelg)) |
| 5 | **@clack/prompts** v1.3.0 | Last commit [2026-05-09](https://github.com/bombshell-dev/clack/commits/main); 45 commits in 90d ([API](https://api.github.com/repos/bombshell-dev/clack/commits?since=2026-02-09T00:00:00Z)); 80 open issues; latest release [@clack/prompts@1.3.0 2026-04-29](https://github.com/bombshell-dev/clack/releases/tag/%40clack%2Fprompts%401.3.0) | Unpacked 220,069 B [npm](https://www.npmjs.com/package/@clack/prompts/v/1.3.0) (largest); 4 deps incl. `@clack/core 1.3.0`, `fast-string-width`, `fast-wrap-ansi`, `sisteransi` ([package.json](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/package.json)); bundlephobia ? | `"type": "module"`, **ESM-only since v1.0** ([CHANGELOG @ "1.0.0"](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/CHANGELOG.md)); ships `.d.mts`; `engines.node >=20.12` | v1.0.0 [2026-01-28](https://www.npmjs.com/package/@clack/prompts/v/1.0.0) was first stable major; **only 1 major to date** | Returns a sentinel **cancel symbol**; user calls `isCancel(value)` and branches without throwing ([core/utils/index.ts](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/index.ts)). **Cleanest of all 6 for our "return option" wizard** | menu (`select`) YES; password YES; text+default (`text`+`initialValue`+`placeholder`) YES; confirm YES | MIT (LICENSE: `MIT License / Copyright (c) Nate Moore`; GitHub auto-detection returned `NOASSERTION` due to formatting) | Org: [bombshell-dev](https://github.com/bombshell-dev); primary author Nate Moore (Astro core team) |
| 6 | **enquirer** v2.4.1 | Last `pushed_at` [2024-06-11](https://api.github.com/repos/enquirer/enquirer); **0 commits in 90d**; 207 open issues; last release [v2.4.1 2023-07-28](https://www.npmjs.com/package/enquirer?activeTab=versions) — **1.8y stale** | Unpacked 188,681 B [npm](https://www.npmjs.com/package/enquirer/v/2.4.1); 2 deps `ansi-colors`, `strip-ansi`; bundlephobia ? | **CJS only** (no `"type"` field [package.json](https://github.com/enquirer/enquirer/blob/master/package.json)); ships hand-written [index.d.ts](https://github.com/enquirer/enquirer/blob/master/index.d.ts) | v2.0 since 2018-10-30; **no v3 in 7+y** | `process.once('SIGINT', …)` calls cleanup then exits ([lib/utils.js](https://github.com/enquirer/enquirer/blob/master/lib/utils.js)); long-standing [issue #210](https://github.com/enquirer/enquirer/issues/210) — Ctrl-C does not reject the prompt promise cleanly | menu (`Select`) YES; password YES; text+default (`Input`+`initial`) YES; confirm YES | MIT | Org: [enquirer](https://github.com/enquirer); maintainers Jon Schlinkert + Brian Woodward |

---

## 6. D3 — configuration guide presentation

### 6.1 Candidates

1. **D3-1 — link-only** — wizard prints `see https://github.com/.../README.md#lark-setup` and waits.
2. **D3-2 — inline ASCII steps** — wizard prints the full step-by-step (Feishu console → create app → enable bot → add `im.message.receive_v1` event over WebSocket → grant `im:message:send_as_bot` etc. → publish version → add bot to chat) before asking for `app_id`.
3. **D3-3 — open-browser** — wizard runs `open https://open.feishu.cn/app` (or platform-equivalent) so the user does the configuration in the browser and types the result back in.
4. **D3-4 — inline + opt-in browser** — D3-2's text + a `要打开浏览器看图解吗？(y/N)` prompt that triggers D3-3 on yes.
5. **D3-5 — inline + ANSI hyperlinks** — D3-2 text but every URL is wrapped as an OSC 8 hyperlink that wezterm / iTerm2 / Windows Terminal render as click-through, with terminals that don't support OSC 8 falling back to plain text.

### 6.2 Findings

- **Cross-platform open**: [`sindresorhus/open`](https://github.com/sindresorhus/open) v11.0.0, ESM, MIT, 3513 stars, last commit 2026-05-07 — the de-facto answer for `xdg-open` / `open` / `start.exe` abstraction. Active.
- **OSC 8 hyperlink + terminal detection**: [`sindresorhus/terminal-link`](https://github.com/sindresorhus/terminal-link) v5.0.0, ESM, MIT, 662 stars, last commit 2026-05-08. Internally uses `supports-hyperlinks` v4.4.0 to detect terminal capability + emits plain-text fallback. WezTerm and iTerm2 are confirmed supported by upstream `supports-hyperlinks` capability table; Apple Terminal.app is **not** supported.
- **Inline-text reproducibility**: ASCII steps in the binary are static — when Feishu console renames a tab or moves a setting, the printed steps go stale. README in the repo can be updated independently of a CLI release.
- **Opening a browser** can fail silently in headless / SSH / WSL2 sessions; need a graceful fallback to printing the URL.

### 6.3 Argument

D3-1 fails the "wizard guides the user" requirement — user has to leave the terminal to know what to do next.

D3-2 is robust (no external deps, works in SSH) but the static-text drift cost is real.

D3-3 doesn't help the SSH case at all.

D3-4 combines drift with extra interaction; users already saw the steps so the browser open is a luxury.

D3-5 is the only candidate that gives clickable hand-off **inside** the inline guide, with deterministic plain-text fallback. Browser failure mode = same as printed URL today.

---

## 7. D4 — default-value display strategy

### 7.1 Candidates

1. **D4-1** — no defaults, re-enter on every wizard run.
2. **D4-2** — display the full stored value as the default.
3. **D4-3** — masked partial display (e.g. `cli_a1b2****` first-N + asterisks).
4. **D4-4** — placeholder text `<已保存，回车保留 / 输入新值替换>` with no content shown.
5. **D4-5** — length-only hint `<已保存 32 字符>`.

### 7.2 Reference: AWS CLI's behavior (precedent)

AWS CLI has the most-imitated implementation. Source: [`aws/aws-cli`'s `awscli/customizations/configure/__init__.py:38-42`](https://github.com/aws/aws-cli/blob/main/awscli/customizations/configure/__init__.py):

```python
def mask_value(current_value):
    if current_value is None:
        return 'None'
    else:
        return ('*' * 16) + current_value[-4:]
```

Prompt template (`configure.py:42`): `"%s [%s]: " % (prompt_text, current_value)` — yielding e.g. `AWS Access Key ID [****************WXYZ]: `, with the user pressing Enter to keep or typing a new value to replace.

### 7.3 Argument

D4-1 destroys the "default focus on previously-configured" UX completely — user has to retype 32 characters every time they re-run setup.

D4-2 is the worst on the security axis — the `app_secret` is now visible to anyone in screen-share / screenshot range.

D4-3 (AWS-style) shows enough for the user to confirm "yes, that's the credential I expect" — recognizing the **last** few chars of an `app_secret` is enough disambiguation when a user has multiple — without leaking enough to be useful to a shoulder surfer. **App ID** is non-secret in the Feishu / Lark model — masking it adds no security but does hide useful info.

D4-4 is bullet-proof on security but unhelpful when a user actually does have multiple Feishu apps and needs to confirm which one they're editing.

D4-5 is intermediate — confirms "something's there" but offers no recognition.

A **field-typed strategy** (mask only secret fields, show non-secret fields fully) is the natural conclusion: each adapter declares which fields are secret in D5's schema, the wizard masks accordingly. This is independent of D4's choice between full-mask candidates.

---

## 8. D5 — multi-adapter wizard interface

### 8.1 Candidates

1. **D5-1** — CLI hard-codes a `switch (adapter)` over each name, calling adapter-specific setup directly.
2. **D5-2** — each adapter package exports an `interactiveSetup(io)` function. The CLI calls it; the adapter owns its UX.
3. **D5-3** — schema-driven: each adapter exports a Zod schema + per-field metadata (`label`, `secret`, `validate`, `hint`). The CLI's generic wizard reads the schema and renders the right prompts.
4. **D5-4** — hybrid: shared schema for the credential fields (`app_id`, `app_secret`, `token`, etc.) + an optional adapter-specific callback for adapter-only steps (e.g. "test connection by calling `tenantAccessToken.internal`").

### 8.2 Reference points

- **oclif** ([`oclif/oclif`](https://github.com/oclif/oclif)): full CLI framework, 9516 stars, MIT, last update 2026-05-09. Provides plugin architecture but is a complete CLI replacement — too heavy a swap given we already have a custom CLI in `apps/multi-cc-im/src/cli.ts`. Adopting would mean rewriting our entry to oclif's command tree.
- **Zod-driven prompts** — no maintained npm package emerged from search (`huellen-consulting/zompt` 2 stars, last touched 2024-11; `permacopia3223/claude-prompt-lib` 0 stars). Means we'd be writing the schema-to-prompt glue ourselves if we go D5-3.
- **Current adapter shape** (`packages/im-lark/src/index.ts`): already exposes `loginLark`, `LarkCredentialsSchema`, `createLarkAdapter`. The schema is real Zod; the login function already validates against the live API. Adding an `interactiveSetup` would slot in without restructuring.

### 8.3 Argument

D5-1 keeps the CLI authoritative but couples it to every adapter. Adding `tg` later means editing the CLI package + the adapter package atomically.

D5-2 cleanly separates concerns; the CLI doesn't need to know how Feishu works to drive Feishu setup. Cost: each adapter has to re-implement common patterns (default-prompt, mask, validate-then-write).

D5-3 maximises DRY but only **if** Zod schema can express everything we need (label, secret-flag, hint, multi-step "after appId, validate, then ask appSecret"). If the schema can't, we end up with adapter-specific escape hatches anyway, so the DRY win is partial.

D5-4 acknowledges that 90% of adapter setup is "ask credential fields, persist, validate" but leaves space for adapter-specific flows like "browse Feishu permissions" or "test bot is in chat". This matches the actual diversity we expect (lark / tg / wechat) without forcing every adapter into the same shape.

---

## 9. Recommendations

### 9.D2

**Recommend `@clack/prompts` v1.3.0 (#5)** — primary pick.

Three traceable reasons:

1. **Cleanest cancel semantics for our "return option" wizard** (cell #5/E vs #2/E + #6/E) — sentinel symbol checked via `isCancel(value)`, no throw, no SIGINT re-raise. Maps directly to the wizard's "user wants to back out without crashing the daemon" flow. #2 inquirer-legacy re-raises SIGINT to host via `process.kill` (would kill our bridge mid-setup); #6 enquirer has open [issue #210](https://github.com/enquirer/enquirer/issues/210), unclean rejection.
2. **ESM-native, TS-first** (cell #5/C) — `"type": "module"`, ESM-only since v1.0.0, ships `.d.mts`. Our monorepo is `"type": "module"` everywhere so #4 prompts and #6 enquirer (CJS-only) would force `createRequire` interop or shim.
3. **Active maintenance** (cell #5/A vs #4/A + #6/A) — 45 commits in last 90d, release 11 days ago, on a 1.x stable train (only 1 major bump in its lifetime per #5/D). #4 prompts has **0 commits/90d, 4.5y since release**; #6 enquirer has **0 commits/90d, 1.8y since release** — both effectively unmaintained for a security-sensitive credential-input path.

Caveat (cell #5/B): 220 KB unpacked + 4 transitive deps is the largest of the six. Acceptable because the wizard runs once at setup, **not in the daemon hot path**; lack of `rxjs` keeps runtime cost lower than #2/B's 49 KB + 7 deps + rxjs.

**Backup pick: `@inquirer/prompts` v8.4.2 (#3)** — use if `@clack/prompts`'s `engines.node >=20.12` clashes with our Node range, or if bombshell-dev loses its primary maintainer:

- Cell #3/E: `ExitPromptError` is throwable + catchable (no SIGINT re-raise like #2/E), so `try/catch` gives wizard the "return" branch.
- Cell #3/B: 23 KB unpacked + no rxjs — actually the smallest of the maintained, fully-featured candidates (vs. #2/B's 49 KB and #5/B's 220 KB).
- Cell #3/A: same active monorepo as #2 (commits yesterday, release 3 weeks ago).

Risk to flag (cell #3/D): 3 majors in 18 months — we'd pin exact version `@inquirer/prompts@8.4.2`, not `^8.4.2`.

**Rejected**:

- **#1 node:readline** — fails cell F (no menu / password / confirm out of the box). Hand-rolling raw-mode arrow keys + masked echo is exactly the "造轮子" the project's [core constraint #2](../../../CLAUDE.md) forbids.
- **#2 inquirer (legacy)** — fails cell E: re-raises SIGINT to host. Pick #3 over #2 if we go inquirer family.
- **#4 prompts**, **#6 enquirer** — both fail cell A (effectively dead) and cell C (CJS). Credential-input UX is a long-term liability; pinning to an unmaintained dep is a treating-symptoms choice forbidden by [CLAUDE.md](../../../CLAUDE.md).

### 9.D3

**Recommend D3-5** (inline ASCII + ANSI hyperlinks via `terminal-link`).

Reasoning, each traceable to §6.2:

- Inline steps survive SSH / no-browser environments, unlike D3-3 / D3-4.
- OSC 8 hyperlinks via `terminal-link` give graceful fallback (plain URL printed) when the terminal doesn't support them — `supports-hyperlinks` covers that detection.
- `terminal-link` is ESM, MIT, currently maintained (last commit 2026-05-08).
- Static drift risk (§6.2) is real but mitigated by linking to a `docs/setup-feishu.md` URL in the inline output, so updates land in the repo doc rather than the binary.

### 9.D4

**Recommend D4-3 for secret fields + D4-2 (full display) for non-secret fields** — drive selection by per-field metadata in D5's schema.

- AWS CLI's `'*' * 16 + last_4` template ([`aws-cli/__init__.py:38`](https://github.com/aws/aws-cli/blob/main/awscli/customizations/configure/__init__.py)) is the established convention; copying it earns familiarity for users already on AWS / similar tools.
- Showing `app_id` (non-secret) in full lets the user confirm which Feishu app is loaded.
- Field-typed strategy means future TG `bot_token` (secret) and `chat_id_whitelist` (non-secret) sort themselves automatically.

### 9.D5

**Recommend D5-4** (hybrid: schema-driven base + adapter-specific callback).

Reasoning, each traceable to §8.2 / §8.3:

- The 90%-common case (ask field, mask if secret, persist to `<adapter>.json`) is covered by a generic schema-driven wizard, so adding a TG adapter is "declare schema + done".
- The 10% adapter-specific case (Lark wants to call `tenantAccessToken.internal` to validate; TG wants to call `getMe`) lives in a `validate(values): Promise<void>` callback the adapter provides — symmetrical to the existing `loginLark` validation step.
- We avoid writing a Zod-to-prompt library from scratch (no usable npm package exists per §8.2) by keeping the schema metadata small and project-local.
- Compatible with the current `im-lark` package shape — only adds an export, doesn't reshape existing ones.

---

## 10. User decision (step 5 of DD process)

Track per-dimension decision below. Each dimension is independent — user can accept or override the recommendation.

| Dim | Recommendation | User decision |
|---|---|---|
| D1 | Single `start [<adapter>]` (§4) | ✅ accepted 2026-05-10 |
| D2 | `@clack/prompts` v1.3.0 (backup `@inquirer/prompts` v8.4.2) | ✅ accepted 2026-05-10 |
| D3 | D3-5 — inline + ANSI hyperlinks via `terminal-link` | ✅ accepted 2026-05-10 |
| D4 | D4-3 secret fields + D4-2 non-secret, schema-typed | ✅ accepted 2026-05-10 |
| D5 | D5-4 — hybrid schema + adapter callback | ✅ accepted 2026-05-10 |

All five rows resolved. DD is **LOCKED**. The implementation milestone tracker is reflected in [`docs/conventions.md`](../../conventions.md) status table.

### 10.1 Implementation milestones (post-DD)

| ID | Scope | Status |
|---|---|---|
| **W1** | Add `@clack/prompts` v1.3.0 + `terminal-link` v5 + `open` v11 to root deps; verify ESM bundling under tsup | pending |
| **W2** | Define schema-driven adapter setup interface in `@multi-cc-im/shared` (per D5): `AdapterSetupSchema` (zod) with per-field metadata `{ key, label, hint, secret, validate? }` + optional adapter-level `validate(values)` callback | pending |
| **W3** | `packages/im-lark/`: implement schema (app_id non-secret, app_secret secret) + adapter-level validate (calls existing `loginLark` validation) | pending |
| **W4** | New `packages/wizard/` (or `apps/multi-cc-im/src/wizard/`): generic schema-driven setup wizard rendering @clack/prompts; AWS-style mask for secret fields (D4-3) | pending |
| **W5** | `apps/multi-cc-im/src/start.ts`: pre-flight credentials check (M7 already in place) replaced by D1 flow — adapter menu (no-arg) / adapter parse (arg) → check creds → branch [run daemon \| enter wizard then run daemon \| return] | pending |
| **W6** | Inline configuration guide for `lark` (per D3-5): markdown-source-of-truth at `docs/setup-feishu.md`, terminal renders with `terminal-link` for clickable URLs, falls back to plain-text on unsupported terminals | pending |
| **W7** | Replace existing `multi-cc-im login lark` subcommand: keep as a non-interactive shortcut for scripted automation (`--app-id` / `--app-secret` flags), but route through the same schema-driven write so format stays one-shot consistent | pending |
| **W8** | Tests + docs: unit tests on schema-driven wizard (mocked clack IO), integration test for non-TTY path (exits with hint), README EN+CN setup section rewritten, conventions.md status row updated | pending |

---

## 11. Review log

- **2026-05-10 (a)** — initial draft. D1 already locked from in-conversation user pick. D2 awaiting background due-diligence agent. D3 / D4 / D5 candidates and recommendations populated based on AWS CLI source, npm + GitHub data, and our existing adapter shape.
- **2026-05-10 (b)** — D2 due-diligence agent returned. Matrix populated for all 6 candidates (cells reference GitHub commits / npm metadata / source files). Primary pick `@clack/prompts` v1.3.0 with backup `@inquirer/prompts` v8.4.2. DD ready for user step-5 decision per dimension.
- **2026-05-10 (c)** — User accepted all four recommendations (D2/D3/D4/D5) verbatim. DD status moved to **LOCKED**; §10.1 lists W1–W8 implementation milestones.
