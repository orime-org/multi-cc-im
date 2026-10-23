# DD and design: Codex Stop metadata across runtime modes

Date: 2026-10-23. Status: implemented and independently reviewed;
documentation and delivery validation are in progress. Baseline: `7d2794d`
(PR #251). Implementation commit: `ef5cd04`.

## Goal and existing contract

Deliver a named Codex root session's Stop reply with its exact native session
name under both the shared-daemon runtime and `--no-daemon`.

The user approved the repair after reviewing the socket-missing reproduction
and the official stdio query experiment. The existing
[session-name reply design](2026-10-22-codex-session-name-replies-dd.md)
governs the message, source-name, gate, subagent, queue and delivery contracts.
This design changes the metadata transport used by that contract.

The user's historical deployment delivered named replies with their correct
names and unnamed replies with a pane label. Those observations establish
successful historical behavior. The isolated shared-server pane experiment
has no established causal link to those historical replies. This repair's
root-cause claim concerns the independently reproduced PR #251 regression.

## Current implementation and verified root cause

| Step | Baseline fact | Inspected source or execution evidence |
|---|---|---|
| 1 | The Stop entry dispatches the name-based path before terminal discovery. | `apps/multi-cc-im/src/codex-hook.ts:24`; `packages/cli-codex/src/hook-receiver.ts` |
| 2 | The resolver initializes `connectCodexLocal` and requests `thread/read` with `includeTurns:false`. | `packages/cli-codex/src/session-name.ts:36` |
| 3 | That client connects to `<CODEX_HOME>/app-server-control/app-server-control.sock`. | `packages/cli-codex/src/local-client.ts:50` |
| 4 | A normally trusted real TUI under `--no-daemon` completes Stop with its name set and reply present; the bundled resolver prints `connect ENOENT` and produces no delivery. | [Evidence record](2026-10-23-codex-stop-stdio-metadata-evidence.json), `baselineRegression` |
| 5 | The same runtime and naming condition delivers through the pre-#249 bundle. | Evidence record, `historicalControl`; inspected commit `7b21696` |
| 6 | Official stdio `thread/read` reads the stored native name while real shared-daemon and in-process TUI sessions remain usable. | Evidence record, `liveMetadataQueries`; nine native Stop queries in each mode |

The root cause is the resolver's requirement for a shared control socket.
An in-process session has valid native metadata and Stop payloads while that
socket is absent. The failing prerequisite is introduced by PR #251.

The evidence fixture ran actual Codex 0.163.0 binaries, normally trusted hooks
and real TUI processes in disposable PTYs. It used synthetic terminal markers,
captured native titles, a structured terminal-API fixture, a localhost model
and a recording IM. These records establish native/runtime behavior and the
tested bundle path. They are not live Feishu-account or real WezTerm-window
acceptance of the new implementation.

## Official interface and dependency DD

The official [App Server protocol](https://learn.chatgpt.com/docs/app-server)
provides `stdio://` transport and `thread/read`. A read with
`includeTurns:false` returns metadata; its documented lifecycle does not resume
a thread. The inspected 0.163.0 thread processor attaches stored `thread.name`.
The inspected TUI implementation supports shared and embedded runtime targets.
The inspected exec implementation starts `InProcessAppServerClient` for
non-interactive jobs.

Pinned sources:

| Native source | Evidence |
|---|---|
| [TUI launch targets](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/lib.rs) | Inspected blob `a3fb5447b06d48d3a2924eb25dae4174243cb844`; `AppServerTarget` and `app_server_target_for_launch` |
| [Daemon exclusions](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/daemon_startup.rs) | Inspected blob `91c38d78373e4215282549f9f4dbc1af997c77d3`; hook-trust bypass changes runtime selection, so final runtime comparisons used persisted hook trust |
| [Thread metadata](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_processor.rs) | `thread_read` and stored-name hydration; native stdio queries verify the returned fields |
| [Non-interactive runtime](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/lib.rs) | Inspected blob `f97ce42737a261fa855b8055eead32cf5b44ced2`, line 1022; deployed triage function also succeeded with no shared socket |

Candidate enumeration includes native interfaces, wrappers, private storage,
binding state, upstream changes and a custom implementation. This is an
internal change within the already selected Codex integration; the table's
decision evidence is the native interface and the project's approved reply
contract.

| Candidate | Runtime coverage | Name authority and maintenance | Disposition and evidence |
|---|---|---|---|
| Existing shared UDS query | Requires the shared socket | Official native metadata | Reproduced failure under `--no-daemon`; fails the goal |
| Short-lived official stdio metadata reader | Both tested runtime modes | Native `thread/read`; installed CLI owns its storage format | Selected by the user; 18 live Stop queries, exact names and subsequent rename verified |
| Official SDK or an npm wrapper | No inspected SDK metadata-only stored-thread operation supplies this contract | A wrapper around App Server still needs a transport | No additional package is required for the documented stdio interface; no unverified SDK capability is assumed |
| Direct native JSONL or SQLite reads | Depends on native storage shape | A project parser would own private format/version details | Outside the existing native-API metadata contract; private-store parsing is unnecessary for the successful official query |
| Terminal title plus hook environment | Depends on a correct pane association | A terminal title is a separate presentation value | The approved Stop source is the full native session name; the runtime-specific pane counterexample is recorded in the earlier identity DD |
| Persistent daemon name/binding cache | Requires authoritative updates in every runtime | Adds cache ownership and rename/restart synchronization | No loaded-session event connection exists in the reproduced in-process condition; a cache does not establish the missing authority |
| Add native name to upstream Stop | Requires a changed upstream release | Native payload would be authoritative | Installed 0.163.0 Stop has no documented session-name field; this project cannot ship that upstream capability |
| Vendor native metadata code, build a custom server, or port a storage reader | Requires a new maintained implementation | Owns protocol/storage behavior | The official installed CLI already supplies the tested metadata operation |

**Internal decision basis:** keep the approved native name as the authority
and use one metadata transport that works in both evidenced runtime modes.

The implementation uses Node's existing child-process/stream facilities and
the installed Codex 0.163.0 CLI. No npm dependency, vendored source or custom
storage reader is introduced. The installed binary reports `codex-cli 0.163.0`.
Its standalone release directory contains the binary; the license was checked
in the matching official `rust-v0.163.0` source release:
[Apache-2.0 LICENSE](https://github.com/openai/codex/blob/rust-v0.163.0/LICENSE),
blob `4606e72e042564097e8780d66c1d4dcb611869bd`. This project invokes the
separately installed executable through its documented protocol.

## Design

### Reader and resolver responsibilities

`session-name.ts` retains thread-id, source, subagent, exact-name and missing-name
validation. It calls a metadata-only stdio reader.

The reader starts one owned `codex app-server --listen stdio://` subprocess.
The executable resolves through PATH, as the existing Codex triage executable
does. An optional executable injection supports fixture binaries in tests.
Its environment selects the resolved native home through `CODEX_HOME`; its
working directory is that home. Spawn diagnostics identify an inaccessible
home or unavailable executable. The process receives exactly `initialize`,
`initialized` and `thread/read {threadId,includeTurns:false}`.

Initialization checks the reported native home, Unix platform and verified
0.163.0 version. Extract that existing pure check into an internal shared
helper used by the UDS client and the stdio reader. The UDS client's wire
behavior remains governed by its existing tests and native question smoke.

The reader validates newline-delimited response envelopes, RPC identity and
RPC error responses. Notifications are consumed without generating replies.
The name resolver validates the returned thread id and metadata schema.

The existing UDS transport continues to serve live question/permission
integration. The Stop metadata reader has one stdio path in both runtime modes.
It issues metadata reads against native stored state. User TUI processes and
the current daemon remain externally owned.

### Deadline and subprocess ownership

The current metadata budget remains capped at 800 ms. A fraction of that
budget, at most 50 ms, is reserved for owned-process cleanup. Initialization
and read use the remaining operation budget. After a response, stdin reaches
EOF. A short cleanup grace permits normal exit; the reader signals only its
owned child if exit requires intervention. Failure starts cleanup immediately.
The hard cleanup timer falls within the total budget.

A valid matching read response supplies the result. The subprocess's later
shutdown status is diagnostic information; it does not invalidate already
validated metadata. Exit before a matching response is a query failure.
Pipes, readers and timers have one cleanup owner. Stdin errors, spawn failures,
malformed protocol, initialization mismatch, RPC rejection, premature EOF and
timeout all enter that same cleanup path. Tests observe owned-child exit and
the methods actually received by the fixture executable.

Only this reader's child handle can be signaled. No process-name search,
global server control command, terminal process signal or hook installation
participates in metadata reading.

### Lifecycle states

The transport states are `initializing`, `reading`, `closing` and `finished`.
`closing` owns the terminal outcome (metadata or a classified query error).
Successful metadata validation in the resolver remains a separate pure step.
The reader is the sole writer of its local lifecycle state.

| State | Valid initialization response | Matching read response | Notification | Protocol/IO failure | Operation deadline | Child close | Cleanup grace/deadline |
|---|---|---|---|---|---|---|---|
| initializing | Validate native identity, send initialized/read, enter reading | Unexpected response identity: enter closing with error | Consume | Enter closing with error | Enter closing with timeout | Finish with premature-exit error | Inactive; cleanup has not started |
| reading | Unexpected response identity: enter closing with error | Save response, end stdin, enter closing | Consume | Enter closing with error | Enter closing with timeout | Finish with premature-exit error | Inactive; cleanup has not started |
| closing | Consume; outcome already selected | Consume; outcome already selected | Consume | Record diagnostic; keep selected outcome | Operation timer is cleared | Finish and release streams/timers | Signal the owned child according to cleanup deadline |
| finished | Reader released | Reader released | Reader released | Listeners released | Timer cleared | Already closed | Timers cleared |

The request sequence and metadata behavior come from the official protocol.
The lifecycle/cleanup policy is an internal implementation decision. Its
timing and abnormal-exit transitions require fixture-process tests; reviewers
must examine those assumptions explicitly.

**Internal transition basis:** every cell in the lifecycle table is a proposed
implementation rule inferred from single-owner subprocess cleanup and one
terminal query outcome. The 18 native queries verify the successful sequence;
failure, deadline and signal transitions remain assumptions for adversarial
review and fixture-process tests.

## Acceptance and regression map

| Item | Artifact/class | Situation, goal and required result | Verification |
|---|---|---|---|
| 1 | Production, user-level, promised replies | A named root in default shared-daemon mode completes Stop; exact source name and text reach the existing IM destination. | Actual TUI/native Stop through the built hook, shared watcher, bridge and recording IM |
| 2 | Production, user-level, promised replies | A named root under `--no-daemon` completes Stop with no shared control socket; the same reply contract holds. | Baseline-red and fixed-bundle native TUI smoke under normal hook trust |
| 3 | Production, user-level, promised replies | Two named sessions and a later rename preserve the corresponding full native names under each runtime mode. | Native double-session/rename smoke; exact source/text assertions |
| 4 | Production, user-level, promised replies | Invalid identity/source, unsupported version, missing name or unavailable/broken native reader produces an actionable diagnostic and preserves the existing decision contract. | Existing resolver cases migrated to a child-process fixture; entry/gate tests |
| 5 | Production, internal subprocess lifecycle | Every success, failure and timeout completes bounded cleanup of only the reader's owned process. Valid data survives a later shutdown failure. | Real fixture children, stdin/EOF/exit/timeout tests, recorded PID checks |
| 6 | Existing production capabilities | Gate ordering, session event schema/order, Claude Stop, incoming routing, Codex question/permission transport and selected-backend triage retain their contracts. | Related tests, existing dual-TUI question/permission and selected-backend routing checks |
| 7 | Documentation and delivery | The operating guides describe both runtime modes and the query failure recovery; product bundle loads in a clean production directory. | README pair, architecture, conventions, dev guide, relevant DD; typecheck/test/build/bin and production bundle smoke; CI |

Items 1-3 preserve the already approved name-based reply result. Item 2 is
the evidenced missing runtime condition. Items 4-6 preserve or verify the
existing protections and communication contracts. Failure tests precede
production implementation.

The backend [flow demo](2026-10-23-codex-stop-stdio-metadata-flow.html)
shows successful lookup, rename, missing-name, failed process and deadline
paths. The UI rendering and routing syntax continue to use their existing
contracts. Real deployment and real Feishu-account acceptance belong to the
maintainer after reviewing the PR.

## Required verification and delivery

Design commit `107334a` received an independent design review with zero
established findings. Implementation commit `ef5cd04` received an independent
implementation review with zero established findings; that reviewer also ran
79 focused tests. The working tree was clean after both reviews.

The [implementation execution record](2026-10-23-codex-stop-stdio-metadata-verification.json)
contains native fixture results, bundle/driver hashes, full-suite checks and
the existing watcher failure comparison. The regression test first returned
`undefined` where the named stdio result was required; the implemented reader
passes that case. A second red test established canonical-home propagation.
The current suite passes 1,394 tests, including 53 resolver/process cases.

Implementation verification includes typecheck, the repository test suite,
affected native runtime smoke, existing native question/permission and
triage regression, production build, `./bin/multi-cc-im --version`, and a
clean production-directory bundle load. A package manifest change additionally
requires frozen-lockfile installation. The repository currently has no lint
script; final verification records the available checks explicitly.

Native watcher failures, if encountered, are compared against current main.
Test-process polling may demonstrate the full suite under the documented host
resource constraint. The native result and baseline comparison are reported
separately. The maintainer's running bridge and other development processes
remain outside the test fixtures' ownership.
