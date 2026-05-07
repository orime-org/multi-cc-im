# multi-cc-im

A personal local bridge that exposes **multiple Claude Code sessions running in WezTerm tabs** to WeChat via Tencent's iLink Bot API. Use the terminal in the office, WeChat outside, both at once. Includes `@session` routing, cc usage analytics, and a pluggable architecture for additional IMs / terminals / CLIs.

> **Status**: v1 implementation complete — 6 packages + 1 app shipped (`apps/multi-cc-im/` is the executable CLI). Remaining follow-ups: real-environment WezTerm + cc + WeChat end-to-end smoke test, image / voice ingress validation, Telegram / Lark IM adapters, analytics.

## Quick Start

### 1. Install WezTerm (one-time)

```bash
brew install --cask wezterm
```

multi-cc-im probes the WezTerm path at startup and caches it to `~/.multi-cc-im/config.toml [external_paths].wezterm`. **Hardcoded paths are forbidden.** See [docs/architecture.md "External CLI tool path policy"](docs/architecture.md#外部-cli-工具路径策略).

### 2. Install multi-cc-im

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm typecheck && pnpm test            # optional verification
pnpm --filter multi-cc-im build        # recommended: bundle dist/cli.js for fast cold starts
```

The CLI entry point is the `bin/multi-cc-im` bash wrapper. **Production mode** (recommended): after `pnpm build` the wrapper auto-uses `apps/multi-cc-im/dist/cli.js` (~50 ms startup). **Dev mode**: when the bundle is absent, falls back to `tsx src/cli.ts` (~300–1500 ms startup). cc hooks fire twice per assistant turn — **production mode is required** in practice; otherwise typing latency from your phone is visible to the eye.

### 3. First-time WeChat login (QR scan)

```bash
./bin/multi-cc-im login wechat
# equivalent to: pnpm --filter multi-cc-im dev login wechat (dev-time alias)
```

The terminal prints a QR code; scan + confirm in WeChat → the bridge persists `bot_token` to `~/.multi-cc-im/credentials/wechat.json` (mode 0600, matching the Tencent OpenClaw vendor upstream; [DD: credentials persistence strategy](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)).

### 4. Configure cc hooks (one-time per cc setup)

```bash
./bin/multi-cc-im setup-hooks
```

Idempotent merge — auto-detects the current state of `~/.claude/settings.json` and writes multi-cc-im's 3 hook commands (using the current repo's absolute path):

- File missing → create
- Exists but empty `{}` or no `hooks` field → add hooks
- Already has other tools' hooks → preserve them, append multi-cc-im's 6
- Already has stale multi-cc-im hooks (e.g. you moved the repo) → replace with the current path's 6

**Safety**: before writing, the previous `settings.json` is automatically backed up to `settings.json.bak.<ISO-timestamp>` (if you regret the change, `cp <backup> ~/.claude/settings.json` restores it; the timestamp guarantees repeated runs of setup-hooks won't lose history).

The bash wrapper `bin/multi-cc-im` automatically uses the workspace's `tsx` / built `dist/cli.js` (Node 22–24 default cannot resolve TS-ESM-style `import './foo.js'` → `./foo.ts`).

cc must subscribe to 3 hook events: `SessionStart` populates the `paneToSession` map, `Stop` carries the assistant reply into the bridge router for forwarding to WeChat, `SessionEnd` drives the `PaneAlive` signal. Earlier versions also subscribed to `UserPromptSubmit` / `PreToolUse` / `PostToolUse` for analytics, but cc's own transcript jsonl (`~/.claude/projects/<dir>/<sid>.jsonl`) already records that data — multi-cc-im no longer duplicates it. Future analytics work should read cc's transcript directly via the `transcript_path` field in each `SessionStart` payload.

If you'd rather edit by hand (without `setup-hooks`): copy the `hooks` block from [`examples/claude-settings.json`](examples/claude-settings.json) into `~/.claude/settings.json` and `sed`-replace `ABS_PATH`:

```bash
sed "s|ABS_PATH|$(pwd)|g" examples/claude-settings.json
```

> v2 will add a global `multi-cc-im` command (tsup bundle + `npm publish` / `pnpm link --global`); the hook command will simplify to `multi-cc-im hook <event>` without depending on absolute paths.

### 5. Start the bridge daemon

```bash
./bin/multi-cc-im start
```

Long-running background process: iLink long-polling + watching `~/.multi-cc-im/state/` for cc hook events + routing WeChat `IncomingMessage` to the cc TUI. `Ctrl+C` triggers a graceful shutdown (releases all adapters; the in-memory `current_session` sticky pointer is lost — re-`@<name>` from WeChat after restart).

The state/ directory is **monitor-only** — it never accumulates cc conversation content (cc's own transcript jsonl at `~/.claude/projects/<dir>/<sid>.jsonl` already records that data). Per-session footprint:

| File | Lifetime | Daemon role |
|---|---|---|
| `<sid>.SessionStart` | cc startup → cleanup sweep | Read at SessionStart hook; tells daemon paneId + transcript_path |
| `<sid>.Stop.<ts>` | <100 ms (daemon reads + forwards + unlinks) | Bridge for cc → WeChat reply forwarding |
| `<sid>.SessionEnd` | cc exit → cleanup sweep (0-byte tombstone) | Marks cc dead so daemon stops routing to it |
| `wechat-cursor` | persistent | iLink long-poll cursor (don't lose messages on restart) |

Daemon startup runs a sweep that deletes paired `SessionStart` + `SessionEnd` (= cc lifecycle complete), orphan `Stop.<ts>` (= daemon-down accumulation that can't be forwarded), and any legacy state files from pre-redesign installs. To trigger the same sweep manually (e.g. when daemon has been running for weeks and `state/` accumulated dead-session pairs):

```bash
./bin/multi-cc-im cleanup --dry-run    # preview what would be deleted
./bin/multi-cc-im cleanup              # actually delete
```

Safe to run while daemon is running — only deletes sessions that already have a `SessionEnd` tombstone (cc already dead, daemon already stopped routing to it).

### 6. Name your cc sessions (recommended)

Once cc is running, use its built-in `/rename` command to give the session a friendly name:

```
/rename frontend
```

cc persists the name to its session state (so `claude --resume` restores it) and pushes it to the wezterm tab title via OSC. multi-cc-im polls `wezterm cli list --format json` on every IM event and uses that title as the routing key:

- WeChat `@frontend hello` → routes to the cc whose tab title is `frontend`
- WeChat `→ frontend received` echo confirms the routing
- cc reply forwarded back to WeChat is prefixed with `[frontend]` so you can tell sessions apart

**Without `/rename`**, multi-cc-im falls back to a short session-id hash like `$1813fd32` and appends a one-time hint pointing you at `/rename`. Tab title polling is real-time — rename and the new name shows up on the next IM round-trip with no daemon restart.

`multi-cc-im` is a reserved name. The router refuses to match it against any cc; instead `@multi-cc-im` is the namespace for bridge commands (see below).

## Routing syntax (user perspective)

Per [DD: routing syntax G'](docs/superpowers/specs/2026-05-04-routing-syntax-dd.md), with two updates from the original DD: (a) the routing key is now the wezterm tab title (cc `/rename`) rather than a config-file `[friendly_names]` map, (b) bridge commands are addressed via `@multi-cc-im /<cmd>` instead of bareword `@list` / `@help` / `@current` keywords (which collided with cc tab titles).

| What you send in WeChat | What it does |
|---|---|
| `hello` | Routes to `current_session` (last-explicit-mention sticky; with a single cc, automatically = that one) |
| `@frontend hello` | Routes to the session whose tab title is `frontend`, and sets `current` |
| `@fr hello` | Short prefix (5-level fallback: `$<sid-prefix>` → `=strict` → exact → prefix → glob); ambiguity lists candidates and rejects |
| `@$1813fd32 hello` | Strict id-prefix match (always available even when no `/rename` was done) |
| `@frontend @api sync` | Multi-target dispatch; **does not change `current`** |
| `@frontend /clear` | Forwards `/clear` into the cc TUI — cc handles it as its own slash command |
| `@all stop everything` | Broadcast to every live session |
| `@multi-cc-im /list` | List alive cc sessions (tab title + `$sid8` + pane id). The bot echoes; nothing dispatched to any cc |
| `@multi-cc-im /help` | Built-in help text |
| `@multi-cc-im /current` | Show / clear stale `current_session` |

Before dispatching to cc, the bot sends a visible echo to WeChat for every routed message (e.g. `→ frontend received`). This is mandated by the CLAUDE.md "Routing must have visible echo" rule.

## Tool permission gate (PreToolUse → IM forward)

When a cc session needs your approval to run a tool (e.g. `Bash`, `Edit`), the bridge forwards the prompt to WeChat instead of blocking on the cc TUI:

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 30 秒内回复，否则默认放行:
  @frontend /1   = 允许
  @frontend /2   = 拒绝
```

You reply with two characters:

| Reply in WeChat | Effect |
|---|---|
| `@frontend /1` | Allow — cc proceeds with the tool call |
| `@frontend /2` | Deny — cc cancels and asks for an alternative |
| (no reply within 30s) | Default allow — cc proceeds |

This works only when the most recent message **to that cc** came from WeChat. If you typed directly into the cc TUI, the gate is silently skipped (the hook still fires, hits the 30s timeout, and default-allows). The 30-second window is fixed by design — long enough to read the prompt on phone, short enough not to block cc indefinitely if you're away from your phone.

## Project Structure

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/         CLI binary: start / login wechat / hook <event>
└── packages/
    ├── shared/              4-dimensional adapter interfaces (IM/Term/CLI/Storage) + types + zod
    ├── storage-files/       atomic-write / cursor / config / pending-queue / credential
    ├── im-wechat/           IMAdapter(wechat) + iLink protocol vendor (Tencent/openclaw-weixin v2.1.7)
    ├── term-wezterm/        TermAdapter(wezterm) + PaneAlive 4-signal state machine
    ├── cli-cc/              CLIAdapter(cc) + hook payload zod + state files + injection queue
    └── bridge/              router with 4-level fallback / SessionRegistry / orchestrator
```

Every package has a `src/` directory plus tests; `pnpm test` runs the full suite of 700+ unit tests with coverage ≥ 80% on every dimension.

## Documentation

| File | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **Mandatory hard constraints**: core rules / DD process / key conventions / coding behavior / forbidden list |
| [docs/architecture.md](docs/architecture.md) | Architecture diagram / package dependencies / data storage / external CLI path policy |
| [docs/dev.md](docs/dev.md) | Development commands + TDD rhythm |
| [docs/competitors.md](docs/competitors.md) | End-to-end projects we considered but did not adopt (decision record) |
| [docs/superpowers/specs/](docs/superpowers/specs/) | 8 DD reports (protocol / hook / adapter / storage / pricing / pane-alive / keychain / routing) |

## Development

```bash
pnpm install
pnpm typecheck                       # 8 workspaces tsc --noEmit
pnpm test                            # 56 files / 713 tests
pnpm test:coverage                   # same + v8 coverage (80% threshold on every dimension)
pnpm --filter multi-cc-im build      # tsup bundle → apps/multi-cc-im/dist/cli.js
pnpm --filter multi-cc-im dev <cmd>  # tsx src/cli.ts (no build needed; dev-time alias)
```

TDD rhythm (red → green → refactor), 5-step DD process for major decisions, no AI-author attribution in any commit / PR — see [CLAUDE.md](CLAUDE.md) "Key conventions" and [docs/dev.md](docs/dev.md).

## License

MIT
