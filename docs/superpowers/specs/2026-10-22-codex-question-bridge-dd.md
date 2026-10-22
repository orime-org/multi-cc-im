# DD: Codex question forwarding without owning the TUI

Date: 2026-10-22. Status: local App Server transport and official title identity
accepted by the user; implemented in this change. The disproven hook-pane
registration is withdrawn. The selected source and verification evidence live in
[thread identity DD](2026-10-22-codex-thread-identity-dd.md).
The existing CLI/router backend and plan viewer remain separate capabilities.

## Problem and boundaries

Codex's `request_user_input` cannot be answered by Claude's
`allow + updatedInput.answers` hook contract. Its native answer is an App Server
response keyed by request id, with `answers[questionId].answers` string arrays.
At the start of this work the bridge only special-cased Claude `AskUserQuestion`;
its Codex SessionStart handler was a trace-only no-op and supplied no authoritative
live native thread-to-terminal-pane identity. Matching by cwd/title alone
would not distinguish concurrent sessions in one project.

Requirements: preserve the user's existing Codex TUI; keep IMWork/IMOrigin and
owner gates; do not create user sessions, own stdin/stdout, parse terminal
escape sequences, auto-answer questions, or turn questions into command
approvals. Added transport must remain on the local machine. The user retains
the ability to answer in the terminal while IM is connected.

## 1. Candidate enumeration

| Candidate | Mechanism |
|---|---|
| A. Keep terminal-only answers | No new integration; user must return to the native prompt. |
| B. Hook-only answer injection | Rewrite PreToolUse input or return a decision/reason containing answers. |
| C. Terminal widget automation | Use existing terminal send-text to select widget choices. |
| D. Official App Server cooperating client | Attach to the existing loaded thread through its local Unix socket and answer native requests. |
| E. Replace/wrap/fork the TUI | Own a new Codex process or parse its terminal output. |
| F. Separate SDK/API/session | Ask another model/session to interpret or answer, without the original request channel. |
| G. Custom MCP elicitation tool | Introduce another tool/protocol in place of the built-in question. |

D may use the existing `ws` library (already directly installed for the plan
viewer); the alternative of hand-writing WebSocket framing is rejected by the
project's existing-library rule. `codex app-server proxy` transparently forwards
socket bytes; it does not turn this connection into newline JSON. The App Server
can generate TS/JSON schemas using its built-in generation subcommands.

## 2. Due diligence and evidence

Evidence identifiers:

- E1: [Official App Server requests](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput): native request/response and `serverRequest/resolved` lifecycle.
- E2: Pinned Apache-2.0-licensed [Codex 0.163.0 request handler](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/tools/handlers/request_user_input.rs): input is questions; responses arrive through the request-user-input operation, not a hook input `answers` field.
- E3: Pinned [outgoing request engine](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/outgoing_message.rs): sends to subscribers, replays pending requests on reattachment, and consumes an ordinary callback once. Connection-exclusive user verification requests have a separate ownership check and are outside this proposal.
- E4: Pinned [upstream integration tests](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/tests/suite/v2/request_user_input.rs): plan-mode blocking requests and default-mode non-blocking requests, native answer map, and resolved-before-completed notification.
- E5: Actual installed 0.163.0 binary: an isolated Unix-socket App Server, two fixture clients, and a localhost fake model provider passed all four probes below. No real TUI/session/daemon was attached; no external model call or IM message was used.
- E6: Current `packages/cli-codex/src/hook-receiver.ts::handleSessionStart` is a no-op; current orchestrator question extraction matches Claude's tool name. These are product wiring gaps, not missing native API capabilities.
- E7: Existing plan-viewer code/tests already use `ws` 8.20.0 over Unix sockets and zod validation. That observer intentionally never responds to requests and must stay observational. This is evidence for local transport reuse, not evidence that a production answer bridge already exists.

### Actual multi-client probe results (E5)

1. A fixture originating client starts a plan-mode question. The second client
   attaches to that loaded thread and receives the pending question. Its answer
   resumes the model; both clients receive resolved. A later conflicting answer
   from the first client is ignored; only the first answer reaches the model.
2. Disconnecting the observing client leaves the originating client able to
   answer and finish the turn.
3. A reconnected subscriber receives the still-pending question replay and can
   answer using the original request id.
4. Interrupting the turn publishes resolved and clears the pending question.

An initial attempt to attach immediately after thread/start, before any first
turn had created a rollout, returned no-rollout-found. Discovery must wait for
an existing usable thread and retry without starting/reviving sessions. Real
TUI widget rendering, real IM interaction, default-mode non-blocking delivery,
and shutdown races still require product acceptance tests after implementation.

The model fixture explicitly generated question tool calls and recorded the
next model input, which distinguishes a native answer from an injected chat
message. Both clients and the server were created solely for this probe; only
these owned fixture processes were stopped.

## 3. Comparison matrix

| Candidate | Can answer original request | Keeps native TUI | Request identity/races | Maintenance and security evidence |
|---|---|---|---|---|
| A | Terminal only | Yes | Native handling | E1/E4; does not satisfy mobile-answer requirement. |
| B | No documented answer channel | Yes | Hook output is not the pending native response | E2; inventing answer injection would not implement the consumer's contract. |
| C | Can press widget controls | Process survives | No verified binding of keystrokes to request/turn; user may change focus/widget | E3/E5 provide a native identity channel instead; terminal state scraping violates project constraints. |
| D | Yes, actual probe | Yes at protocol level | Native request id, first answer wins, resolved/replay/cancellation verified | E1/E3/E4/E5; existing ws/zod transport E7; same-user Unix socket, no added external service. |
| E | Yes only after replacement/custom fork | No | Requires process/UI ownership | Violates existing core constraint; duplicates upstream runtime maintenance. |
| F | Does not resolve the existing TUI request by itself | Separate session | Still needs E1's original callback channel | E1/E2; introduces unrelated auth/state/model work rather than completing the original request. |
| G | Only its own new elicitation | Existing built-in question remains unanswered | Different request/protocol | E1/E2: MCP elicitation is a separate server-request family; cannot substitute it for a pending built-in request. |

No extra runtime dependency is being selected/added in this DD. If D is
accepted, dependency placement must make ws a declared production dependency
where used; relying on root devDependencies or transitive hoisting is invalid.
The supported Codex protocol version must be checked and generated schemas
validated before activation. A transport error must defer to the existing TUI,
without restarting or starting a user thread.

## 4. Recommendation and concrete implementation boundary

Recommend D, based on its verified native consumer contract (E1/E2), reliable
multi-client lifecycle (E3/E5), and existing local transport (E7). It restores
the mobile-answer capability while keeping the TUI as an equal client.

Implemented product flow (identity source revised by the accepted identity DD):

1. Use official TUI `thread-id` prefixes and structured raw terminal titles,
   strictly and uniquely matched against current native loaded ids. Use the same
   source for questions, Stop and permission hooks; never infer pane identity from
   the server's inherited environment, cwd or friendly name. Reject missing,
   ambiguous, unloaded or multiply displayed identities. No pane registration is
   persisted; restart rediscovers live native/terminal state.
2. A dedicated Codex client attaches only to uniquely associated loaded root
   threads. It handles only the explicit native question shape. The independent
   plan panel continues to observe and never answer.
3. When IMWork and valid owner/IMOrigin gates allow forwarding, send numbered
   options/free-text instructions and record thread/turn/item/request/question
   ids. Questions require the user's actual answer even in command auto mode.
4. Reuse the established natural-language answer interpreter with the selected
   CLI; map validated question ids/options to native string-array answers.
   Never accept generated permission grants or treat this as an approval hook.
5. Answer through the native callback. A resolved/completed/interrupted event
   removes the pending IM question. A late reply says the question has already
   been resolved. On disconnect, retain display state, reattach and reconcile
   native pending replay before accepting replies. Do not send chat input as a
   fallback and do not synthesize an answer on timeout.
6. Keep original terminal interaction available. Other App Server request
   families (command/file/permission approvals, OAuth/user verification, MCP
   URL flows) remain on their current native path unless separately designed.

Acceptance matrix: terminal-first and IM-first answers; repeated/late replies;
multiple questions and same-project sessions; auto/off IM modes; IM disabled;
malformed answers; disconnected IM/App Server; daemon restart; native timeout;
turn interruption; pane/thread replacement; existing sessions without a fresh lifecycle hook; default-mode non-blocking requests; full package/bundle smoke.
Use isolated fake providers/clients before any real-account smoke.

## 5. User decision

The user accepted the local App Server approach after clarifying the distinction
between protocol feasibility and product implementation: “哦，明白了，那你继续工作。”
Implementation and isolated product-chain tests followed, but those tests injected
pane identity. A subsequent real two-TUI/native-hook test disproved the automatic
registration premise: both hooks inherited the shared server's pane, despite two
distinct client panes. The unsafe registration implementation was withdrawn.

The user subsequently selected official `thread-id` title discovery explicitly,
including its visible title item and pausing on ambiguity. The production hook
origin and question client now share that matcher. The actual two-TUI probe
checks correct hook entry routing and separate product-client answers in each
native model input. A separate real-server/product-bridge/fake-IM smoke covers
IM-first, terminal-first, late replies, restart replay, default-mode and multiple
questions. Neither fixture sends real IM or calls an external model provider.

The current supported protocol is pinned to 0.163.0 and the selected single
Codex home. The native APIs remain private local socket operations; the existing
enabled owner IM workflow carries question content. Secret questions remain
terminal-only. Live WezTerm acceptance verifies prompt submission, native title
identity and a question through the product bridge/test IM back to native model
input. The actual iTerm2 Python helper has a separate raw-title API contract
fixture. Real Lark account acceptance belongs to the maintainer's GitHub
deployment. See the [WezTerm execution record](2026-10-22-codex-wezterm-acceptance.md)
and developer instructions for verification.
