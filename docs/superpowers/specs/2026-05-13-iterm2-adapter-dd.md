# DD: iTerm2 Term Adapter

> Status: **LOCKED** 2026-05-13. Pre-locked by user with 3 yes/no answers
> (Python dep OK / PaneId string OK / iTerm2 prefs + macOS permission UX OK)
> after fact-finding research on iTerm2's public control surfaces.

## 1. Goal

Add iTerm2 as a second `TermAdapter` implementation alongside the existing
WezTerm one (`packages/term-wezterm`), so that users running cc in iTerm2 tabs
can use multi-cc-im without switching terminal emulators.

## 2. Why this needs a DD

Touches all four DD trigger heuristics from `CLAUDE.md`:

1. **Cross-package interface change** — adding any new term adapter forces
   `packages/shared/src/adapter/term.ts` and `packages/cli-cc/src/hook-receiver.ts`
   to abstract over the previously WezTerm-hardcoded entry gate
   (`process.env.WEZTERM_PANE`).
2. **Core extension point** — `TermAdapter` is one of the 4 adapter axes
   (`IM` / `Term` / `CLI` / `Storage`) per the project charter; adding the
   second concrete instance defines the shape every future adapter inherits.
3. **Long-term maintenance burden** — iTerm2 control means depending on the
   `iterm2` PyPI package, which means we depend on a Python runtime being
   present, the iTerm2 Python API server preference being enabled, and the
   macOS Automation permission being granted. None of these are free.
4. **Reversibility cost** — once daemon code, hook entry gate, and PaneId
   type are reshaped, the change spans 3+ packages. Walking it back later
   isn't a one-line revert.

## 3. Audit of current WezTerm-coupled surface area

Reference: `packages/shared/src/adapter/term.ts`,
`packages/term-wezterm/src/`, `packages/cli-cc/src/hook-receiver.ts:223-235`.

| # | Layer | Current state | iTerm2 implication |
|---|---|---|---|
| 1 | `shared/adapter/term.ts` `Adapter` + `ListPanes` interface | Six caps abstracted: `name` / `start` / `sendText` / `sendKeystroke` / `stop` / `listPanes` + `PaneInfo{paneId,title,cwd}` | iTerm2 adapter implements these directly. No change needed at this layer. |
| 2 | `cli-cc/hook-receiver.ts` entry gate | Hard-reads `process.env.WEZTERM_PANE`, silent-exits if absent or non-numeric | iTerm2 sets `ITERM_SESSION_ID`, NOT `WEZTERM_PANE`. **Hook never fires.** Must abstract env detection. |
| 3 | `shared/types.ts` `PaneId` | `number & {__brand}` — branded numeric | iTerm2's stable id is the UUID suffix of `ITERM_SESSION_ID = "w0t1p0:UUID"` — a string. Type must widen. |
| 4 | wezterm send-text / list | Spawns `wezterm cli` subprocess per call, stateless, no daemon | iTerm2 has no `iterm cli`; control goes through Python API over a WebSocket. Requires Python helper subprocess or persistent daemon connection. |
| 5 | wezterm tab title model | `1 tab ≈ 1 pane` typical, title is what user `/rename`d | iTerm2 supports window/tab/split-pane 3-level nesting; "title" semantics differ. Adapter must pick a sensible projection. |

Layer #2 is the deepest leak. The other four are local to the new adapter
package + a small `shared` type change.

## 4. Candidate enumeration

Per CLAUDE.md memory `feedback_dd_question_premise`, the first candidate is
always **"do nothing / use existing"**.

| # | Candidate | One-line description |
|---|---|---|
| **C0** | **Don't add iTerm2** | Users wanting multi-cc-im run cc in WezTerm only. Documented as a constraint. |
| **C1** | **Python API + ephemeral Python helper** | Node spawns `python3` subprocess per call; subprocess opens a fresh WebSocket to iTerm2, runs RPC, exits. Matches cli-cc's ephemeral subprocess model. |
| **C2** | **Python API + persistent daemon-side Python** | Daemon maintains a long-running Python process holding the iTerm2 WebSocket open. Enables `SessionTerminationMonitor` push events. |
| **C3** | **AppleScript only** | `osascript -e 'tell application "iTerm"'` from Node, no Python dep. |
| **C4** | **`it2` CLI wrapper** | Use the third-party `it2` Python CLI as the IPC channel. |
| **C5** | **Direct WebSocket + protobuf in Node** | Skip Python entirely; speak the iTerm2 wire protocol from Node. |

## 5. Per-candidate due diligence

### 5.1 Capability matrix

| Cap | C0 don't do | C1 Python ephemeral | C2 Python persistent | C3 AppleScript | C4 `it2` CLI | C5 direct WebSocket |
|---|---|---|---|---|---|---|
| List panes / sessions | N/A | ✅ full | ✅ full | ⚠️ partial (no stable id) | ✅ full | ✅ (if we write the decoder) |
| sendText paste-only | N/A | ✅ | ✅ | ✅ | ✅ | ✅ |
| sendKeystroke `\r` separate | N/A | ⚠️ `async_inject` + escape, awkward | same as C1 | ❌ no documented keystroke verb | ⚠️ `it2 run` auto-newlines | ⚠️ same as C1 |
| **Per-pane env var for hook gate** | N/A | ⚠️ read-only `ITERM_SESSION_ID`, UUID suffix is the only stable part | same | ❌ none, no way to inject | same as C1 | same as C1 |
| Lifecycle push events | N/A | ❌ (subprocess exits) | ✅ `SessionTerminationMonitor` etc. | ❌ none | ❌ (subprocess exits) | ✅ notifications system |

### 5.2 Governance / setup / risk

| Dim | C1 | C2 | C3 | C4 | C5 |
|---|---|---|---|---|---|
| Source | Official `iterm2` PyPI, maintained by core team (gnachman) | same | Apple-shipped, deprecated, no replacement | Third-party PyPI `it2` by mkusaka, lower commit activity | Self-implemented; protocol undocumented (only Python source) |
| Setup friction | Enable iTerm2 Python API pref (1 toggle) + Automation permission (1 dialog) + Python 3 + `pip install iterm2` | same | None | same as C1 + `pip install it2` | Same as C1 minus the PyPI install, plus protobuf parser |
| Auth model | `ITERM2_COOKIE` for child scripts; external scripts fetch cookie via AppleScript prompt | same | N/A | same as C1 | Manual cookie handling, no library guidance |
| Protocol stability | Public stable API since iTerm2 3.3 (2019); cookie required since 3.3.9 | same | Deprecated, frozen | inherits C1 | Undocumented; protobuf schema can change without notice |
| License risk | GPL-2.0 iTerm2 + MIT `iterm2` PyPI — both OK | same | OK | MIT `it2` — OK | Reverse-engineered protocol — no clean ground truth |

### 5.3 Latency notes

cli-cc hook subprocess runs ~50ms typical end-to-end. Python startup adds
~100-300ms cold (CPython, no module cache); the `iterm2` package itself
imports `asyncio` + protobuf + WebSocket libs. Each Python helper call
roughly doubles hook latency vs WezTerm's `execFile`-only path. Acceptable
for hook events that fire seconds/minutes apart; would not be acceptable
if hooks polled at sub-second cadence.

## 6. Recommendation

**C1: Python API + ephemeral Python helper subprocess.**

Reasons, each backed by §5 evidence:

1. **C0 ruled out** — user pre-locked "yes to iTerm2 support."
2. **C3 ruled out** — capability matrix row 3 + row 4 both ❌; no way to
   send a separate `\r` keystroke, no env var path. AppleScript also
   deprecated upstream.
3. **C4 ruled out** — `it2` is a shell wrapper around the same Python API
   as C1; adds a maintenance hop (third-party package, lower activity)
   without adding capability. CLAUDE.md "use existing SDK, don't add a
   second wrapper."
4. **C5 ruled out** — undocumented protobuf wire protocol violates
   CLAUDE.md "用现有 SDK 不造轮子" + introduces a protocol-stability risk
   nothing else has. The savings (no Python dep) don't outweigh the
   coupling to an unspecified format.
5. **C2 over C1 ruled out for v1** — push lifecycle events are
   nice-to-have, not required (WezTerm has none and the project works).
   C2 requires daemon to manage a persistent Python child process,
   complicates start/stop/crash recovery, and adds ~50MB resident memory
   per daemon. C1 mirrors cli-cc's existing "one short-lived subprocess
   per event" model — minimum architectural intrusion. C2 can be a future
   opt-in if/when polling becomes a real bottleneck.

## 7. Trade-offs the user accepts by locking C1

| Trade-off | Mitigation |
|---|---|
| Python 3 must be on `PATH` (and `iterm2` package installed) at daemon-side and hook-side | Setup wizard `start iterm2` runs `python3 -m pip install --user iterm2` for the user; `path-resolver` detects `python3` at runtime, errors clearly if missing |
| Per-call latency ~100-300ms higher than wezterm | Acceptable for hook events; documented in DD notes |
| iTerm2 Python API server must be enabled (`Preferences > General > Magic`) | Wizard prints the click path + screenshot link in inline guide (mirror W6 ANSI hyperlink pattern from #101) |
| First-call Automation permission dialog | Wizard primes user before first call |
| `PaneId` widens from `number` to `number \| string` (branded union) | Internal-only change; matcher/router already treat PaneId as opaque |
| No push lifecycle events in v1 (must poll on each IM event like wezterm) | Same baseline as wezterm — no regression |

## 8. Protocol facts (from upstream research, source-cited)

These are non-negotiable facts the implementation must respect.
Sources: [docs.iterm2.com](https://iterm2.com), `gnachman/iTerm2` repo,
`iterm2` PyPI.

- `ITERM_SESSION_ID` env var auto-exported to every shell launched in
  iTerm2; format `w<W>t<T>p<P>:UUID`. The `w/t/p` indices reposition when
  panes/tabs/windows close. **Only the UUID suffix is stable.** Python
  API accepts both forms (full or 4+ char UUID prefix).
- Python API server is disabled by default; enabled per-machine via
  `Preferences > General > Magic > Enable Python API`.
- First connection from an external script triggers a macOS Automation
  permission dialog (managed by macOS, not iTerm2). Once granted, no
  further prompts.
- WebSocket URL: `wss://127.0.0.1:<port>/?...` with `ITERM2_COOKIE`
  query param. Cookie is set automatically for scripts launched
  *by* iTerm2 (e.g. via the Scripts menu) or fetched via AppleScript
  for external scripts.
- No equivalent of `WEZTERM_PANE` writable env exists. iTerm2 controls
  the env it injects; we cannot ask iTerm2 to set our own per-pane
  variables. We work with what iTerm2 gives us: parse the UUID out of
  `ITERM_SESSION_ID`.

## 9. Implementation milestone plan (to be detailed after lock)

Following v1.12 cadence (PR #150-#155 chain). Sketch only:

- **P1**: Widen `PaneId` type + `defaultResolvePaneId` abstraction in
  cli-cc — env var name and value parser become per-terminal pluggable.
- **P2**: New `packages/term-iterm2/` with `adapter.ts` implementing
  the 6 caps via a Python helper script (`bin/iterm2-helper.py`).
- **P3**: Wire `python3` path resolution (mirror wezterm's
  `path-resolver.ts`) + write installer/check in setup wizard.
- **P4**: `start iterm2` adapter-setup-schema (mirror lark adapter
  setup, inline guide, ANSI hyperlinks for the Python API preference
  toggle).
- **P5**: orchestrator wiring (no change expected — adapter is plug-
  compatible).
- **P6**: `docs/conventions.md` status-table update, README updates,
  this DD doc finalized.
- **P7**: real-account smoke (spawn cc inside an iTerm2 tab, send a
  prompt via IM, verify TUI receives + cc echoes back).

Each milestone = 1 PR. Mirror v1.12 cadence.

## 10. Open follow-ups (not blockers for lock)

1. Should `start <terminal>` wizard auto-detect which terminal the user
   is currently running in and default the selection?
2. If a user runs cc in both wezterm AND iTerm2 simultaneously, daemon
   would need both adapters active concurrently. Out of scope for v1
   (single-adapter mode); flag for v2.
3. C2 (persistent Python helper for push events) becomes worth
   revisiting if hook latency becomes a measurable user complaint.

---

**Locked**: 2026-05-13 — user pre-approved C1 via 3 yes/no answers
(Python dep / PaneId string / iTerm2 prefs+permission UX). Implementation
PRs follow.
