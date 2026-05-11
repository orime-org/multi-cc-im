# multi-cc-im

**English** | [中文](README.zh-CN.md)

Bridge multiple Claude Code (cc) sessions running in WezTerm tabs to a Lark/Feishu app, addressed by `@<tab-name>`. Plain (no-mention) messages are AI-routed to the most relevant cc tab. Includes IM-side tool permission gate (`/1` allow / `/2` deny) and a pluggable architecture for additional IMs / terminals / CLIs.

---

# Part 1 — Direct use

## Prerequisites

- macOS / Linux (Windows via WSL untested)
- Node.js ≥ 22
- pnpm ≥ 9
- WezTerm ≥ 20240203
- Claude Code CLI logged in (`claude` resolvable via `PATH`; cc Pro/Max account required for AI routing)
- A Lark account dedicated as bot

## Install

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm --filter multi-cc-im build
```

The bridge entry point is `./bin/multi-cc-im`. It auto-resolves to either `apps/multi-cc-im/dist/cli.js` (after `build`) or `tsx src/cli.ts` (dev fallback).

Optional: symlink to `PATH`:

```bash
ln -s "$(pwd)/bin/multi-cc-im" ~/.local/bin/multi-cc-im
```

## Run

```bash
./bin/multi-cc-im start
```

That's it. On first run the daemon detects no `~/.multi-cc-im/credentials/lark.json` and walks you through an interactive setup wizard backed by [`docs/setup-feishu.md`](docs/setup-feishu.md):

1. Pick an IM adapter from the arrow-key menu (only `lark` today; cursor defaults to whichever one already has saved credentials).
2. Read the inline configuration guide — it links to the Feishu Open Platform pages where you create the self-built app, enable bot capability, set event subscription to WebSocket, and copy the `App ID` + `App Secret`.
3. Enter `App ID` (visible) and `App Secret` (masked input). The wizard validates them against Feishu's `auth.v3.tenantAccessToken.internal` endpoint live before persisting.
4. Daemon continues into normal run mode in the same process.

To skip the menu and go straight to a specific adapter: `./bin/multi-cc-im start lark`.

For non-interactive / scripted setup (CI / dotfile sync / re-running setup):

```bash
./bin/multi-cc-im login lark --app-id cli_xxxxxxxxxxxx --app-secret xxxxxxxxxxxxxxxx
# or via env vars:
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx ./bin/multi-cc-im login lark
```

`login` runs the same validate + persist path the wizard uses — the on-disk JSON is identical regardless of entry point. After it succeeds, `multi-cc-im start` skips the wizard.

cc hooks are auto-registered by `start` — no separate setup step. The first `start` writes a timestamped `.bak.<iso>` backup of `~/.claude/settings.json` before merging the `PreToolUse` and `Stop` hook entries. Existing hooks from other tools are preserved.

Daemon runs in the foreground. Stderr carries log output. Ctrl+C stops the daemon and clears `state/IMWork`, `state/IMOrigin`, `state/daemon.pid`.

Only one daemon per machine. Re-running `start` while one is alive exits with code 1 and prints the existing PID.

## Daemon commands (sent from Lark)

Every command is a single message sent to the bot's Lark thread.

| Command | Effect |
|---|---|
| `/list` | List wezterm tabs and which are addressable (have a `/rename`'d title) |
| `/help` | Routing examples |
| `/current` | Show current sticky target + IMWork status |
| `/start` | Enable IM mode with **auto-approve** (cc tool calls auto-pass) |
| `/start off` | Enable IM mode with **ask** mode (every tool call forwards to Lark for `/1` / `/2`) |
| `/stop` | Disable IM mode (cc replies stay in TUI; tool prompts handled in cc native menu) |

`IMWork` resets to OFF on every daemon start. You must `/start` from Lark each session.

## Routing (sent from Lark)

| Message | Effect |
|---|---|
| `@frontend hello` | Send to the cc whose tab title is `frontend`; sets it as sticky `current` |
| `@front hello` | Fuzzy match (4-level fallback: `=exact` → exact → prefix → glob); ambiguity lists candidates and rejects |
| `@frontend @api sync` | Multi-target dispatch; does **not** change `current` |
| `@all stop everything` | Broadcast to every named cc |
| `@frontend /clear` | Forward `/clear` into the cc TUI as cc's own slash command |
| `@frontend /1` | Permission allow (only if there's a pending PreToolUse) |
| `@frontend /2` | Permission deny |
| `给前端写个登录页` | **Plain message** (no `@`): daemon asks **cc itself** to triage the message — cc picks the most relevant tab and strips routing cue words ("给前端" / "the frontend one" / etc.) to extract a clean task. Echoes back `target: frontend / content: 写个登录页`. Tolerates speech-to-text typos, case / hyphen / whitespace variants, and Chinese-English mixed input. Falls back to deterministic substring match when cc's pick misses. Costs one short cc API call per plain message (counts against your cc subscription / Pro / Max usage). |

**Naming a cc:** in a cc TUI, run `/rename <name>`. The wezterm tab title becomes `<name>` and IM can address it as `@<name>`. Tabs with no `/rename` are listed by `/list` but are **not addressable** from IM.

**Tab title constraints:** avoid pure-numeric titles (they collide with wezterm pane IDs). `/start` echo warns when any are present.

## cc replies → IM rendering

Feishu text messages don't render markdown, so cc replies get simplified before sending — you see clean text instead of raw `**` / backticks:

| cc output | IM displays |
|---|---|
| `# Heading` | `▌ Heading` |
| `**bold**` | `bold` |
| `` `code` `` | `「code」` |
| `- item` | `• item` |
| ```` ```ts\nconst x = 1;\n``` ```` | `[ts]` annotation + content unchanged |
| `[text](url)` | `text (url)` |

## Tool permission flow (ask mode only)

When `/start off` is active and you address a cc from Lark, cc tool calls trigger this round-trip:

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 10 秒内回复，否则默认放行:
  @frontend /1   = 允许
  @frontend /2   = 拒绝
```

| Reply | Effect |
|---|---|
| `@frontend /1` | Allow — cc proceeds |
| `@frontend /2` | Deny — cc cancels and asks for an alternative |
| (no reply within 10s) | Default allow |

Read-only tools (`Read` / `Grep` / `Glob` / `NotebookRead`) are auto-allowed without IM forward.

## Files

| Path | Purpose |
|---|---|
| `~/.multi-cc-im/config.toml` | Daemon config (external paths like `wezterm`, cached at runtime) |
| `~/.multi-cc-im/credentials/lark.json` | `{ appId, appSecret, savedAt }` (mode 0600) |
| `~/.multi-cc-im/state/IMWork` | `{auto:bool}` — IM mode toggle (file existence = ON) |
| `~/.multi-cc-im/state/IMOrigin` | Latest IM reply context (overwritten on every inbound) |
| `~/.multi-cc-im/state/daemon.pid` | Daemon liveness lock |
| `~/.multi-cc-im/state/<paneId>_<sid>.Stop.<ts>` | cc reply event (consumed by daemon) |
| `~/.multi-cc-im/state/<paneId>_<sid>.PermissionRequest.<id>.json` | In-flight tool approval |
| `~/.multi-cc-im/state/<paneId>_<sid>.PermissionResponse.<id>.json` | Approval result |

Override the root with `MULTI_CC_IM_HOME` env.

## CLI reference

| Command | Description |
|---|---|
| `multi-cc-im start` | Start the daemon (long-running, foreground). No-arg renders an adapter-selection menu; falls through to the wizard if the chosen adapter isn't configured yet. Auto-registers cc hooks on first run (idempotent merge). |
| `multi-cc-im start <adapter>` | Skip the menu and start with the named adapter (e.g. `start lark`). Falls through to the wizard if its credentials are missing. |
| `multi-cc-im login <adapter> [--<field> <value>...]` | Non-interactive credential setup. Field flags are derived from the adapter's schema (e.g. lark: `--app-id` `--app-secret`); env vars `<ADAPTER>_<FIELD>` (e.g. `LARK_APP_ID`) are also recognized. Routes through the same validate + persist path as the wizard. |
| `multi-cc-im cleanup [--dry-run]` | Sweep stale state files; safe while daemon is running. |
| `multi-cc-im hook <event>` | cc-internal hook entrypoint (called by `~/.claude/settings.json`). |
| `multi-cc-im --help` / `-h` | Print help. |
| `multi-cc-im --version` / `-v` | Print version. |

Exit codes: `0` success, `1` runtime failure, `2` usage error.

Headless guards: `multi-cc-im start` (no arg) needs a TTY for the adapter menu. Headless callers must specify the adapter — `multi-cc-im start lark`. Same applies if creds are missing: the wizard needs a TTY; headless callers should run `multi-cc-im login lark --app-id ... --app-secret ...` first.

## Troubleshooting

### `multi-cc-im start` fails with "wezterm CLI not found"

```bash
which wezterm   # must resolve
# or write the path manually:
echo '[wezterm]' >> ~/.multi-cc-im/config.toml
echo 'path = "/Applications/WezTerm.app/Contents/MacOS/wezterm"' >> ~/.multi-cc-im/config.toml
```

### `multi-cc-im start` says "another daemon already running"

```bash
# Show the locking PID:
cat ~/.multi-cc-im/state/daemon.pid

# If it's a real running daemon, kill it normally (Ctrl+C in its terminal,
# or `kill <pid>`).
# If the PID is stale (process was SIGKILL'd), remove the lock:
rm ~/.multi-cc-im/state/daemon.pid
```

### Daemon runs but Lark doesn't receive my messages

```bash
# 1. WSClient connected? Look for "[lark] WS connected" + "ws client ready"
#    in the daemon's stderr log when it started up. If missing, the long-
#    connection didn't establish — usually a credential / event-subscription
#    config issue. Re-run setup to validate against Feishu live:
./bin/multi-cc-im login lark --app-id <id> --app-secret <secret>

# 2. cc hook actually firing? Stop files should appear when cc finishes a reply:
ls -la ~/.multi-cc-im/state/*.Stop.*

# 3. Feishu app published? Permissions + WebSocket event subscription
#    won't take effect until you publish a version in 飞书开放平台 →
#    版本管理与发布 → 创建版本 → 提交发布. See docs/setup-feishu.md.
```

### `@frontend` says "not found"

- Run `/rename frontend` inside the cc TUI.
- Send `/list` from Lark to see which tabs are addressable.

### IM doesn't receive tool permission prompts

1. Did you `/start off`? (default `/start` is auto-approve, no prompts forward.)
2. Did you address that cc from Lark first? (no `IMOrigin` → no thread to forward into).
3. Is the daemon alive? (`cat ~/.multi-cc-im/state/daemon.pid`).

### Hook registration (auto-run by `start`) complains about existing hooks

Restore from the backup `start` wrote before the merge:

```bash
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<timestamp> ~/.claude/settings.json
```

### After Ctrl+C, IM still receives stale forwards

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
│   ├── term-wezterm/        — wezterm CLI adapter
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

## Adding a new terminal adapter (tmux / kitty / etc.)

1. Create `packages/term-<name>/`.
2. Implement `TermAdapter` + `TermListPanes` from `@multi-cc-im/shared`:
   - `start(): Promise<void>`
   - `listPanes(): Promise<TermPaneInfo[]>` — must return tab titles
   - `sendText(paneId, content): Promise<void>` — paste-only (no submit)
   - `sendKeystroke(paneId, key): Promise<void>` — submit key (`\r`)
   - `stop(): Promise<void>`
3. Use a two-step send: paste content (`sendText`), wait ~300ms, submit (`sendKeystroke('\r')`). Single-step send-with-newline is forbidden — see `CLAUDE.md`「send-text 注入两步法」.

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
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | DD reports (one per locked decision) |
| [`docs/competitors.md`](docs/competitors.md) | Why not adopt project X |

## License

See [`LICENSE`](LICENSE).
