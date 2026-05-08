# multi-cc-im

**English** | [中文](README.zh-CN.md)

A personal local bridge that exposes **multiple Claude Code (cc) sessions running in WezTerm tabs** to WeChat via Tencent's iLink Bot API. Use the terminal in the office, WeChat outside, both at once. Includes `@session` routing, IM-side tool permission gate (PreToolUse → WeChat reply with `/1` allow / `/2` deny), and a pluggable architecture for additional IMs / terminals / CLIs.

> **Status**: v1.4 implementation complete — 7 packages + 1 app shipped (`apps/multi-cc-im/` is the executable CLI). v1.2 added IMWork (manual remote-mode toggle) + IMOrigin (IM reply ctx) + read-only tool allowlist + daemon reaper; v1.3 added daemon-liveness PID lock (`state/daemon.pid`) + double-start guard + Ctrl+C cleanup; v1.4 collapsed cc hook subscriptions to `PreToolUse` + `Stop` only and switched to **pane-keyed state files** (`<paneId>_<sid>.*` / `<paneId>.IMOrigin`) with `wezterm cli list` as the live-pane ground truth — no more PaneAlive multi-signal state machine ([DD: pane-keyed state files](docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)). Remaining follow-ups: real-environment WezTerm + cc + WeChat end-to-end smoke test, Telegram / Lark IM adapters, analytics package.

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
                                  ⏳ 10 秒内回复，否则默认放行:
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
pnpm typecheck && pnpm test            # optional verification (~5s, 903 unit tests)
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

Idempotent merge — auto-detects the current state of `~/.claude/settings.json` and writes multi-cc-im's **2 hook commands** (using the current repo's absolute path):

- File missing → create
- Exists but empty `{}` or no `hooks` field → add hooks
- Already has other tools' hooks → preserve them, append multi-cc-im's 2
- Already has stale multi-cc-im hooks (e.g. you moved the repo) → replace with the current path's 2

The 2 events:

| Event | Purpose |
|---|---|
| `PreToolUse` | Forwards tool permission prompts to WeChat (`/1` allow / `/2` deny, 10s timeout default-allow) — `matcher: "*"`, `timeout: 10` |
| `Stop` | Carries the assistant reply into the bridge router for forwarding to WeChat |

`SessionStart` / `SessionEnd` / `UserPromptSubmit` / `PostToolUse` are **not** subscribed. The hook entry checks `process.env.WEZTERM_PANE` first — if it's undefined, the hook silently exits (cc isn't running inside wezterm — e.g. ssh, VS Code terminal — so multi-cc-im has nothing to bridge). When defined, the paneId becomes part of every state-file name (see [State files reference](#state-files-reference)). cc's own transcript jsonl (`~/.claude/projects/<dir>/<sid>.jsonl`) is the source of truth for conversation content; analytics work reads it directly.

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

The `state/` directory is **monitor-only** — it never accumulates cc conversation content (cc's own transcript jsonl is already source of truth). It holds a small set of short-lived hook-↔-daemon IPC files keyed by `<paneId>` (the live wezterm pane id) plus three top-level lock / state files (`IMWork`, `daemon.pid`, `wechat-cursor`). Full schema reference is at the bottom of this README ([State files reference](#state-files-reference)).

Daemon startup runs a sweep that uses `wezterm cli list --format json` as the live-pane ground truth: any `<paneId>_<sid>.*` or `<paneId>.IMOrigin` file whose paneId is **not** in the current live set is cleaned, plus stale `daemon.pid` (PID dead or lstart mismatch) and any legacy state files from pre-redesign installs. To trigger the same sweep manually:

```bash
./bin/multi-cc-im cleanup --dry-run    # preview what would be deleted
./bin/multi-cc-im cleanup              # actually delete
```

Safe to run while daemon is running — files for live paneIds are kept. The command refuses to run when the wezterm path can't be resolved (without a live-pane snapshot the sweep has no ground truth and won't blindly delete).

### 6. Name your cc sessions (recommended)

Once cc is running, use its built-in `/rename` command to give the session a friendly name:

```
/rename frontend
```

cc persists the name to its session state (so `claude --resume` restores it) and pushes it to the wezterm tab title via OSC. multi-cc-im polls `wezterm cli list --format json` on every IM event and uses that title as the routing key:

- WeChat `@frontend hello` → routes to the cc whose tab title is `frontend`
- WeChat echo `→ frontend received` confirms the routing
- cc reply forwarded back to WeChat is prefixed with `[frontend]` so you can tell sessions apart

**Without `/rename`**, the cc has no addressable name — the router echoes `未 /rename` and refuses to dispatch. Tab title polling is real-time — rename and the new name shows up on the next IM round-trip with no daemon restart. (Numeric tab titles trigger a warning in the `/start` echo because they look like wezterm pane ids and would confuse the matcher.)

`@multi-cc-im` is a reserved name. The router refuses to match it against any cc; instead it's the namespace for bridge commands (see below).

---

## Routing syntax (user perspective)

Per [DD: routing syntax G'](docs/superpowers/specs/2026-05-04-routing-syntax-dd.md), with two updates from the original DD: (a) the routing key is now the wezterm tab title (cc `/rename`) rather than a config-file `[friendly_names]` map, (b) bridge commands are addressed via `@multi-cc-im /<cmd>` instead of bareword `@list` / `@help` / `@current` keywords (which collided with cc tab titles).

| What you send in WeChat | What it does |
|---|---|
| `hello` | Routes to `current_session` (last-explicit-mention sticky; with a single cc, automatically = that one) |
| `@frontend hello` | Routes to the session whose tab title is `frontend`, and sets `current` |
| `@fr hello` | Short prefix (4-level fallback: `=strict` → exact → prefix → glob); ambiguity lists candidates and rejects |
| `@frontend @api sync` | Multi-target dispatch; **does not change `current`** |
| `@frontend /clear` | Forwards `/clear` into the cc TUI — cc handles it as its own slash command |
| `@all stop everything` | Broadcast to every live session |
| `@frontend /1` | **Permission allow** (only when there's a pending PreToolUse — see below) |
| `@frontend /2` | **Permission deny** |
| `@multi-cc-im /list` | List alive cc sessions (tab title + pane id). The bot echoes; nothing dispatched to any cc |
| `@multi-cc-im /help` | Built-in help text |
| `@multi-cc-im /current` | Show `current_session` + IMWork status |
| `@multi-cc-im /start` | **Enable IM mode** (cc tool prompts will forward to WeChat) |
| `@multi-cc-im /stop` | **Disable IM mode** (cc tool prompts shown in cc TUI) |

Before dispatching to cc, the bot sends a visible echo to WeChat for every routed message (e.g. `→ frontend received`). This is mandated by the CLAUDE.md "Routing must have visible echo" rule.

---

## IM mode toggle: `/start` and `/stop` (manual switch)

Per [DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md). multi-cc-im has a global on/off switch that you control from WeChat:

```
@multi-cc-im /start    →  IM mode ON (cc tool prompts forward to WeChat)
@multi-cc-im /stop     →  IM mode OFF (cc tool prompts handled in TUI)
@multi-cc-im /current  →  show current target + IMWork status
```

- **Daemon start always resets to OFF**. You must explicitly `/start` from WeChat each session you go remote.
- When **OFF**, IM messages addressed to cc (`@frontend hello` etc.) are rejected with `"❌ IMWork off — 请先发 @multi-cc-im /start 开启 IM 模式"`. Bridge commands and permission responses still work.
- When **ON**, the `/start` echo lists currently alive cc sessions and the rules so you know what's available.

This is the master switch. The per-session forwarding behavior (next section) only kicks in when IMWork is on.

## Tool permission gate (PreToolUse → IM forward)

Per [DD: permission forward](docs/superpowers/specs/2026-05-07-permission-forward-dd.md) + [DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md). When IMWork is on **and** you've recently chatted with a cc from WeChat, that cc's tool approval prompts forward to WeChat:

```
[frontend] 准备跑工具:
  Bash(rm -rf node_modules)

⏳ 10 秒内回复，否则默认放行:
  @frontend /1   = 允许
  @frontend /2   = 拒绝
```

You reply with two characters:

| Reply in WeChat | Effect |
|---|---|
| `@frontend /1` | Allow — cc proceeds with the tool call |
| `@frontend /2` | Deny — cc cancels and asks you for an alternative |
| (no reply within 10s) | Default allow — cc proceeds |

The hook decision tree (in order, cheapest check first):

1. **Read-only tool** (`Read` / `Grep` / `Glob` / `NotebookRead`) → auto-allow, no IM forward (cc itself doesn't show TUI menu for these — forwarding would just spam IM).
2. **IMWork off** → cc TUI shows its native permission menu (the 3-option `Yes / Yes don't ask again / No`). You decide locally on the keyboard.
3. **IMWork on but no IM thread bound for this cc** (you haven't `@<tab>`'d it from WeChat) → falls back to cc TUI menu.
4. **Daemon not running** (Ctrl+C'd / crashed / never started) → falls back to cc TUI menu — no point waiting on a 10s timeout when no one's listening ([DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)).
5. **Otherwise** → forward to WeChat with 10s window.

So one cc can flip between "cc TUI menu" and "IM round-trip" turn-by-turn:

- You're at the office, type directly in cc TUI → IMWork off → menu in TUI ✓
- You step out, send `@multi-cc-im /start` then `@frontend run tests` → IMWork on + IMOrigin set → next tool prompt comes to your phone ✓
- cc finishes a turn → IMOrigin auto-deletes → if cc autonomously calls another tool → no IMOrigin → falls back to TUI menu (you're still on phone but cc has no thread to reply to)

**No allowlist / blocklist by design.** If you want to make cc stop asking about a particular command, do it in the cc TUI (option 2 — "Yes, and don't ask again for similar commands in `<cwd>`"). cc TUI writes the rule to project-local `.claude/settings.local.json`. multi-cc-im won't replicate this remotely (would mean the daemon writing user dotfiles based on remote IM input — too risky).

---

## How it works under the hood

(For developers / contributors. See [docs/architecture.md](docs/architecture.md) for full schemas.)

```
                                 4 adapter dimensions
       ┌────────┐    iLink long-poll     ┌────────┐
WeChat │  IM    │ ──────────────────► ┌──┤ bridge │
client │adapter │ ◄────────────────── │  │  core  │
       └────────┘  iLink send (reply) │  │        │
                                      │  │ router │
       ┌────────┐  wezterm cli send-text │ matcher │
WezTerm│ Term   │ ◄─────────────────── │  │ (tab    │
tabs   │adapter │     (Step 1 paste +  │  │  title) │
       │listPan │      Step 2 \r submit)│  │ parser │
       └────────┘  wezterm cli list ─►  │  │        │
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

1. **Inbound** (WeChat → cc): `IM long-poll → wezterm cli list (live panes) → router.parse → matcher (4-level fallback against tab titles) → orchestrator.dispatch → write <paneId>.IMOrigin → term.sendText (Step 1) + sleep + sendKeystroke '\r' (Step 2)`. The two-step send is mandatory — single-step `--no-paste $'\r'` injection lets cc TUI interpret keystrokes ([DD: hook+wezterm probe](docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)).

2. **Outbound** (cc Stop hook → WeChat): hook entry first checks `process.env.WEZTERM_PANE` — undefined → silent exit. With `<paneId>` in hand, the subprocess checks 3 short-circuit guards (no `IMWork` / no `<paneId>.IMOrigin` / daemon dead → return void without writing). If all pass, writes `<paneId>_<sid>.Stop.<ts>` → daemon's chokidar picks it up → reads `<paneId>.IMOrigin` (the per-pane reply ctx persisted on disk) → IM send → deletes IMOrigin (one-shot). ONE-SHOT means a fresh `@<tab> body` from WeChat is required before each cc reply forwards back — protects you from cc TUI typing accidentally going to WeChat.

3. **Permission gate** (PreToolUse → IM `/1` `/2` → hook subprocess unblock): hook subprocess walks the decision tree above. If it reaches the forward step, it writes `<paneId>_<sid>.PermissionRequest.<id>.json`, polls `<paneId>_<sid>.PermissionResponse.<id>.json` every 200ms (max 10s). Daemon forwards the prompt to IM. User reply → daemon writes the response file. Hook subprocess reads → emits `permissionDecision: allow|deny` to cc → unlinks both files → exits. Daemon-side reaper schedules a backstop unlink at 10s for orphan files (in case the hook subprocess died abnormally).

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
    ├── term-wezterm/        TermAdapter(wezterm) + listPanes capability (wezterm cli list as ground truth)
    ├── cli-cc/              CLIAdapter(cc) + hook payload zod + pane-keyed state files + injection queue
    ├── bridge/              router with 4-level fallback / orchestrator (paneId-keyed)
    └── openclaw/            minimal shim for the Tencent/openclaw-weixin plugin SDK
```

Every package has a `src/` directory plus tests; `pnpm test` runs the full suite with coverage ≥ 80% on every dimension.

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
pnpm test                             # vitest unit suite
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
ls ~/.multi-cc-im/state/   # expect <paneId>_<sid>.Stop.* or <paneId>.IMOrigin files after a turn
```

If nothing matching `<paneId>_*` shows up after cc completes a turn → cc hooks aren't wired (or you're running cc outside wezterm — `WEZTERM_PANE` is unset and the hook silently exits). Re-run `./bin/multi-cc-im setup-hooks`.

### `@frontend` says "not found" but cc is clearly running

multi-cc-im routes by **wezterm tab title**, not by directory or session id. If your tab is still showing the default `cc` or just the cwd:

1. In the cc TUI, run `/rename frontend` (the name shows up in the wezterm tab title via OSC).
2. Send `@frontend hello` again — tab titles are re-polled on every IM event via `wezterm cli list --format json`.

Without `/rename` there is **no** addressable name (no sid-prefix fallback in v1.4 — the routing key is purely the tab title). `@multi-cc-im /list` shows you what's currently addressable.

### IM doesn't receive tool permission prompts (`@frontend /1` never gets asked for)

Four common causes (in order of likelihood):

1. **You haven't `/start`'d**. Daemon starts in local mode by default (cc TUI handles approvals). **Fix**: send `@multi-cc-im /start` from WeChat once.
2. **No IM thread bound for that cc**. Even with IMWork on, you must have **chatted with that specific cc from WeChat at least once** in the current turn. If cc autonomously calls a tool without you ever `@<tab>`'ing it, the hook falls back to cc TUI menu. **Fix**: send `@frontend ping` once to bind a thread.
3. **The tool is read-only**. cc calls Read / Grep / Glob / NotebookRead and similar without needing approval — multi-cc-im also auto-allows these to keep IM uncluttered. Only "destructive" tools (Bash / Edit / Write / WebFetch / etc.) trigger the IM forward.
4. **You replied past the 10-second window**. Hook already exited with default-allow. Your `/1` is lost (the polling subprocess gone — daemon reaper cleans up the orphan files within 10s).

### `@frontend /1` reply doesn't take effect

- **Forgot the tab name**: bare `/1` with no `@<tabname>` is treated as plain content, not a permission response. Even with one cc running, `@<tabname> /1` is required.
- **Past the window**: same as #4 above — 10s default-allow already fired.

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

### `multi-cc-im start` says "another daemon already running"

multi-cc-im enforces single-instance via `state/daemon.pid` (per [DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)). Two daemons polling iLink would steal each other's messages. Three recovery options:

```bash
# 1. If you genuinely have a daemon already running (you forgot about it):
pkill -f 'multi-cc-im start'
./bin/multi-cc-im start

# 2. If you're sure no daemon is running (e.g. previous one was SIGKILL'd):
rm ~/.multi-cc-im/state/daemon.pid
./bin/multi-cc-im start

# 3. If unsure, the error message gives you the PID — check what it actually is:
ps -p <pid> -o command=
# If output is `node ... multi-cc-im start` → real daemon, kill it
# Otherwise → PID was reused by some unrelated process; rm the lock file
```

The 3rd case is rare (PID reuse window in the home-dir-daemon scenario is huge), and the lock format includes a `startedAt` timestamp that detects this — if reused, multi-cc-im automatically overwrites without erroring.

### After Ctrl+C, IM still receives stale messages

Shouldn't — daemon stop deletes `IMWork` + `daemon.pid`, and hooks check both before forwarding. If you see stale forwards:

```bash
# verify lock files cleared
ls ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid 2>&1
# both should be "No such file or directory"

# if not, manually clean:
rm -f ~/.multi-cc-im/state/IMWork ~/.multi-cc-im/state/daemon.pid
```

If both files are gone but IM still routes, daemon is somehow still running — `pkill -f 'multi-cc-im start'` to be sure.

### state/ directory accumulating files

This is normal during long daemon uptime. Run `./bin/multi-cc-im cleanup --dry-run` to preview; `./bin/multi-cc-im cleanup` to delete. Safe to run with daemon up.

### Risk note: WeChat account ban

iLink Bot API talks to WeChat through Tencent's official protocol — far safer than 灰产 / iPad protocols (which **will** get your account flagged). But "personal bridge" use cases still carry small per-account risk if traffic is unusual. Mitigations:

- Use a secondary WeChat account if your primary is critical.
- Don't blast > 1 message/sec; multi-cc-im paces requests but bot rate limits exist on Tencent's side.
- Don't proxy others' messages through your bot (owner-only ACL is enforced at the protocol layer for this exact reason).

---

## State files reference

Everything multi-cc-im persists lives under `~/.multi-cc-im/state/`. The directory is **monitor-only**: cc's own transcript jsonl (`~/.claude/projects/<dir>/<sid>.jsonl`) is the source of truth for cc conversation content; multi-cc-im just bridges hook subprocesses ↔ daemon over short-lived files. All writes go through the storage-files atomic-write helper (mode-0600, same-dir tmp + fsync + rename).

Per [DD: pane-keyed state files](docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md), v1.4 keys hook-↔-daemon files by `<paneId>` (the live wezterm pane id captured from `process.env.WEZTERM_PANE` at hook entry). The live-pane set comes from `wezterm cli list --format json` — any state file whose paneId is not in that set is sweep-eligible. Hooks where `WEZTERM_PANE` is undefined exit silently (cc isn't inside wezterm — nothing to bridge).

Two categories: **top-level** files (one per daemon) and **pane-keyed** files (per-pane / per-pane+session).

### Top-level files

| File | Schema | Writer | Deleter | Purpose |
|---|---|---|---|---|
| `daemon.pid` | JSON `{ pid: number, startedAt: string }` (`startedAt` = `ps -o lstart= -p <pid>` output, used to defend against PID reuse — [DD: daemon liveness](docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md)) | daemon `start` | daemon `stop` (Ctrl+C / graceful); state-sweep if PID dead or lstart mismatch | Lock file: hooks check `isDaemonAlive()` before walking forward path. Also enforces single-instance — second `start` errors out if first daemon's PID + lstart still match |
| `IMWork` | 0-byte tombstone (file existence IS the signal) | router on `@multi-cc-im /start` (orchestrator handler) | router on `/stop`; daemon `start` (always reset to OFF); daemon `stop` (Ctrl+C cleanup) | Master IM-mode switch. When **absent**, hooks short-circuit (cc TUI handles approvals locally); when **present**, IM mode is on and `@frontend body` from WeChat dispatches to cc |
| `wechat-cursor` | text file (single string) | iLink getupdates loop on every advance (`atomicWrite`) | never deleted in normal operation | iLink long-poll cursor. Persists across daemon restart so messages aren't lost during the daemon-down window |

### Pane-keyed files

`<paneId>` is the wezterm pane id (numeric). `<sid>` is the cc session UUID v4 (e.g. `bbfd2f1f-5f89-447c-b5df-2032ce18e2a7`). `<id>` is an 8-char hex request id.

| File | Schema | Writer | Deleter | Purpose |
|---|---|---|---|---|
| `<paneId>.IMOrigin` | JSON discriminated union by `imType` — for wechat: `{ imType: 'wechat', to: string, contextToken?: string }` (telegram / lark variants reserved) | daemon orchestrator on every IM dispatch to that pane (newest ctx wins, [DD: IMWork+IMOrigin](docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md)) | orchestrator after cc Stop forward (one-shot); daemon `start` sweep; state-sweep when paneId is no longer live | Per-pane IM reply context. cc's reply threads back to your most recent IM message. Hook stat-checks this file before walking the forward path. Single key per pane — no sid component, because the user's mental model maps "which tab am I talking to" to the pane, not the session id |
| `<paneId>_<sid>.Stop.<ts>` | JSON `{ last_assistant_message: string }` (`<ts>` = ISO-style `2026-05-08T01-43-40-131Z`) | cc Stop hook subprocess (after passing 3 short-circuit guards: IMWork on, `<paneId>.IMOrigin` set, daemon alive) | daemon's chokidar handler after forwarding to IM (~100ms typical lifetime); state-sweep when paneId not live | Per-turn assistant reply queue. Multiple files can stack if daemon was down; daemon processes them in lex (= chronological) order on next start |
| `<paneId>_<sid>.PermissionRequest.<id>.json` | JSON `{ requestId, toolName, toolInput, createdAt }` | cc PreToolUse hook subprocess (after passing decision-tree guards) | hook subprocess after polling completes (~10s max); daemon-side reaper backstop (10s setTimeout on chokidar add); state-sweep when paneId not live | Hook → daemon "please ask the user about this tool call" |
| `<paneId>_<sid>.PermissionResponse.<id>.json` | JSON `{ requestId, decision: 'allow'\|'deny', reason }` | orchestrator after IM user replies `@<tab> /1` or `/2` | hook subprocess after reading; daemon reaper backstop | Daemon → hook "user said allow / deny" |

### Lifecycle invariants

- **paneId in `wezterm cli list`** = pane is live → its `<paneId>.IMOrigin` and `<paneId>_<sid>.*` files are kept.
- **paneId NOT in live set** = the wezterm pane is gone (closed tab / quit wezterm) → state-sweep cleans every file with that paneId prefix. No more multi-signal PaneAlive — the live wezterm snapshot IS the ground truth.
- **`daemon.pid` exists + `process.kill(pid, 0)` succeeds + `ps -o lstart=` matches** = daemon really running. Otherwise stale lock; next `daemon start` overwrites silently, sweep cleans it.
- **`IMWork` exists + `<paneId>.IMOrigin` exists + daemon alive** = the only state where hook PreToolUse / Stop walk the forward path. Any other combination → short-circuit (cc TUI takes over for PreToolUse; void return for Stop).
- **`wechat-cursor`** is the only file that survives every daemon restart — it's iLink protocol state, can't be regenerated from local data.

### Quick inspection

```bash
ls -la ~/.multi-cc-im/state/

# Top-level locks present?
test -f ~/.multi-cc-im/state/daemon.pid && jq . ~/.multi-cc-im/state/daemon.pid
test -f ~/.multi-cc-im/state/IMWork && echo "IM mode ON" || echo "IM mode OFF"

# Bound IM threads (one per pane that's been addressed from WeChat this turn):
ls ~/.multi-cc-im/state/*.IMOrigin 2>/dev/null | wc -l

# Pending permission prompts (should be 0 in steady state):
ls ~/.multi-cc-im/state/*_*.PermissionRequest.*.json 2>/dev/null | wc -l
```

Detailed schemas + cross-package references at [docs/architecture.md](docs/architecture.md) "数据存储" section. Each file's behaviour is locked by a DD in [docs/superpowers/specs/](docs/superpowers/specs/).

---

## License

MIT
