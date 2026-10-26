# Codex native questions by session name

## Goal and authority

Repair Codex native question forwarding and answering using the session name
set with `/rename`, with the question transport independent of pane listing.
The user confirmed on 2026-10-26 that ordinary Claude/Codex messages already
work and narrowed this repair to native questions and their window queries.
Existing Claude paths and ordinary Codex messages are regression acceptance.
The user owns real deployment and merging.

The user's naming contract is authoritative: use the session name to identify
the user-facing Agent; report duplicate names for the user to resolve. Native
thread/request IDs remain transport fields for the corresponding Codex RPCs.

## Current implementation and verified cause

| Fact | Evidence at main `40e7f5f` |
| --- | --- |
| Question discovery reads loaded thread IDs, lists terminal panes, matches title IDs, then subscribes to the matched threads. | `packages/cli-codex/src/question-client.ts:111-140`; `thread-identity.ts:15-26`. |
| Discovery refreshes before delivering and submitting a question. | `question-client.ts:82-85,160-175`. |
| Bridge delivery and answer eligibility also require pane listing; the displayed source label is the pane title. | `packages/bridge/src/native-questions.ts:95-97,102-136,149-152`. |
| The shared question record requires a pane ID. | `packages/shared/src/adapter/cli.ts:188-199`. |
| Stop replies already read the native session name from metadata. | `packages/cli-codex/src/session-name.ts:24-48`. |
| Ordinary routing resolves the user's name to a terminal pane; Claude hooks carry their original session/request IDs. | `packages/bridge/src/matcher.ts:54-87`; `orchestrator.ts:1054-1105`; `packages/cli-cc/src/hook-receiver.ts:313,330-338,734-741`. |

The question module introduced a physical-pane prerequisite into a native
request/answer flow. Consequently its discovery, delivery and answer checks
can wait on terminal listing. PR #254 removed queries for empty/ineligible
work, but loaded native threads and real questions still take that path.

### Native protocol evidence

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
states that `thread/read` supplies `thread.name` after naming, that a resumed
thread supplies request events, and that answering `item/tool/requestUserInput`
resolves the original request. The existing local WebSocket client exposes
`call` and `respond` (`packages/cli-codex/src/local-client.ts:11-20`).

A separate protocol probe ran the installed Codex 0.164.0 with a disposable home,
a localhost fake model and two cooperating socket clients. It named a loaded
thread, read that exact name from the observer, subscribed, received a question,
responded with the original RPC request ID, and verified the chosen answer in
the model's next input. Terminal queries were zero. The owned server exited and
the disposable home was removed. This proves protocol feasibility; product
integration remains to be implemented and tested.

The raw probe and result are retained outside Git under the local temporary
`mcim-native-name-probe` evidence directory. No real IM/model account was used.

## Candidate review and decision

| Candidate | Evidence, fit and maintenance implications | Decision |
| --- | --- | --- |
| Existing native metadata and response transport | Both capabilities already exist in the repository; the real protocol probe verifies name plus request/answer without pane IO. | Adopt. |
| Match native names against terminal titles before subscribing | Requires listing the terminal and title parsing in the question path. | Retains the dependency responsible for this repair. |
| Match native title IDs before subscribing | Current implementation has the same terminal dependency and requires a visible ID. | Conflicts with the user's naming contract. |
| Maintain a hook-written name registry | Adds persisted state and synchronization to information already supplied by `thread/read`. | Native metadata supplies the required information. |
| Read private transcripts or SQLite metadata directly | Adds a second upstream storage-format dependency; native metadata already returns the name. | Native metadata supplies the required information. |
| Replace or modify Codex/WezTerm | Requires a custom runtime deployment and maintenance. | User explicitly excludes terminal source changes; project preserves existing TUIs. |

**Internal implementation choice:** reuse the existing native connection,
metadata read, question reference, answer interpreter and response writer.
There is no library selection. Current runtime dependencies remain `ws` 8.20.0
(MIT) and `zod` 3.x (MIT), with existing workspace packages.

## Proposed change

| Surface | Final behavior |
| --- | --- |
| `CLIQuestionRequest` | Replace question-only `paneId` with `sessionName`; retain existing terminal mode scope and native request IDs. |
| Codex question discovery | Read the current loaded root threads through the existing connection. Validate each returned thread ID, source and active/idle status and collect its nonempty native name. Subscribe to uniquely named eligible threads. |
| Missing or duplicate name | Report the current name problem with `/rename` guidance. Affected questions remain available in Codex; the user resolves names. Other uniquely named threads remain eligible. |
| Question binding | Bind the native thread to its current session name; retain the existing per-connection lifecycle and pending request references. |
| Awaitable question refresh | Expose `refresh(): Promise<void>` on `CLIQuestions`, delegating to the client's existing serialized `refresh()` operation. Its settlement makes the refreshed or unavailable binding state visible through `listPending()`. |
| Rename | Refresh native metadata before delivery and submission. A unique current name becomes the source label for subsequent messages; the original pending question reference continues identifying the same request. |
| Bridge delivery | Check existing IMWork, owner, adapter and pending-request gates. Use `request.sessionName` as the source tag. |
| Answer submission | After the owner/chat gate, await `questions.refresh()` before interpreting an answer, then read the current request and its name from `listPending()`. Reuse the native client's existing refresh before final submission and write the original native response. |
| Secrets, completion and disconnect | Preserve existing terminal-answer guidance for secrets, completion/late-reply handling, disconnected state and native replay. |
| Application wiring | Remove the pane-list dependency from the native question client and bridge question options. |
| Existing shared paths | Claude hooks, ordinary name routing, Codex Stop replies and permission hooks keep their current implementations. The terminal title installer is outside this narrowed repair. |

Only the question record is consumed by the question client, question bridge and
their callers/fixtures. The existing shared `matchCodexThreads` helper remains
used by permission hooks. No persisted state or external format changes.

## Lifecycle

Binding states are `absent`, `subscribing`, `ready` and `name-error`.
`refresh` is their single metadata-driven writer; disconnect/stop clears the
connection's bindings. A ready binding has exactly one eligible loaded native
thread for its current name. Subagents follow the existing exclusion.

Request states remain the existing `pending`, `submitted`, `resolved`,
`disconnected`, `replaced`, and `terminalOnly` display states. The native client
is authoritative for whether a request is still pending.

| Current request state | Metadata remains valid or unique rename | Name missing/duplicate, thread unloaded | User answer | Native resolution/completion | Disconnect | Reconnect/replay |
| --- | --- | --- | --- | --- | --- | --- |
| pending | Refresh source name, retain reference | Close answerability with existing replaced handling and actionable name diagnostic | Validate then submit original request | Resolve/remove | Pause phone answers | Reconcile native pending request before delivery |
| submitted | Refresh binding; keep submitted status | Remove current answerability | Existing already-submitted response | Resolve/remove | Pause; native replay decides status | Reconcile native pending request |
| terminalOnly | Refresh source name | Close answerability | Existing terminal-only guidance | Resolve/remove | Pause | Replay terminal-only guidance |
| disconnected | Await valid native replay | Remain unavailable | Existing unavailable response | Native resolution removes pending entry | Remain paused | Restore only a matching native pending reference |
| resolved/replaced | No active request to submit | Remain closed | Existing ended-question response | Remain closed | Remain closed | Fresh native pending delivery follows existing reference handling |

The table describes retained lifecycle behavior with the metadata source
changed. Implementers must verify native replay and rename ordering in tests;
this draft does not treat the protocol probe as lifecycle acceptance.

## Acceptance and verification

| Item | Output and level | Verifiable result |
| --- | --- | --- |
| Native question works without terminal listing | User-level, within promised question forwarding | With a named loaded thread, discovery, delivery, interpretation and answer submission complete while the terminal API is unavailable; question code performs zero pane queries. |
| Name is the visible source | User-level, within naming contract | Native `/rename` name appears in question and follow-up labels; a unique rename refreshes subsequent labels. |
| Immediate reply after a naming change | Test code for the naming contract | After the last periodic poll, rename or duplicate a name and immediately reply. The interpreter receives the current unique name, or the naming error prevents interpretation/submission. |
| Naming errors | User-level, within naming contract | Missing/duplicate names report `/rename` guidance; valid uniquely named sessions remain answerable. |
| Answer correctness | User-level, within question contract | Original native request/question IDs receive the user's answer; owner/chat, secret input, terminal-first answer, late reply, reconnect and restart replay regressions pass. |
| Ordinary messages | Regression of user-level promises | Existing Codex Stop/name replies and ordinary IM name routing pass; Claude ordinary messages, Stop, approvals and AskUserQuestion pass. |
| Mixed clients | Regression of user-level promises | An active Codex question keeps explicit Claude normal messages/approval/question replies on their existing dispatch paths. |
| Automated and real protocol checks | Test code | Failing regressions precede production changes; affected suites and the isolated real Codex product smoke pass. |
| User guidance | Documentation | Architecture, conventions, README pair and relevant question DD describe the current question name flow and actionable failures. |

Required project checks remain workspace typecheck, full tests/coverage, CLI
build and bundled version load. Manifest changes additionally require frozen
installation. User dotfiles are checked unchanged if affected. Deployment and
real Feishu account acceptance remain owned by the maintainer.

This changes the shared question interface and request lifecycle identity source;
it follows the design and independent review flow before implementation.
The accompanying [flow demo](2026-10-26-codex-question-session-name-flow.html)
shows the proposed backend path and its naming-error branch.

## Design review correction

The independent review of `da1d481` retained one interface omission: the draft
required current native metadata before answer interpretation while
`CLIQuestions` exposed only synchronous `listPending()` and final `answer()`.
The existing client refresh was private, and final answer validation happened
after interpretation. Source inspection confirmed this design interface omission.

The user accepted exposing the existing awaitable refresh on 2026-10-26.
The corrected interface and immediate-reply regression above specify how the
Bridge obtains the current name before interpretation. The protocol experiment
continues to be feasibility evidence; integration tests remain the acceptance
for the implementation.
