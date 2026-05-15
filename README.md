# multi-cc-im

**English** | [中文](README.zh-CN.md)

Bridge multiple Claude Code (cc) sessions running in **WezTerm or iTerm2** tabs to a Lark/Feishu app. Type anything in IM — `give the frontend one a login page` — and the daemon asks cc itself to triage and route the task to the matching tab. Use `#<tab>` only when you want to be explicit.

> **v0.1.0** (2026-05-14) — iTerm2 adapter complete + root-cause fixes from real-account smoke. See [`docs/conventions.md`](docs/conventions.md) revision log or [release notes](https://github.com/orime-org/multi-cc-im/releases/tag/v0.1.0).

**Two audiences below**:
- **[Part 1 — Direct use](#part-1--direct-use)** — install, start, IM commands, troubleshooting. Read this if you just want to use multi-cc-im.
- **[Part 2 — Secondary development](#part-2--secondary-development)** — repo layout, adapter contracts (IM / Terminal / CLI), DD flow, doc pointers. Read this if you want to add a new IM (Telegram / Slack / WeChat...) or terminal (tmux / kitty / Ghostty...) adapter, fix bugs, or just understand internals.

---

# Part 1 — Direct use

## Prerequisites

- macOS / Linux (Windows via WSL untested)
- Node.js ≥ 22, pnpm ≥ 9
- One of:
  - **WezTerm ≥ 20240203** (lowest friction — single binary, native CLI)
  - **iTerm2 ≥ 3.3** (macOS only — uses iTerm2's Python API; requires Python 3 + one-time pref toggle + Automation permission)
- Claude Code CLI logged in (`claude` resolvable on `PATH`; Pro / Max subscription required for AI routing)
- A Lark account dedicated as bot

## First-time start

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm --filter multi-cc-im build
./bin/multi-cc-im start
```

That's it. On first run a setup wizard pops up:

1. **Pick a terminal**: `wezterm` or `iterm2`. iTerm2 branch walks you through enabling its Python API preference + installing the `iterm2` PyPI package + accepting the macOS Automation permission (one time each). WezTerm has no extra setup.
2. **Pick an IM adapter**: pick `lark`, follow the inline guide to create a self-built Feishu app, paste in `App ID` + `App Secret`, the daemon validates them against Feishu and continues into normal run mode.

The choices persist in `~/.multi-cc-im/config.toml` (`[terminal].type` + `[external_paths]`); subsequent `start` runs pre-select them and let you press Enter to keep, or arrow-key to switch.

To re-configure later, or for non-interactive / headless setup:

```bash
./bin/multi-cc-im login lark --app-id cli_xxxxxxxxxxxx --app-secret xxxxxxxxxxxxxxxx
```

The daemon runs in the foreground. Ctrl+C stops it. Only one daemon per machine — re-running `start` while one is alive prints the existing PID and exits.

## Name your cc tabs

Inside any cc TUI, run `/rename frontend`. The wezterm tab title becomes `frontend`, and IM can address it as `#frontend`. Tabs with no `/rename` show up in `/list` but are **not addressable**.

> Avoid pure-numeric tab titles (they collide with wezterm pane IDs). `/start` echoes a warning if any are present.

## What to send in IM

### Just talk — AI picks the tab

```
give the frontend one a login page
```

No `#` needed. The daemon asks cc itself to triage: cc picks the most relevant tab, strips routing cue words (`give the frontend one` / `给前端` / etc.), and forwards the cleaned task. You'll see an echo:

```
target: frontend
content: a login page
```

Tolerates speech-to-text typos, case / hyphen / whitespace variants, and mixed-language input. If cc's pick misses, the daemon falls back to a deterministic substring match against tab names.

> Each plain message costs one short cc API call — counts against your cc subscription / Pro / Max usage.

### Name the tab explicitly with `#`

```
#frontend hello              # send to the frontend tab; becomes the sticky default
#frontend #api sync          # multi-target dispatch (doesn't change the default)
#all stop everything         # broadcast to every named cc
```

Fuzzy matching is supported (`#front` → `frontend` if unique). Ambiguous prefixes list candidates and ask you to disambiguate.

### Control a cc from IM

```
#frontend /clear             # forwards /clear as cc's own slash command
#frontend /1                 # allow a pending tool call (ask mode only)
#frontend /2                 # deny it
```

### Control the daemon

| Command | Effect |
|---|---|
| `/start` | Enable IM mode, **auto-approve** — cc tool calls proceed without asking you |
| `/start off` | Enable IM mode, **ask** — every tool call asks in IM first (`/1` / `/2`) |
| `/stop` | Disable IM mode (cc replies stay in TUI; tool prompts use cc's native menu) |
| `/list` | Which terminal tabs are addressable from IM |
| `/current` | Current sticky default + IM-mode status |
| `/help` | Routing examples |

> IM mode resets to OFF every time the daemon starts. Send `/start` from IM once per session.

> The `/start` echo includes a `✓ terminal: <id>` line so you can verify from the IM side which terminal adapter the daemon picked at startup (wezterm vs iterm2).

## Tool permission flow (ask mode only)

When `/start off` is active, every cc tool call asks you first:

```
[frontend] About to run:
  Bash(rm -rf node_modules)

⏳ Reply within 10s, else auto-allow:
  #frontend /1   = allow
  #frontend /2   = deny
```

You can also reply in natural language and cc decides which pending prompt you meant:

```
multi-cc-im 那个 rm 同意
api 的拒绝
deny the bash one
```

The daemon echoes back which pending it matched + the decision. Allow is safe-by-default — if your reply doesn't mention the tool name / a key argument / a clear paraphrase of the operation, the AI downgrades it to deny and you can re-issue with content. Deny always goes through.

Read-only tools (`Read` / `Grep` / `Glob` / `NotebookRead`) auto-allow without bothering IM.

## cc widget questions (AskUserQuestion) → IM (works in any mode)

When cc asks you a multiple-choice question (its `AskUserQuestion` widget — usually plan reviews / design choices / library picks), the question + options are forwarded to IM **regardless of whether you're in `/start` auto-approve or `/start off` ask mode**:

```
[multi-cc-im] cc 想问你:

Pick a database

  1. Postgres
     mature relational
  2. MongoDB
     doc store
  3. 你的考虑（自由文本）

请回复你的选择（编号或自然语言都行）
```

Reply with anything that makes sense:
- A number — `1`
- The option's label — `Postgres`
- Natural language — `我选第二个` / `the mongo one` / `do option 2 with a side of fries`
- Free text not matching any option — your reply goes through verbatim

The daemon hands your answer back to cc as a normal `AskUserQuestion` tool result (per cc's official agent-sdk channel: `permissionDecision: 'allow'` + `updatedInput: {questions, answers}`), so cc records the tool as completed successfully with your answers. If you don't reply within 2 minutes the hook self-injects empty answers so cc unblocks and decides what to do next; if you reply after the timeout you'll see `⏱ cc 已超时，本轮不再等待你的回复` in IM.

**Multi-question** AskUserQuestion (rare — cc asks 2+ questions in one call): each question gets one entry in the injected `answers` map.

## cc sensitive-path dialogs (.claude/* / .git/* / .env / etc.) → IM

cc has a hard-coded ask gate that forces a TUI permission prompt every time it tries to edit a "sensitive" path: anything under `.claude/`, `.git/`, `.vscode/`, `.idea/`, or files like `.bashrc`, `.zshrc`, `.env*`, `.gitconfig`, `.mcp.json`, `.claude.json`, etc. This gate runs **before** any user-level allow rule — even `permissions.allow` in your `~/.claude/settings.json` cannot bypass it (cc designed it this way to prevent accidental over-grants).

Without this bridge feature, IM users would silently get stuck: cc fires the TUI prompt and waits for keystrokes that never arrive. The daemon now intercepts cc's `PermissionRequest` hook and handles both modes:

### `/start` (auto mode)

Daemon emits a single-yes allow for the current call + sends an IM audit notification:

```
🛡️ daemon auto-allowed cc 编辑敏感路径
  <tab>: <path>
```

The audit line is informational — no reply needed. Same-session subsequent edits to the same path will trigger another dialog (single-yes only — daemon never silently grants a session-wide allow rule, preserving per-operation visibility).

### `/start off` (ask mode)

Daemon forwards numbered options to IM:

```
[<tab>] cc 想编辑敏感路径:
  <toolName>: <path>

  1. 同意一次（仅本次调用）
  2. 始终允许: Edit(./.claude/**)    ← cc's permission_suggestions[0]
  3. 拒绝

请回复（数字 / 自然语言均可）
```

Reply with:
- `1` / `好` / `yes` — allow this one call
- `2` / `总是允许` / `always` — allow + apply cc's session rule so subsequent same-path edits skip the gate (until cc session exits)
- `3` / `拒绝` / `no` — deny + cc gets a clear "user denied" message

The daemon resolves your choice into the actual `PermissionUpdate` cc proposed (it does **not** synthesize a new always-allow that wasn't in cc's suggestion list — preserves cc's safety semantic).

### Caveats

- **Timeout**: if you don't reply within 2 minutes, the hook self-emits a plain allow (no session rule) so cc proceeds. If you reply after the timeout you'll see `⏱ cc 已超时，本轮不再等待你的 PermissionDialog 回复` in IM.
- **Session-scoped only**: cc's safety gate only honors `destination: 'session'` rules (in-memory). Project-level / user-level `permissions.allow` settings in JSON files still get vetoed by the gate. The daemon respects this by always writing `destination: 'session'` from cc's suggestion.
- **Multi-hook**: if you have other tools registered as `PermissionRequest` hooks in `~/.claude/settings.json`, cc's "first-non-null wins" rule applies — whichever hook returns a decision first wins. multi-cc-im assumes it's the only PermissionRequest hook.

## cc replies → IM rendering

Feishu doesn't render markdown, so cc replies are simplified before sending — you see clean text instead of raw `**` / backticks:

| cc output | IM displays |
|---|---|
| `# Heading` | `▌ Heading` |
| `**bold**` | `bold` |
| `` `code` `` | `「code」` |
| `- item` | `• item` |
| ```` ```ts\nconst x = 1;\n``` ```` | `[ts]` annotation + content unchanged |
| `[text](url)` | `text (url)` |

## Monitor dashboard

`multi-cc-im start` boots a local-only web dashboard at **`http://127.0.0.1:40719`** alongside the IM bridge. The daemon prints the URL on stderr at startup — click it (or paste in your browser) any time to check on:

- **Daemon state** — pid, uptime, active terminal (wezterm / iterm2), IM adapter, IM connection
- **Sessions** — live `termAdapter.listPanes()` pane list (matches what `/list` returns over IM), with `hasRenamed` flag so you can spot un-named tabs
- **Recent errors** — in-process ring buffer (last 200, FIFO) of anything orchestrator emitted via `onError`
- **Cost** — recent cc sessions tailed from `~/.claude/projects/<slug>/<sid>.jsonl`, with model + token totals + USD estimate (LiteLLM Claude 4.x price table, vendored)

The page auto-refreshes every 5 seconds via `<meta http-equiv="refresh">` — no client JS, no SPA, just SSR HTML. JSON routes are also exposed for scripting: `/api/state`, `/api/sessions`, `/api/errors`, `/api/cost`.

Bind-only-to-loopback (`127.0.0.1`) — never reachable over the network. If port `40719` is already in use, the bridge starts anyway; daemon stderr will say so and you'll just be missing the dashboard.

## Where things live

- `~/.multi-cc-im/credentials/lark.json` — your Feishu credentials (mode 0600)
- `~/.multi-cc-im/config.toml` — terminal choice + cached binary paths
  - `[terminal] type = "wezterm" | "iterm2"` — your wizard pick
  - `[external_paths] wezterm = "..."` — cached WezTerm CLI path (wezterm users)
  - `[external_paths] python3 = "..."` — cached Python 3 path (iTerm2 users)
- `~/.multi-cc-im/state/` — runtime state, daemon self-manages
- `~/.multi-cc-im/daemon.log` — daemon stderr mirror (lark connect / orchestrator events / iterm2-helper traces); always written. `tail -f` to watch live.
- `~/.multi-cc-im/hook-trace.log` — cc-hook subprocess invocation trace. **Only written when `MULTI_CC_IM_DEBUG=<non-empty>` env is set**; silent by default. Useful for diagnosing "cc replied but IM never got it" — set the flag in the shell that launches both the daemon AND the relevant cc instances, reproduce the issue, then read the log.
- `apps/multi-cc-im/dist/iterm2-helper.py` — bundled Python script the iTerm2 adapter spawns per call (copied from `packages/term-iterm2/bin/iterm2-helper.py` by `pnpm build`)

Override the root with the `MULTI_CC_IM_HOME` env var.

## CLI reference

| Command | Description |
|---|---|
| `multi-cc-im start [adapter]` | Start the daemon (foreground). No arg → adapter-selection menu. First run auto-registers cc hooks after writing a `.bak.<iso>` of `~/.claude/settings.json`. |
| `multi-cc-im login <adapter> [--<field> <value>...]` | Non-interactive credential setup. Same validate + persist path as the wizard. Env vars like `LARK_APP_ID` are also recognized. |
| `multi-cc-im cleanup [--dry-run]` | Sweep stale state files. Safe while the daemon is running. |
| `multi-cc-im --help` / `-h` | Print help. |
| `multi-cc-im --version` / `-v` | Print version. |

Exit codes: `0` success, `1` runtime failure, `2` usage error.

## Troubleshooting

### `multi-cc-im start` says "wezterm CLI not found"

```bash
which wezterm   # must resolve
# or write the path manually:
echo '[external_paths]' >> ~/.multi-cc-im/config.toml
echo 'wezterm = "/Applications/WezTerm.app/Contents/MacOS/wezterm"' >> ~/.multi-cc-im/config.toml
```

### `multi-cc-im start` says "python3 not found" (iTerm2)

```bash
which python3   # must resolve
# macOS: install via brew or Xcode CLT
brew install python3
# OR
xcode-select --install
```

### `multi-cc-im start` says "cannot connect to iTerm2 Python API" (iTerm2)

The wizard tried to open a real connection (`iterm2.run_until_complete`) and got `There was a problem connecting to iTerm2`. Two common causes:

1. **Preference is off** — by far the most common. Fix:

   ```text
   iTerm2 → Settings → General → Magic → ☑ Enable Python API
   ```

   Then re-run `./bin/multi-cc-im start`. The wizard re-runs the connect smoke and shows `Smoke check: iTerm2 Python API is reachable.` if it worked.

2. **iTerm2 not running** — launch any installed copy (they share preferences via `com.googlecode.iterm2`) and retry.

If the connect smoke passes but the package itself is missing (`ModuleNotFoundError: No module named iterm2`), the wizard's pip install step probably failed silently. Re-install manually:

```bash
python3 -m pip install --user --break-system-packages iterm2
```

### iTerm2: tab title from `/rename` not appearing in `/list`

- The wizard's empirical connect smoke (above) already verified the Python API preference. If `/list` still misses tab titles, a later macOS update may have revoked the Automation permission silently — re-run `./bin/multi-cc-im start` so the connect smoke re-triggers the system permission dialog.
- The iTerm2 adapter reads `session.autoName` (set by cc's `/rename`). If the title still shows the default cc title `Claude Code [...]`, retry `/rename` inside the cc TUI.

### `multi-cc-im start` says "another daemon already running"

```bash
cat ~/.multi-cc-im/state/daemon.pid
# Real running daemon → Ctrl+C in its terminal, or `kill <pid>`.
# Stale PID (process was SIGKILL'd) → remove the lock:
rm ~/.multi-cc-im/state/daemon.pid
```

### Daemon runs but IM doesn't receive my messages

Check, in order:

1. Re-run setup so credentials are validated live: `./bin/multi-cc-im login lark --app-id <id> --app-secret <secret>`.
2. Did you publish the Feishu app? Permissions + event subscription only take effect after 飞书开放平台 → 版本管理与发布 → 创建版本 → 提交发布. See [`docs/setup-feishu.md`](docs/setup-feishu.md).

### `#frontend` says "not found"

- Inside the cc TUI, run `/rename frontend`.
- Send `/list` from IM to see which tabs are addressable.

### IM doesn't get tool permission prompts

1. Are you in `/start off`? (default `/start` is auto-approve — no prompts forward.)
2. Did you address that cc from IM at least once first? (no IM thread → nowhere to forward to.)
3. Is the daemon alive? (`cat ~/.multi-cc-im/state/daemon.pid`.)

### Hook registration complains about existing hooks

Restore the backup `start` wrote before merging:

```bash
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<timestamp> ~/.claude/settings.json
```

### After Ctrl+C, IM still gets stale forwards

```bash
ls ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid
# Both should be absent. If present, remove manually:
rm -f ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/IMOrigin ~/.multi-cc-im/state/daemon.pid
```

### `state/` accumulating files

```bash
./bin/multi-cc-im cleanup --dry-run   # preview
./bin/multi-cc-im cleanup             # actually sweep
```

---

# Part 2 — Secondary development

## Stack

- TypeScript strict, ESM-only (`"type": "module"`)
- Node ≥ 22
- pnpm workspaces (monorepo)
- Vitest (unit + integration tests)
- tsup (CLI bundling)

## Repo layout

```
multi-cc-im/
├── apps/multi-cc-im/        — CLI binary (bundled by tsup → dist/cli.js)
├── packages/
│   ├── shared/              — Cross-package types + zod schemas
│   ├── storage-files/       — TOML + JSON file stores (config, credentials, cursor, queues)
│   ├── im-lark/             — Lark/Feishu adapter (npm depend `@larksuiteoapi/node-sdk`)
│   ├── term-wezterm/        — WezTerm CLI adapter
│   ├── term-iterm2/         — iTerm2 Python API adapter (ephemeral helper subprocess; see DD 2026-05-13)
│   ├── cli-cc/              — Claude Code hook adapter
│   └── bridge/              — Router + orchestrator + AI-routed dispatch
├── bin/multi-cc-im          — Bash wrapper (resolves dist or tsx)
├── docs/
│   ├── architecture.md      — Full architecture + state schema + IPC
│   ├── dev.md               — Dev commands + TDD rhythm + debugging tips
│   ├── competitors.md       — Comparison with related tools
│   └── superpowers/specs/   — DD reports (one per major decision)
└── CLAUDE.md                — Project rules (mandatory before any contribution)
```

## Dev commands

| Command | Description |
|---|---|
| `pnpm install` | Install all workspace deps |
| `pnpm --filter multi-cc-im dev <args>` | Run CLI from source via tsx |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm test` | Run all vitest suites |
| `pnpm test:watch` | Vitest watch mode |
| `pnpm test:coverage` | Vitest with V8 coverage report |
| `pnpm --filter @multi-cc-im/bridge exec vitest run src/router.test.ts` | Run a single test file |
| `pnpm --filter multi-cc-im build` | Bundle CLI to `apps/multi-cc-im/dist/cli.js` |
| `pnpm --filter multi-cc-im smoke` | Run the bundled CLI (`node dist/cli.js`) |

Coverage threshold: ≥ 80% line coverage workspace-wide. CI enforces.

## Internal CLI commands (used by hooks, not for direct invocation)

- `multi-cc-im hook <event>` — invoked by `~/.claude/settings.json` PreToolUse / Stop hooks. Auto-registered by `start`; not for manual use.

## TDD rhythm

Per `CLAUDE.md` and [`docs/dev.md`](docs/dev.md): write a failing test that codifies the target behavior → minimal implementation to pass → refactor + verify ≥ 80% coverage. If the test cannot pass under the current design, stop and re-do the DD — don't patch the wrong assumption.

## Adding a new IM adapter (Telegram / Slack / etc.)

1. Create `packages/im-<name>/` mirroring `packages/im-lark/` layout.
2. Implement the `IMAdapter` interface from `@multi-cc-im/shared`:
   - `start(handler: IMHandler): Promise<void>`
   - `send(text: string, replyCtx: IMReplyContext): Promise<void>`
   - `stop(): Promise<void>`
3. Define an `IMReplyContext` discriminated-union variant with `imType: 'telegram' | 'lark' | ...`.
4. Export a `setupSchema: AdapterSetupSchema` (per-field `{ key, label, hint, secret, schema }` + optional `validate(values)`) so the W4 wizard can drive setup without adapter-specific code. See `larkSetupSchema` for the reference shape.
5. Add a new entry to `adapters` in `apps/multi-cc-im/src/adapters.ts` with `id` / `setupSchema` / `persist(values, paths)` / `buildAdapterRuntime({paths, log})`. The CLI inherits `multi-cc-im start <id>` + `multi-cc-im login <id> --<field> <value>` + the wizard's adapter menu for free.
6. Add credential storage under `~/.multi-cc-im/credentials/<im>.json` (mode 0600). **Do not** call OS keychain — see [DD: credentials persistence](docs/superpowers/specs/2026-05-03-keychain-library-dd.md).
7. Optional: ship a `docs/setup-<im>.md` walkthrough and point `guideDocPath` at it in the registry entry. The wizard renders it with clickable OSC 8 hyperlinks on supporting terminals (W6).

## Adding a new terminal adapter (tmux / kitty / Ghostty / etc.)

Refs: [DD: iTerm2 adapter](docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md) (reference second-adapter implementation) and the resulting code in `packages/term-iterm2/`.

1. Create `packages/term-<name>/`.
2. Add `<name>` to `TerminalIdSchema` (`packages/shared/src/adapter/storage.ts`) — `z.enum(['wezterm', 'iterm2', '<name>'])`.
3. Implement `TermAdapter & TermListPanes` from `@multi-cc-im/shared`:
   - `name: '<name>'` literal (used by orchestrator to compute `activeTerminalId`)
   - `start(handler): Promise<void>` (no-op unless terminal pushes lifecycle events)
   - `listPanes(): Promise<TermPaneInfo[]>` — return `{paneId, title, cwd}` for every tab/pane
   - `sendText(paneId, content): Promise<void>` — paste-only (no submit)
   - `sendKeystroke(paneId, key): Promise<void>` — submit key (e.g. `\r`)
   - `stop(): Promise<void>`
4. **Two-step send** mandatory: `sendText(content)` → orchestrator sleeps ~300ms → `sendKeystroke('\r')`. Single-step send-with-newline is forbidden — see `CLAUDE.md`「send-text 注入两步法」.
5. **Pane-id detector**: if the terminal exports an env var that identifies the current pane (e.g. `KITTY_WINDOW_ID`, `TMUX_PANE`), add a `TaggedDetector` to `packages/cli-cc/src/pane-id-detectors.ts` `DEFAULT_DETECTORS`. The detector returns `PaneId` (branded `number | string`) given `process.env`. Issue 378 root-cause framing: the detector's `termId` flows end-to-end through `Stop` state-file payloads and `IM<TermType>` per-terminal IMWork files — DO NOT infer terminal from `typeof paneId`.
6. **start.ts wiring**: branch the wizard's `selectTerminal` to surface the new option; conditional-create the adapter in `start.ts` based on `config.terminal.type`.
7. Add tests covering listPanes / sendText / sendKeystroke / detector (mirror `packages/term-iterm2/src/*.test.ts`).

## Adding a new CLI adapter (codex / aider / etc.)

The cc adapter (`packages/cli-cc/`) couples to cc-specific hooks (`PreToolUse`, `Stop`) + jsonl transcripts. A new CLI needs equivalent extension points; if none exist, raise a DD before implementing — see `CLAUDE.md`「不破坏现有 cc 进程」.

## Major decision (DD) flow

Any change that affects the security model, long-term maintenance, cross-package interfaces, or "use existing SDKs" principle requires a DD report under `docs/superpowers/specs/<date>-<topic>-dd.md`. The DD must enumerate candidates (including "do not do X"), evidence-based comparison matrix, and a recommendation traceable to matrix cells. See `CLAUDE.md`「重大决策 DD 流程」.

## Documentation pointers

| Document | Use when |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | AI working discipline (root-cause / DD flow / coding-behavior / general engineering rules) |
| [`docs/conventions.md`](docs/conventions.md) | Project-specific tech conventions (status table, hook timeout / send-text two-step / routing keys / project-specific prohibitions) |
| [`docs/architecture.md`](docs/architecture.md) | Architecture diagram, state schema, file IPC |
| [`docs/dev.md`](docs/dev.md) | Dev commands + TDD rhythm + debugging tips |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | DD reports (one per locked decision) — recent: [iTerm2 adapter](docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md), [IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md), [PermissionRequest IM bridge](docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md), [credentials persistence](docs/superpowers/specs/2026-05-03-keychain-library-dd.md) |
| [`docs/competitors.md`](docs/competitors.md) | Why not adopt project X |

## License

See [`LICENSE`](LICENSE).
