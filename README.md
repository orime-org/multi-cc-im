# multi-cc-im

**English** | [中文](README.zh-CN.md)

Bridge multiple Claude Code (cc) sessions running in WezTerm tabs to a Lark/Feishu app. Type anything in IM — `give the frontend one a login page` — and the daemon asks cc itself to triage and route the task to the matching tab. Use `@<tab>` only when you want to be explicit.

---

# Part 1 — Direct use

## Prerequisites

- macOS / Linux (Windows via WSL untested)
- Node.js ≥ 22, pnpm ≥ 9
- WezTerm ≥ 20240203
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

That's it. On first run a setup wizard pops up — pick `lark`, follow the inline guide to create a self-built Feishu app, paste in `App ID` + `App Secret`, the daemon validates them against Feishu and continues into normal run mode.

To re-configure later, or for non-interactive / headless setup:

```bash
./bin/multi-cc-im login lark --app-id cli_xxxxxxxxxxxx --app-secret xxxxxxxxxxxxxxxx
```

The daemon runs in the foreground. Ctrl+C stops it. Only one daemon per machine — re-running `start` while one is alive prints the existing PID and exits.

## Name your cc tabs

Inside any cc TUI, run `/rename frontend`. The wezterm tab title becomes `frontend`, and IM can address it as `@frontend`. Tabs with no `/rename` show up in `/list` but are **not addressable**.

> Avoid pure-numeric tab titles (they collide with wezterm pane IDs). `/start` echoes a warning if any are present.

## What to send in IM

### Just talk — AI picks the tab

```
give the frontend one a login page
```

No `@` needed. The daemon asks cc itself to triage: cc picks the most relevant tab, strips routing cue words (`give the frontend one` / `给前端` / etc.), and forwards the cleaned task. You'll see an echo:

```
target: frontend
content: a login page
```

Tolerates speech-to-text typos, case / hyphen / whitespace variants, and mixed-language input. If cc's pick misses, the daemon falls back to a deterministic substring match against tab names.

> Each plain message costs one short cc API call — counts against your cc subscription / Pro / Max usage.

### Name the tab explicitly with `@`

```
@frontend hello              # send to the frontend tab; becomes the sticky default
@frontend @api sync          # multi-target dispatch (doesn't change the default)
@all stop everything         # broadcast to every named cc
```

Fuzzy matching is supported (`@front` → `frontend` if unique). Ambiguous prefixes list candidates and ask you to disambiguate.

### Control a cc from IM

```
@frontend /clear             # forwards /clear as cc's own slash command
@frontend /1                 # allow a pending tool call (ask mode only)
@frontend /2                 # deny it
```

### Control the daemon

| Command | Effect |
|---|---|
| `/start` | Enable IM mode, **auto-approve** — cc tool calls proceed without asking you |
| `/start off` | Enable IM mode, **ask** — every tool call asks in IM first (`/1` / `/2`) |
| `/stop` | Disable IM mode (cc replies stay in TUI; tool prompts use cc's native menu) |
| `/list` | Which wezterm tabs are addressable from IM |
| `/current` | Current sticky default + IM-mode status |
| `/help` | Routing examples |

> IM mode resets to OFF every time the daemon starts. Send `/start` from IM once per session.

## Tool permission flow (ask mode only)

When `/start off` is active, every cc tool call asks you first:

```
[frontend] About to run:
  Bash(rm -rf node_modules)

⏳ Reply within 10s, else auto-allow:
  @frontend /1   = allow
  @frontend /2   = deny
```

You can also reply in natural language and cc decides which pending prompt you meant:

```
multi-cc-im 那个 rm 同意
api 的拒绝
deny the bash one
```

The daemon echoes back which pending it matched + the decision. Allow is safe-by-default — if your reply doesn't mention the tool name / a key argument / a clear paraphrase of the operation, the AI downgrades it to deny and you can re-issue with content. Deny always goes through.

Read-only tools (`Read` / `Grep` / `Glob` / `NotebookRead`) auto-allow without bothering IM.

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

## Where things live

- `~/.multi-cc-im/credentials/lark.json` — your Feishu credentials (mode 0600)
- `~/.multi-cc-im/state/` — runtime state, daemon self-manages

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
echo '[wezterm]' >> ~/.multi-cc-im/config.toml
echo 'path = "/Applications/WezTerm.app/Contents/MacOS/wezterm"' >> ~/.multi-cc-im/config.toml
```

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

### `@frontend` says "not found"

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
