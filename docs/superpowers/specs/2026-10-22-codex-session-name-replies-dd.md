# DD and design: Codex replies identified by session name

Date: 2026-10-22. Status: user-approved design and correction implemented;
two independent implementation reviews returned no established defects.
Final validation and PR delivery are pending. Real-account acceptance belongs
to the maintainer after deployment.

## Goal and approved contract

Deliver Codex Stop replies to the existing IM destination with the native
session name as their source label. The user owns deployment and real-account
acceptance. The implementation is user-level, within the promised IM reply
capability.

The user specified that Feishu addresses conversations by session name and
approved looking up that name from the Stop event's thread id. Native
`thread-name` is the name set by `/rename`. Native `project-name` is the
project directory label. The former is the reply source in this design.

## Baseline behavior and evidence (f298ed1)

| Step | Current behavior | Source inspected for this task |
|---|---|---|
| 1 | The bundled hook loads the selected terminal, constructs its adapter, then asks the native title resolver for an origin. | `apps/multi-cc-im/src/codex-hook.ts:24` |
| 2 | Every non-SessionStart event requires that origin before dispatch. | `packages/cli-codex/src/hook-receiver.ts:180` |
| 3 | The resolver intersects terminal titles with loaded thread ids; a missing title id ends forwarding. | `packages/cli-codex/src/hook-origin.ts:25` |
| 4 | Stop writes a pane-keyed file. The watcher invokes `onStop`, which lists panes again to obtain the source label. | `packages/cli-codex/src/hook-receiver.ts:538`, `packages/cli-cc/src/adapter.ts:356`, `packages/bridge/src/orchestrator.ts:940` |
| 5 | IM input writes global `IMOrigin`; replies read that latest validated context. | `packages/bridge/src/orchestrator.ts:418`, `packages/bridge/src/orchestrator.ts:973` |
| 6 | Incoming `#name` matching uses the terminal adapter's cleaned title. | `packages/term-wezterm/src/tab-title.ts:128`, `packages/bridge/src/matcher.ts:67` |

Historical deployment logs confirm successful replies labeled `(pane N)`.
After PR #249 introduced the title-id prerequisite for Stop, the deployed
version failed to forward from an existing TUI whose title contained its name.
The observed native Stop completed successfully, while replay through the
deployed entry reported a missing/ambiguous title identity and wrote no reply
event. A read-only native `thread/read` query returned a nonempty name for
the same thread. These observations establish the erroneous prerequisite:
sending a labeled reply currently requires locating its physical pane.

Pinned official Codex 0.163.0 sources describe the metadata:
[thread/name/set and thread/read](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_processor.rs),
[title rendering](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/chatwidget/status_surfaces.rs).
The generated `ThreadReadResponse` schema exposes `thread.id`, `thread.name`
and `thread.source`. Local source inspection confirms project-name comes from
the project root/current directory and title thread-name can be truncated.

## Candidates and decision

| Candidate | Evidence and result | Decision |
|---|---|---|
| Single event plus on-demand native metadata | Stop supplies thread id and text; `thread/read` supplies the native name. A local query established availability. | User selected. |
| Persist thread-to-pane bindings | Requires independent pane provenance and binding lifecycle; existing identity DD records the shared-server environment counterexample. | Unnecessary for the selected reply contract. |
| Terminal title id | Existing implementation requires a visible title item; the user's deployed failure reproduced its missing-id gate. | Superseded for Stop replies by the user's name-based decision. |
| Infer a pane from cwd or project name | Multiple sessions may share a project; project and native session names are independent. | Does not establish reply metadata. |
| Parse transcript files | Native metadata already supplies the requested name; private-file parsing introduces an additional upstream data dependency. | Native metadata supplies the required field. |
| Replace the TUI or fork native Codex | Project constraints preserve the user's existing TUI process. | Outside the allowed deployment model. |

The event format below is a **pure internal choice**. Its precedent is the
existing atomic hook queue and single watcher (`packages/cli-cc/src/adapter.ts:160`;
`packages/cli-cc/src/state-files.ts:306`). It requires no new external library.
Existing dependencies remain `ws` 8.20.0 (MIT), `zod` 3.x (MIT), `chokidar`
4.x (MIT), and workspace atomic writes. The native local transport remains
verified against Codex 0.163.0.

## Implemented data flow

The bundled Stop entry reads the configured terminal id as the IM mode gate.
It supplies a session-name resolver directly, then invokes the Stop receiver.
The receiver checks nonempty reply, inactive stop hook, `IMWork`, `IMOrigin`
and daemon liveness before querying metadata.

The resolver uses the bounded official stdio metadata reader described in the
[runtime repair DD](2026-10-23-codex-stop-stdio-metadata-dd.md). It requests
`thread/read {threadId, includeTurns:false}`, validates the response id,
nonempty native name and source, and excludes native subagent sources.
The whole metadata lookup has an 800 ms budget, including initialization and
owned-child cleanup. Both shared-daemon and `--no-daemon` modes use the reader.
The owned child's stdin closes on success, timeout and failure. Missing names produce
an actionable stderr diagnostic instructing `/rename <session-name>`; protocol,
version and process failures identify the installed Codex/home checks.

The hook writes one atomic 0600 session reply event under the shared state
directory: `SessionReply.codex.<thread-id>.<timestamp>.json`. The body contains
`cli: 'codex'`, `sessionId`, `sessionName`, `termId` and
`last_assistant_message`. Thread ids are validated UUIDs and timestamps use
the existing colon-free timestamp formatter. Names occur in the JSON body.
Events for successive turns remain distinct queue entries.

The shared watcher classifies this explicit filename independently of pane
events, validates the JSON body and filename/body session agreement, serializes
dispatch per native session and invokes a session-reply handler capability.
Unsupported handlers produce diagnostics. The event is deleted after dispatch,
including handler failure, following the existing Stop queue contract.
Startup cleanup preserves this recognized event family; watcher initial scan
handles backlog in filename order. There remains one shared state watcher.

`apps/multi-cc-im/src/start.ts` supplies the shared watcher's existing
`onHandlerError` callback for the configured CLI adapter. Its error context
identifies event kind and native session id; pane id is optional for session
replies. Invalid event bodies, filename/body session mismatches and unsupported
handlers reach the daemon log through this callback. The diagnostic describes
the failure and event context. The existing callback is declared in
`packages/cli-cc/src/adapter.ts:36` and invoked at line 193; the product
dependency wiring is at `apps/multi-cc-im/src/start.ts:720`.

The orchestrator uses a shared text-reply delivery function for pane Stop and
session replies. It checks the selected terminal's `IMWork` and the latest
validated global `IMOrigin`, skips empty messages, and passes `sessionName` as
`sourceTag` for the named event. Pane Stop continues resolving its pane label.
Send failures use the existing daemon error surface.

Incoming name matching remains the existing terminal-title matcher. For a
session named `frontend`, a terminal title beginning with `frontend` supports
the existing unique-prefix `#frontend` route. The operation guide must state
how `/rename`, `thread-name`, `project-name`, `activity` and `/list` relate.
Native permission and question paths retain their existing pane identity
requirements, as a separate capability from labeled Stop replies.

## Queue states and invariants

| State | Receive Stop | Metadata result | Watcher dispatch result | Process exit/restart |
|---|---|---|---|---|
| No event | Eligible Stop enters lookup; inactive/empty/gates-closed ends here. | Not applicable until lookup. | Not applicable without event. | Remains empty. |
| Looking up | Another invocation has its own bounded lookup. | Valid root name writes event; subagent ends; missing name/error/timeout reports and ends. | Not applicable before atomic rename. | The owned connection ends; no partial event is dispatched. |
| Queued | A later timestamp adds another event. | Lookup already complete. | Valid event invokes handler; invalid event reports; dispatch consumes the event in either case. | Complete events are initial-scan backlog on restart. |
| Dispatching | New events queue behind this native session. | Lookup already complete. | Success or failure deletes the event; send failure is reported. | A crash before deletion may replay the event, matching existing Stop delivery semantics. |
| Consumed | A subsequent Stop starts a new event. | Not applicable. | Further duplicate filesystem notifications find no event. | Remains consumed. |

Only the hook writes reply content/name. Only the watcher consumes queue files.
Only the orchestrator selects IMOrigin and delivers. A session reply carries
no pane id. Native name lookup neither changes the thread nor advances a turn.
The name is a Stop-time snapshot, so a later rename applies to later replies.
Existing duplicate-name rejection remains applicable to incoming routing;
an outgoing source label does not select an input destination.

The HTML companion demonstrates the backend data flow and failure states.

## Acceptance and verification

| Item | Artifact/class | Situation and required outcome | Verification |
|---|---|---|---|
| 1 | Production, user-level, promised reply capability | A named root Stop with an active bridge reaches IM with exact native session name and text. | Receiver, watcher and orchestrator tests; local end-to-end fixture. |
| 2 | Production, user-level, promised reply capability | Project title and thread name differ; the reply uses thread name. The terminal title lacks thread id. | Entry fixture and local native metadata smoke with deliberately different names. |
| 3 | Production, user-level, promised reply capability | IM off, no IMOrigin, dead daemon, empty reply or active stop hook produces no delivery. | Enumerated gate tests. |
| 4 | Production, user-level, promised reply capability | Missing name, wrong thread, unsupported server, timeout or malformed metadata supplies an actionable diagnostic; subagent Stop is excluded. | Native client fixture and receiver tests. |
| 5 | Production, user-level, promised reply capability | Two sessions and successive queued turns retain their labels and ordering through the shared watcher. | Watcher and local end-to-end fixture. |
| 6 | Production, internal queue contract | Malformed bodies, session-id mismatch and handler/send errors are diagnosed and consumed consistently; restart backlog is recognized. | Schema, watcher, cleanup and bridge tests, plus a product startup test that exercises the wired callback and asserts the daemon diagnostic. |
| 7 | Existing production capabilities | Claude pane Stop and native Codex permission/question paths retain their current contracts. | Related tests and existing native question smoke. |
| 8 | Documentation | Operators can distinguish project/session name and configure a routable session name. | README pair, architecture, dev guide, conventions and affected DD updates. |
| 9 | Delivery | The bundled CLI loads and the PR has passing checks. | Typecheck, full tests, affected smoke, build and `./bin/multi-cc-im --version`; CI. |

Unit tests use isolated native/state directories. Local smoke connects to an
owned native fixture and a recording IM adapter. The maintainer performs
deployment and real Feishu-account acceptance from GitHub.

## First design review and approved correction

An independent reviewer inspected the design, HTML flow, hook entry and
receiver, local client, shared watcher, startup wiring, cleanup, orchestrator
and name matching. The reviewer returned one solution gap: the shared watcher
has an optional error callback, while the current product startup supplies no
callback. Source inspection confirmed both sides of that gap. The user approved
the correction and the accompanying source-link correction.

| Finding | Incorporated correction | Planned evidence |
|---|---|---|
| Queue diagnostics require product-entry wiring. | Explicit startup `onHandlerError` wiring, session-oriented error context and an expanded acceptance item 6. | Product startup test must invoke the actual supplied callback and inspect the daemon diagnostic. |
| The metadata implementation citation points to a different native module. | The pinned link points to `request_processors/thread_processor.rs`, whose inspected implementation contains `thread_read` and `thread_set_name_response_inner`. | Pinned source tree entry and implementation inspection. |

## Implementation review record

Two independent reviewers inspected implementation commit `ce6564e` against
baseline `f298ed1`. One reran 285 affected tests; the other reran 126 targeted
tests. Their working-tree checks were clean. The primary agent rechecked the
dispatch, validation, source-label and error-wiring evidence and the execution
records. Both reviews returned zero established defects.

| Concern | Established result and evidence | Ownership | Class | Root cause or target gap | Action and basis |
|---|---|---|---|---|---|
| Stop still depends on title id. | Ruled out: `codex-hook.ts` and `hook-receiver.ts` dispatch Stop before pane resolution; entry tests cover both configured terminals. | Review hypothesis | User-level reply capability | The prerequisite regression is removed from Stop. | Existing name-based entry and native smoke verify delivery. |
| Source shape may misclassify subagents. | Ruled out: generated 0.163.0 SessionSource/SubAgentSource matches the resolver schema; tests include each supported variant. | Review hypothesis | Internal protocol | No established gap. | Existing schema validation and source tests retained. |
| Timeout leaves a native connection running. | Ruled out: one deadline spans initialization/read, and `finally` closes the socket; fixture verifies closed peers. | Review hypothesis | Internal lifecycle | No established gap. | Existing bounded connection lifecycle retained. |
| Malformed queued events are consumed silently. | Ruled out: validation errors reach the shared watcher callback; startup wires it to the daemon log and tests execute that callback. | Review hypothesis | Internal queue | Approved design correction is implemented. | Existing callback wiring and event-error tests retained. |
| Pane Stop fallback is lost. | Ruled out: `forwardReply` keeps pane-title lookup and `(pane N)` fallback; orchestrator regression cases pass. | Review hypothesis | User-level existing reply capability | No established gap. | Existing source-tag contract retained. |
| Missing native name is an implementation omission. | Ruled out: the approved contract specifies an actionable `/rename` diagnostic; resolver tests cover missing/null/empty names. | Review hypothesis | User-level reply capability | Required naming precondition is explicit. | Existing diagnostic and operation guide document the contract. |
| Same-millisecond files could replace one another. | The writer's filename can collide for a repeated session/timestamp; reviewers found no reachable native same-session turn completion path within that interval. No defect was established. | Review hypothesis | Internal queue | No established native trigger. | Existing synchronous native Stop lifecycle and per-session queue tests retained. |
| Native smoke is merely injected Stop JSON. | Ruled out for the new smoke: actual native turns fire hooks invoking the CLI bundle, followed by watcher, bridge and recording IM. The older identity probe still uses entry fixtures for Stop/PreToolUse. | Evidence boundary | Developer verification | Evidence must distinguish these two fixtures. | Development guide records each boundary. |
| Codex never supported replies before this repair. | False: historical messages reached IM. This repair addresses the prerequisite regression introduced by PR #249 and source labeling. | Historical finding | User-level reply capability | Earlier reporting overstated the failure scope. | Baseline/history description corrected using deployment logs and original messages. |

| Review round | Promised capability defects | Outside-contract defects | Improper-use defects | Developer/operations defects | Code-quality defects |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 0 |

The actual native Stop smoke passed for two same-project roots and a later
rename with a deliberately unavailable terminal API. The full isolated unit
suite passed 1,383 tests; coverage was 88.13% lines and 83.87% branches.
The CLI bundle built and `./bin/multi-cc-im --version` returned `0.2.3`.
The dual-TUI probe passed the retained permission/question identity checks.
Feishu source tags use the existing CardKit rendering in
`packages/im-lark/src/adapter.ts`; real-account rendering and deployment
acceptance remain with the maintainer.
