# multi-cc-im

A personal local bridge that exposes **multiple Claude Code (cc) sessions running in WezTerm tabs** to WeChat via Tencent's iLink Bot API. Use the terminal in the office, WeChat outside, both at once. Includes `@session` routing, IM-side tool permission gate (PreToolUse → WeChat reply with `/1` allow / `/2` deny), and a pluggable architecture for additional IMs / terminals / CLIs.

> **Status**: v1.1 implementation complete (2026-05-07) — 7 packages + 1 app shipped (`apps/multi-cc-im/` is the executable CLI). 58 test files / 821 unit tests / coverage ≥ 80%. Remaining follow-ups: real-environment WezTerm + cc + WeChat end-to-end smoke test, Telegram / Lark IM adapters, analytics package.

---

## Who this is for

You'll get value from multi-cc-im if **all** of these are true:

1. You run cc inside WezTerm (one or more tabs).
2. You sometimes step away from your desk and want to keep nudging cc from your phone.
3. You're OK using your own WeChat as the bot endpoint (it's a personal bridge — single owner, one machine).

You will **not** get value if:

- You don't use cc, or you use it inside VS Code / Cursor / iTerm (term adapter is wezterm-only in v1).
- You want a multi-tenant SaaS — multi-cc-im is local-only by design.
- You don't have a WeChat account (Telegram / Lark adapters are on the roadmap, not yet shipped).

---

## How it feels

```
You at the office:      [cc TUI in WezTerm tab "frontend"]
You on the bus:         WeChat → "@frontend run the tests"
                        WeChat ← "→ frontend received"
                        ... cc runs, replies ...
                        WeChat ← "[frontend] all 47 tests pass."
                  
cc wants to run Bash:   WeChat ← "[frontend] 准备跑工具:
                                    Bash(rm -rf node_modules)
                                  ⏳ 30 秒内回复，否则默认放行:
                                    @frontend /1   = 允许
                                    @frontend /2   = 拒绝"
You:                    WeChat → "@frontend /2"
                        WeChat ← "→ frontend permission 拒绝"
                        ... cc cancels and asks you something else ...
```

The cc TUI in your WezTerm tab is **untouched** the whole time — multi-cc-im never spawns cc, never wraps stdin/stdout. You can sit down at your laptop and keep typing into the same cc session as if WeChat never happened.

---

## Quick Start

### 1. Install WezTerm (one-time)

```bash
brew install --cask wezterm
```

multi-cc-im probes the WezTerm path at startup and caches it to `~/.multi-cc-im/config.toml [external_paths].wezterm`. Hardcoded paths are forbidden — see [docs/architecture.md "External CLI tool path policy"](docs/architecture.md#外部-cli-工具路径策略).

### 2. Install multi-cc-im

```bash
git clone https://github.com/orime-org/multi-cc-im.git
cd multi-cc-im
pnpm install
pnpm typecheck && pnpm test            # optional verification (~5s, 821 unit tests)
pnpm --filter multi-cc-im build        # recommended — see "production vs dev" below
```

The CLI entry point is the `bin/multi-cc-im` bash wrapper. **Production mode** (recommended): after `pnpm build` the wrapper auto-uses `apps/multi-cc-im/dist/cli.js` (~50 ms startup). **Dev mode**: when the bundle is absent, falls back to `tsx src/cli.ts` (~300–1500 ms startup). cc hooks fire several times per assistant turn — **production mode is required** in practice; otherwise typing latency from your phone is visible to the eye.

### 3. First-time WeChat login (QR scan)

```bash
./bin/multi-cc-im login wechat
# equivalent to: pnpm --filter multi-cc-im dev login wechat
```

The terminal prints a QR code; scan + confirm in WeChat → the bridge persists `bot_token` to `~/.multi-cc-im/credentials/wechat.json` (mode 0600, matching the Tencent OpenClaw vendor upstream; [DD: credentials persistence strategy](docs/superpowers/specs/2026-05-03-keychain-library-dd.md)). The token never lands in git, log files, console output, or any non-0600 location.

### 4. Configure cc hooks (one-time per cc setup)

```bash
./bin/multi-cc-im setup-hooks
```

Idempotent merge — auto-detects the current state of `~/.claude/settings.json` and writes multi-cc-im's **4 hook commands** (using the current repo's absolute path):

- File missing → create
- Exists but empty `{}` or no `hooks` field → add hooks
- Already has other tools' hooks → preserve them, append multi-cc-im's 4
- Already has stale multi-cc-im hooks (e.g. you moved the repo) → replace with the current path's 4

The 4 events:

| Event | Purpose |
|---|---|
| `SessionStart` | Populates the `paneToSession` map (which cc lives in which wezterm pane) |
| `PreToolUse` | Forwards tool permission prompts to WeChat (`/1` allow / `/2` deny, 30s timeout default-allow) — `matcher: "*"`, `timeout: 30` |
| `Stop` | Carries the assistant reply into the bridge router for forwarding to WeChat |
| `SessionEnd` | Drives the `PaneAlive` death signal so daemon stops routing to dead cc sessions |

`UserPromptSubmit` and `PostToolUse` are **not** subscribed — cc's own transcript jsonl (`~/.claude/projects/<dir>/<sid>.jsonl`) already records that data; future analytics work should read it directly.

**Safety**: before writing, the previous `settings.json` is automatically backed up to `settings.json.bak.<ISO-timestamp>` (if you regret the change, `cp <backup> ~/.claude/settings.json` restores it).

If you'd rather edit by hand: copy the `hooks` block from [`examples/claude-settings.json`](examples/claude-settings.json) into `~/.claude/settings.json` and `sed`-replace `ABS_PATH`:

```bash
sed "s|ABS_PATH|$(pwd)|g" examples/claude-settings.json
```

### 5. Start the bridge daemon

```bash
./bin/multi-cc-im start
```

Long-running background process: iLink long-polling + watching `~/.multi-cc-im/state/` for cc hook events + routing WeChat `IncomingMessage` to the cc TUI. `Ctrl+C` triggers a graceful shutdown (releases all adapters; the in-memory `current_session` sticky pointer is lost — re-`@<name>` from WeChat after restart).

The state/ directory is **monitor-only** — it never accumulates cc conversation content (cc's own transcript jsonl is already source of truth). Per-session footprint:

| File | Lifetime | Daemon role |
|---|---|---|
| `<sid>.SessionStart` | cc startup → cleanup sweep | Read at SessionStart hook; tells daemon paneId + transcript_path |
| `<sid>.Stop.<ts>` | <100 ms (daemon reads + forwards + unlinks) | Bridge for cc → WeChat reply forwarding |
| `<sid>.SessionEnd` | cc exit → cleanup sweep (0-byte tombstone) | Marks cc dead so daemon stops routing to it |
| `<sid>.PermissionRequest.<id>.json` | PreToolUse fire → hook subprocess cleanup (≤30s) | Hook subprocess writes; daemon reads + forwards prompt to IM |
| `<sid>.PermissionResponse.<id>.json` | IM user replies → hook subprocess cleanup | Daemon writes after `@<tab> /1` or `/2`; hook subprocess polls to unblock |
| `wechat-cursor` | persistent | iLink long-poll cursor (don't lose messages on restart) |

Daemon startup runs a sweep that deletes paired `SessionStart` + `SessionEnd` (= cc lifecycle complete), orphan `Stop.<ts>` (= daemon-down accumulation that can't be forwarded), orphan permission files (= hook subprocess killed mid-flow), and any legacy state files from pre-redesign installs. To trigger the same sweep manually:

```bash
./bin/multi-cc-im cleanup --dry-run    # preview what would be deleted
./bin/multi-cc-im cleanup              # actually delete
```

Safe to run while daemon is running — only deletes sessions that already have a `SessionEnd` tombstone.

### 6. Name your cc sessions (recommended)

Once cc is running, use its built-in `/rename` command to give the session a friendly name:

```
/rename frontend
```

cc persists the name to its session state (so `claude --resume` restores it) and pushes it to the wezterm tab title via OSC. multi-cc-im polls `wezterm cli list --format json` on every IM event and uses that title as the routing key:

- WeChat `@frontend hello` → routes to the cc whose tab title is `frontend`
- WeChat echo `→ frontend received` confirms the routing
- cc reply forwarded back to WeChat is prefixed with `[frontend]` so you can tell sessions apart

**Without `/rename`**, multi-cc-im falls back to a short session-id hash like `$1813fd32` and appends a one-time hint pointing you at `/rename`. Tab title polling is real-time — rename and the new name shows up on the next IM round-trip with no daemon restart.

`@multi-cc-im` is a reserved name. The router refuses to match it against any cc; instead it's the namespace for bridge commands (see below).

---

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
| `@frontend /1` | **Permission allow** (only when there's a pending PreToolUse — see below) |
| `@frontend /2` | **Permission deny** |
| `@multi-cc-im /list` | List alive cc sessions (tab title + `$sid8` + pane id). The bot echoes; nothing dispatched to any cc |
| `@multi-cc-im /help` | Built-in help text |
| `@multi-cc-im /current` | Show / clear stale `current_session` |

Before dispatching to cc, the bot sends a visible echo to WeChat for every routed message (e.g. `→ frontend received`). This is mandated by the CLAUDE.md "Routing must have visible echo" rule.

---

## Tool permission gate (PreToolUse → IM forward)

Per [DD: permission forward](docs/superpowers/specs/2026-05-07-permission-forward-dd.md). When a cc session needs your approval to run a tool (e.g. `Bash`, `Edit`, `Write`), the bridge forwards the prompt to WeChat instead of blocking on the cc TUI:

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
| `@frontend /2` | Deny — cc cancels and asks you for an alternative |
| (no reply within 30s) | Default allow — cc proceeds |

This works only when the most recent message **to that cc** came from WeChat (i.e. you bound a wechat reply context by `@frontend <body>` recently). If you typed directly into the cc TUI, the gate is silently skipped: the hook still fires, hits the 30s timeout, and default-allows. The 30-second window is fixed — long enough to read the prompt on phone, short enough not to block cc indefinitely if your phone is unreachable.

**No allowlist / blocklist by design.** If you want to make cc stop asking about a particular command, do it in the cc TUI (option 2 — "Yes, and don't ask again for similar commands in `<cwd>`"). cc TUI writes the rule to project-local `.claude/settings.local.json`. multi-cc-im won't replicate this remotely (would mean the daemon writing user dotfiles based on remote IM input — too risky).

---

## How it works under the hood

(For developers / contributors. See [docs/architecture.md](docs/architecture.md) for full schemas.)

```
                                 4 maintenance dimensions
       ┌────────┐    iLink long-poll     ┌────────┐
WeChat │  IM    │ ──────────────────► ┌──┤ bridge │
client │adapter │ ◄────────────────── │  │  core  │
       └────────┘  iLink send (reply) │  │        │
                                      │  │ router │
       ┌────────┐  wezterm cli send-text │ matcher │
WezTerm│ Term   │ ◄─────────────────── │  │ session│
tabs   │adapter │     (Step 1 paste +  │  │registry│
       │+PaneAl │      Step 2 \r submit)│  │parser  │
       └────────┘                      │  │        │
                                       │  └────────┘
       ┌────────┐  hook stdin / stdout │
cc     │  CLI   │ ◄─────────────────── ┘
hooks  │adapter │       chokidar watch state files
       │+ state │ ◄─────────────────── 
       └────────┘
                                       
       ┌────────────┐
       │ Storage    │  toml + 0600 JSON + state files (no SQL DB)
       │ adapter    │  
       └────────────┘
```

3 main data flows wired by the **bridge orchestrator**:

1. **Inbound** (WeChat → cc): `IM long-poll → router.parse → matcher (5-level fallback) → orchestrator.dispatch → term.sendText (Step 1) + sleep + sendKeystroke '\r' (Step 2)`. The two-step send is mandatory — single-step `--no-paste $'\r'` injection lets cc TUI interpret keystrokes ([DD: hook+wezterm probe](docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)).

2. **Outbound** (cc Stop hook → WeChat): cc fires Stop hook → hook subprocess writes `<sid>.Stop.<ts>` → daemon's chokidar picks it up → looks up the **one-shot** `pendingReplyCtxBySession[sid]` → IM send + delete pending. ONE-SHOT means subsequent Stops without a fresh wechat dispatch are not forwarded back — protects you from cc TUI typing accidentally going to WeChat.

3. **Permission gate** (PreToolUse → IM `/1` `/2` → hook subprocess unblock): hook subprocess writes `PermissionRequest`, polls `PermissionResponse` every 200ms (max 30s). Daemon forwards the prompt to IM. User reply → daemon writes `PermissionResponse`. Hook subprocess reads → emits `permissionDecision: allow|deny` to cc → exits.

All cc sessions are **owned by the same WeChat account** (your own — owner-only ACL is enforced by the iLink protocol layer). multi-cc-im runs on **one machine** only ([CLAUDE.md "Multi-machine: only one"](CLAUDE.md) — iLink `getupdates` cursor is global, multi-instance polling would steal each other's messages).

---

## Project Structure

```
multi-cc-im/
├── apps/
│   └── multi-cc-im/         CLI binary: start / login / setup-hooks / cleanup / hook
└── packages/
    ├── shared/              4-dimensional adapter interfaces (IM/Term/CLI/Storage) + types + zod
    ├── storage-files/       atomic-write / cursor / config / pending-queue / credential
    ├── im-wechat/           IMAdapter(wechat) + iLink protocol vendor (Tencent/openclaw-weixin v2.1.7)
    ├── term-wezterm/        TermAdapter(wezterm) + PaneAlive multi-signal state machine
    ├── cli-cc/              CLIAdapter(cc) + hook payload zod + state files + injection queue
    ├── bridge/              router with 5-level fallback / SessionRegistry / orchestrator
    └── openclaw/            minimal shim for the Tencent/openclaw-weixin plugin SDK
```

Every package has a `src/` directory plus tests; `pnpm test` runs all 821 unit tests with coverage ≥ 80% on every dimension.

---

## Documentation

| File | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | **Mandatory hard constraints**: core rules / DD process / key conventions / coding behavior / forbidden list |
| [docs/architecture.md](docs/architecture.md) | Architecture diagram / package dependencies / data storage / 3 key data flows / external CLI path policy |
| [docs/dev.md](docs/dev.md) | Development commands + TDD rhythm + debugging tips |
| [docs/competitors.md](docs/competitors.md) | End-to-end projects considered but not adopted (decision record) |
| [docs/superpowers/specs/](docs/superpowers/specs/) | DD reports (protocol / hook / adapter / storage / pricing / pane-alive / keychain / routing / permission forward) |

---

## Development

```bash
pnpm install
pnpm typecheck                        # 8 workspaces tsc --noEmit
pnpm test                             # 58 files / 821 unit tests
pnpm test:coverage                    # same + v8 coverage (80% threshold)
pnpm --filter multi-cc-im build       # tsup → apps/multi-cc-im/dist/cli.js
pnpm --filter multi-cc-im dev <cmd>   # tsx src/cli.ts (dev-time alias, no build)

# single-file test (TDD red→green loop)
pnpm exec vitest run packages/bridge/src/router.test.ts
pnpm exec vitest packages/bridge/src/router.test.ts        # watch mode
```

TDD rhythm (red → green → refactor), 5-step DD process for major decisions, no AI-author attribution in any commit / PR — see [CLAUDE.md](CLAUDE.md) "Key conventions" and [docs/dev.md](docs/dev.md).

---

## Troubleshooting

### `multi-cc-im start` fails with "wezterm CLI not found"

Either install wezterm (`brew install --cask wezterm`), or if you have it installed in an unusual location:

```bash
# write the path manually into ~/.multi-cc-im/config.toml
[external_paths]
wezterm = "/path/to/your/wezterm"
```

### daemon runs but WeChat doesn't receive my messages

```bash
# 1. tail the log
tail -f ~/.multi-cc-im/logs/multi-cc-im-$(date +%F).log

# 2. is the iLink cursor advancing?
ls -la ~/.multi-cc-im/state/wechat-cursor

# 3. is the bot_token still valid?
ls -la ~/.multi-cc-im/credentials/wechat.json   # should be -rw-------

# 4. did the cc hook actually fire?
ls ~/.multi-cc-im/state/   # expect <sid>.SessionStart files
```

If `<sid>.SessionStart` is missing → cc hooks aren't wired. Re-run `./bin/multi-cc-im setup-hooks`.

### `@frontend` says "not found" but cc is clearly running

multi-cc-im routes by **wezterm tab title**, not by directory. If your tab is still showing the default `cc` or just the cwd:

1. In the cc TUI, run `/rename frontend` (the name shows up in the wezterm tab title via OSC).
2. Send `@frontend hello` again — tab titles are re-polled on every IM event.

You can always fall back to the session id prefix: `@$1813fd32 hello` works even without `/rename`.

### `@frontend /1` doesn't unblock the cc tool prompt

Three common causes (in order of likelihood):

1. **No wechat origin bound for that cc**. The permission forward only works when your most recent message **to that cc** came from WeChat. If you typed directly into the cc TUI and then cc decided to call a tool, no replyCtx exists in the daemon → daemon logs "no wechat origin" → hook 30s timeout default-allows. **Fix**: send `@frontend ping` from WeChat once to bind, then future PreToolUse prompts will reach you.
2. **You replied past the 30-second window**. Hook already exited with default-allow. Your `/1` is lost (no polling subprocess to read the response file — daemon's startup sweep cleans the orphan).
3. **You forgot the tab name**. Bare `/1` with no `@<tabname>` is treated as plain content, not a permission response. Even with one cc running, `@<tabname> /1` is required.

### setup-hooks complains about existing hooks

setup-hooks **never destroys** existing non-multi-cc-im hooks; it merges. If you see weird state, two recovery paths:

```bash
# A. revert to last setup-hooks backup
ls -la ~/.claude/settings.json.bak.*
cp ~/.claude/settings.json.bak.<latest-ISO> ~/.claude/settings.json

# B. nuke + redo (lose any bespoke cc hooks you added by hand)
mv ~/.claude/settings.json ~/.claude/settings.json.before-redo
./bin/multi-cc-im setup-hooks
```

### state/ directory accumulating files

This is normal during long daemon uptime. Run `./bin/multi-cc-im cleanup --dry-run` to preview; `./bin/multi-cc-im cleanup` to delete. Safe to run with daemon up.

### Risk note: WeChat account ban

iLink Bot API talks to WeChat through Tencent's official protocol — far safer than 灰产 / iPad protocols (which **will** get your account flagged). But "personal bridge" use cases still carry small per-account risk if traffic is unusual. Mitigations:

- Use a secondary WeChat account if your primary is critical.
- Don't blast > 1 message/sec; multi-cc-im paces requests but bot rate limits exist on Tencent's side.
- Don't proxy others' messages through your bot (owner-only ACL is enforced at the protocol layer for this exact reason).

---

## License

MIT
