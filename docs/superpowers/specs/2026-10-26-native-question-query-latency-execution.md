# Native question query eligibility and diagnostics

This records the PR #254 baseline. The subsequent user-approved
[session-name question repair](2026-10-26-codex-question-session-name-execution.md)
replaces the question pane prerequisite with current native names and request
responses. The query-order measurements below describe that earlier delivery.

## Scope and acceptance

This delivery fixes confirmed query-order and diagnostic defects in
multi-cc-im. The maintainer approved the simplified flow for these local
repairs: acceptance criteria, failing regressions, minimal changes, and required
verification. Deployment and real Feishu account acceptance belong to the
maintainer.

| Scenario | Required behavior |
| --- | --- |
| No pending question, questions for another terminal, IM mode off, missing owner, or owner for another IM adapter | Bridge delivery skips pane IO. |
| Question already displayed | Repeated delivery scans skip pane IO; disconnected replay still verifies the current pane and original owner. |
| Question closes | Notify the original owner when the current mode/owner permits it, independently of pane lookup availability. |
| No loaded Codex threads | Discovery skips pane IO and still removes existing bindings and closes their pending questions. |
| New delivery or an actual answer | Use fresh pane checks; answers validate identity before interpretation and again before submission. |
| Pane lookup fails | Report affected capabilities, the original terminal as the answer entry, socket/CLI checks, and the original nested error. Distinct causes remain visible even with an identical outer message. |

## Confirmed causes and implementation

| Path | Confirmed cause | Repair |
| --- | --- | --- |
| Bridge delivery | Pane lookup preceded mode, owner and deliverable-request checks. Startup and repeated scans waited for terminal IO even with an empty queue. | Read mode/owner, select initial delivery or disconnected replay, then query panes. |
| Closure notices | A notice needed owner/mode but also waited for pane lookup. | Read owner/mode for the original notification context. |
| Native discovery | Pane lookup ran concurrently with loaded-thread enumeration, including empty results. | Enumerate loaded threads first; reconcile an empty result without pane IO. |
| Failure reporting | Pane failures exposed only a low-level error; Codex diagnostics keyed and printed only the outer message. | Add capability/recovery context with the original cause and reuse the shared cause formatter for diagnostic identity and output. |

The repair reuses existing responsibilities: `native-questions.ts` owns mode,
owner and displayed-request state; `question-client.ts` owns loaded-thread
reconciliation; `formatErrorWithCause` already formats orchestrator diagnostics.
There are no new dependencies, public interfaces or persisted state.

The existing native-question delivery/answer regressions cover original request
IDs, owner/chat checks, secret input handling, terminal-first resolution, late
replies and disconnected replay. Discovery continues periodic fresh title
matching when loaded threads exist, including when IM mode is off. This delivery
does not change that discovery lifecycle.

## Terminal dependency boundary

Queries against the deployed WezTerm release were observed to exceed their
deadlines while render notifications continued arriving. In a continuously
drained diagnostic probe, the three request bytes remained in the server receive
queue at four samples over five seconds; the seven-second query timed out.
This establishes a delayed server-side request read in that experiment. It does
not uniquely identify the terminal's internal scheduling cause.

Required pane queries can still time out. The bridge reports that failure with
recovery instructions and retries discovery through its existing polling loop.
Its message asks the user to continue in the original Codex terminal and inspect
`WEZTERM_UNIX_SOCKET` in the shell that launched the bridge, then run the
configured WezTerm executable with `cli --no-auto-start list --format json`.
The message preserves the low-level timeout, connection or JSON error as a cause.

The changes are confined to multi-cc-im. The maintainer explicitly excluded
WezTerm source changes and custom-terminal maintenance from this task.

## Verification

| Check | Evidence |
| --- | --- |
| Bridge regression red | Nine added cases failed before the query-order repair because terminal IO happened before delivery eligibility. |
| Discovery regression red | Two added cases failed: empty loaded set queried panes; unloaded reconciliation depended on terminal IO. |
| Diagnostic regression red | Three added cases failed: missing recovery context and suppression of distinct nested causes. |
| Affected suites | 112 tests passed across bridge questions, Codex question client, WezTerm adapter and application startup. |
| Timing fixture | An 80ms terminal dependency received zero queries during empty IM-off and IM-on bridge startup. One pending request queried and delivered once. This measures the delivery component, not discovery with loaded threads. |
| Native Codex smoke | An isolated real App Server with a localhost model and recording IM passed delivery/native answers, terminal-first resolution/late reply, restart replay, and multiple questions. The terminal API is a fixture. |
| Project checks | Workspace typecheck, 1,464 tests across 78 files, CLI build and bundled `--version` (`0.2.3`) passed. |
| Coverage | Statements/lines 88.21%, branches 84.21%, functions 89.65%. |

The standalone delivery branch repeated the frozen-lockfile installation,
workspace typecheck, all 1,464 tests across 78 files, CLI build, bundled version
check (`0.2.3`), and the four-path native Codex smoke successfully before PR
submission. Coverage above records the earlier run of the same production code;
the PR's CI also enforces the repository coverage thresholds.

Regression logs and diagnostic observations are retained outside Git in the
developer's temporary evidence directory.
