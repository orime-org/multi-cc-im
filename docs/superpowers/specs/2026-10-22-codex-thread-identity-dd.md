# DD: Codex thread identity must come from the client

Current scope: the later user-approved
[session-name reply decision](2026-10-22-codex-session-name-replies-dd.md)
sets Stop source labels from native metadata. The accepted
[session-name question decision](2026-10-26-codex-question-session-name-dd.md)
sets question source labels and bindings from current native names. This
identity DD governs permission-hook pane association; its question and Stop
acceptance records describe the earlier title-based implementation.

Date: 2026-10-22. Status: user accepted candidate E (official title identity) on 2026-10-22;
the earlier hook-pane implementation remains withdrawn. The user-approved local App Server
question transport remains valid. The investigation used isolated fixtures; implementation/activation followed
the explicit title approval. No existing user TUI/daemon was restarted.

## Problem and reproduced root cause

The question-bridge DD assumed a native SessionStart hook could authoritatively
associate `session_id` with the hook's `WEZTERM_PANE` / `ITERM_SESSION_ID`.
That assumption fails when native TUIs share an App Server: hooks execute in
the server's session environment, not each observing TUI's launch environment.

The isolated real 0.163.0 probe used server pane `700`, two real TUI processes
with pane markers `800` and `900`, one temporary Codex home/project, and a
localhost fake Responses provider. Both SessionStart markers reported `700`.
The two TUIs' official `thread-id` titles identified distinct thread ids.
A directory/title-name match cannot repair the inherited environment.

Reproduce with:

```sh
pnpm exec tsx scripts/codex-identity-probe.mts
```

The probe starts and stops only its own processes and private temporary files.
Hook-trust bypass is scoped to that isolated fixture. Its PTY/title capture is
research instrumentation, not a proposed product ANSI parser or TUI wrapper.

Earlier product-candidate checks passed 1,301 unit tests with a test-only
polling setting and a real native transport/model-input smoke. Those checks
supplied the pane binding themselves, so they did not prove pane provenance.
The real two-TUI probe invalidated that foundation. The candidate code was
removed from the working tree into a reversible WIP stash; none was deployed
or submitted as a completed feature. Existing native-watcher host EMFILE
failures were unchanged (10 event tests / 14 errors), and are unrelated to
this identity failure.

## Evidence

- I1: The reproducible installed-binary probe above; real clients, one project,
  distinct thread ids, identical hook server-pane values.
- I2: Pinned [native hook command runner](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/command_runner.rs)
  builds command environments from the session snapshot before handler overrides.
  This common runner affects hook-origin assumptions beyond SessionStart.
- I3: Pinned [native title item](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/bottom_pane/title_setup.rs)
  exposes `thread-id` (also recognizes `session-id`). Pinned
  [title rendering](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/chatwidget/status_surfaces.rs)
  truncates that item to 32 characters. I1 actually observed distinct UUID
  prefixes ending in `...`, with activity appended. It is not a full UUID.
- I4: Official [WezTerm CLI list](https://wezterm.org/cli/cli/list.html) returns
  structured JSON with `pane_id` and the pane's `title`.
- I5: Official [iTerm2 session variables](https://iterm2.com/documentation-variables.html)
  expose `terminalWindowName` for OSC 0/2 separately from user-overridden
  `autoName`/display names. The helper previously read only `session.autoName`; it now exposes
  `session.terminalWindowName` separately, covered by the actual Python helper
  contract test with deliberately different display/native titles.
  The actual iTerm2 round trip has not been tested in this investigation.
- I6: The existing [question transport DD](2026-10-22-codex-question-bridge-dd.md)
  verifies native request identity, first-answer behavior, replay and interruption.
  Its transport probes do not establish a terminal binding.
- I7: Pinned [loaded-thread resume](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs)
  composes a running-thread response and pending replay. Attaching another
  client does not make its terminal environment the session environment.

## 1. Candidate enumeration

| Candidate | Identity source | Feasibility |
|---|---|---|
| A. Native event/payload alone | Question/hook payload | Contains thread/turn/item/request, but no TUI pane identity (I1/I6). |
| B. Inherited hook environment | Server-side terminal variables | Disproved by I1/I2; withdrawn. |
| C. Process argv/environment inference | Foreground processes | New sessions need not put thread id in argv; no verified official exact binding. Cannot replace one inference with another. |
| D. cwd, project, human title | Name/directory matching | Same-project sessions collide in I1; not an identity. |
| E. Official TUI thread-id title | Client-emitted id prefix + structured terminal API + unique native-id match | Observed in I1/I3; terminal APIs documented I4/I5. Requires title configuration and strict ambiguity rejection. |
| F. Explicit owner binding | User supplies target pane/tab and full native thread id | Feasible within existing IM command/state/owner patterns; requires binding again after switching target sessions. No new external service. |
| G. Upstream client-registration metadata | New native pane extension / user variable / callback | No verified available 0.163.0 contract. Upstream work cannot be claimed as an implemented solution. |
| H. Replace/wrap/fork the TUI | Owned TUI transport/process | Violates the project's existing-TUI constraint and adds upstream maintenance. |

## 2. Due diligence and boundaries

E reuses native Codex title configuration and the already selected terminal
APIs. It introduces no replacement TUI or handwritten terminal parser. The
bridge must read structured terminal values, preserve friendly names separately,
compare the emitted prefix against current loaded native thread ids, and act
only when exactly one id matches. Missing/truncated beyond the verified shape,
ambiguous, closed, or changed identity must pause forwarding/submission.
Do not guess by cwd, omit ambiguity checks, or claim the title contains a full
UUID. iTerm2 has a helper/API contract acceptance test; a live-window round trip is
not verified and remains a platform acceptance item before broad release.

The native source remains OpenAI's Apache-2.0 project at the pinned 0.163.0
release; the title field and renderer are separate existing TUI modules (I3).
E uses the existing official terminal APIs, not a new third-party library.
Any production WebSocket use must still declare `ws` directly in cli-codex and
the published CLI package, as required by the transport DD. Data discovery stays
local; only the explicitly enabled IM workflow sends question text to its owner.
Read only configured/known Codex homes and loaded ids; do not scan transcripts
or subscribe indiscriminately to every local thread.

The concrete visible configuration proposal for the current title is:

```toml
[tui]
terminal_title = ["project-name", "activity", "thread-id"]
```

This appends the official field to the current items; it visibly adds a thread
id prefix to the title. The user explicitly approved adding this visible item. Installer changes
preserve other fields/items and take a backup before writing.

F uses an explicit owner command, proposed `/bind-codex #<tab> <full-thread-id>`,
validated against a live pane and loaded native thread. It can reuse private
atomic state and owner ACL. It does not infer the current session and cannot
automatically know that the user later switched to another thread in the same
pane; the user must rebind. Its state/lifecycle and stale-binding UX need tests.

For either viable choice, Codex permission requests must use the
same selected identity source rather than keeping the old inherited-pane
mapping. Otherwise question routing would improve while the same root defect
remained in other Codex communication. Claude's existing hook-origin semantics
are a separate path and were not invalidated by this server-side Codex probe.

## 3. Comparison matrix

| Candidate | Exact association | User impact | Complexity / regression surface | Security and maintenance evidence |
|---|---|---|---|---|
| A | Missing pane | No setup | Insufficient contract | I6; cannot locate the TUI. |
| B | Wrong when server shared | Silent wrong tab | Existing assumption fails | I1/I2; rejected. |
| C | Not verified for new/resumed sessions | No title change | New process-discovery dependency and privacy surface | No exact supported native contract found; not recommended. |
| D | Non-unique | None | Low code, incorrect identity | I1 demonstrates collisions; rejected. |
| E | Native id prefix, only if unique | Title shows an id prefix | Medium: both terminal adapters, CLI origin lookup, title setup, lifecycle tests | I1/I3/I4/I5; official APIs, no new runtime dependency; reject unknown/ambiguous data. |
| F | Explicit full id selected by owner | Manual bind/rebind | Lower discovery complexity; command/state/CLI origin and stale-state tests | Existing owner ACL/private state plus I6 native-id validation; manual lifecycle obligation remains. |
| G | Would be exact with a new upstream contract | Unknown | Upstream delivery/upgrade dependency | No current verified implementation. |
| H | Process ownership can supply it | Replaces current workflow | Highest ongoing upstream/TUI cost | Violates core constraint; rejected. |

## 4. Recommendation

Recommend E if the user accepts the visible title id: I1 proves the data is
emitted separately by the two actual clients; I3 defines the field/truncation;
I4/I5 supply structured terminal access. This gives automatic session changes
without trusting server environment or inventing another TUI. It requires
strict prefix uniqueness and terminal-specific acceptance tests before shipping.

Choose F if keeping titles unchanged is more important than automatic session
association. It is a different interaction contract, not an invisible fallback
for E. Implement one chosen source consistently; do not mix guesses, silent
fallbacks, or two competing binding authorities.

## 5. User decision

Accepted: **E**, official `thread-id` title with automatic session discovery. The
user selected “官方线程 ID 自动识别（推荐）” and explicitly accepted the visible id
and pausing on missing/ambiguous identity. Manual binding is not implemented.

Implementation contract: one selected Codex home (`CODEX_HOME`, otherwise
`~/.codex`), the existing selected terminal, and current `thread/loaded/list` ids.
Both persistent question discovery and short-lived hook origin lookup use the
same pure matcher on fresh structured terminal titles and loaded ids. Hook
lookup initializes a separate local UDS client, lists loaded ids, and disconnects;
it never resumes or starts a thread. Missing identity defers to the native TUI
with an explicit diagnostic. No inherited pane environment fallback or cached
pane registration is authorized. Other Codex homes require a matching daemon
configuration; no private transcript/home scanning is performed.

## 6. Implementation and verification

The source is implemented in `thread-identity.ts`; both `hook-origin.ts` and
`question-client.ts` use it with fresh snapshots. Hook lookup only initializes,
lists loaded ids and disconnects within 800ms; its owned terminal listing has a
600ms deadline. It never uses server pane variables or creates/resumes threads.
The question observer reads metadata and resumes only associated loaded roots;
no config overrides or new turns. Responses recheck identity before submission.

The reproducible two-TUI probe now validates the production hook entry with
captured real native titles returned through a terminal-API fixture. Even with
server pane 700, PreToolUse auto decisions pass after native identity lookup.
The probe's Stop entry fixture now checks session-name reply events under the
later reply contract. Both actual TUIs issue request_user_input;
the product client discovers their current title identities and distinct answers
reach the correct local fake-model inputs. Fixture terminal executables are
preflighted before the hook's sub-second deadline. The actual WezTerm structured
API was also checked read-only (15 panes/title fields, approximately 8ms).
Product code does not parse the probe's terminal control stream.

The separate product bridge smoke checks IM-first, terminal-first, late answers,
restart pending replay, default-mode requests and multi-question interpretation.
Unit regressions cover collisions, duplicate displayed threads, missing/changed
identity, no revival, subagents, malformed/secret questions,
native disconnects, pagination, RPC timeout, owner/chat/IM mode and sensitive
input gates. Global Claude settings compare unchanged. Title activation backs
up the existing Codex config and adds only the explicitly approved field.

The [2026-10-25 repair](2026-10-25-codex-runtime-errors-dd.md) replaces the
original unsupported-version rejection tests with successful arbitrary-version
and missing-version cases. Actual protocol failures retain operation, observed
runtime version and native reason; identity and source restrictions remain.

The iTerm2 helper contract passes. The deployment terminal is WezTerm; a live
WezTerm/Codex TUI acceptance now verifies native title identity, prompt submission,
production hook entry fixtures and the product-bridge/test-IM answer return.
Hook identity lookup took 6ms. The model endpoint is a localhost fixture.
Real Lark account acceptance belongs to the maintainer's GitHub deployment.
See the [execution record](2026-10-22-codex-wezterm-acceptance.md).

Final checks: typecheck passed; frozen install passed; the full test-only polling
coverage run passed **1,313 tests** (87.96% lines, 83.50% branches). The unmodified
native-watcher run had 1,303 passes plus the same 10 pre-existing failure cases
and 14 EMFILE errors as the clean implementation baseline. No native watcher
policy was changed. Build/bin and a clean offline production-only deployment
both loaded version 0.2.3, including the direct ws dependency. Existing Claude
settings compare byte-for-byte unchanged; AGENTS.md and CLAUDE.md are untouched.

Mainline integration: after #248 was squash-merged as `7b21696`, #249 was
retargeted to main. The merged main tree equals the original #248 base tree;
all eight conflicts therefore concern already-incorporated content. Integrating
main preserves the tested #249 product tree exactly, including native question
identity, hook origin and mixed-CLI routing tests. No protocol or architecture
decision changed. Revalidation passed: 1,313 tests with test-only polling,
87.96% line / 83.50% branch coverage, typecheck, frozen install, build and bin
smoke (0.2.3). Claude settings remain byte-for-byte unchanged.
