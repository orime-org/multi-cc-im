# Native question terminal-query investigation

## Goal and current status

Preserve Codex native question forwarding and answer delivery, remove unnecessary
terminal-query waits, and investigate required-query latency with actionable
failure reporting. The maintainer approved the simplified flow for the confirmed
local query-eligibility defects on 2026-10-26.

The task remains in progress. Required production-GUI RPC delay is reproduced;
its internal cause and repair remain open. The earlier DD document contains an
unapproved design proposal. Its observation callback and lifecycle changes have
not been implemented.

## Confirmed product defects and repairs

| Path | Confirmed cause | Current repair |
| --- | --- | --- |
| Bridge delivery | Pane lookup preceded mode, owner and deliverable-request checks. Startup and repeated scans therefore waited for terminal IO with an empty queue. | Resolve owner/mode, select initial delivery or disconnected replay, then query panes. Keep the existing startup lifecycle. |
| Closure notices | The notice consumed owner/mode but also required a pane lookup. | Read owner/mode for the original notification context. |
| Native discovery | Pane lookup ran concurrently with loaded-thread enumeration, including empty results. | Enumerate loaded threads first; empty results still reconcile bindings and pending questions. |
| Failure reporting | Pane failures exposed only the low-level error; Codex diagnostics keyed and printed only the outer message. | Add pane capability/recovery context with the original cause; use the existing cause formatter for diagnostic identity and output. |

**Internal implementation basis:** `native-questions.ts` already owns IMWork,
owner and displayed-request state. `question-client.ts` already reconciles loaded
thread identity and owns a per-client refresh promise. The shared
`formatErrorWithCause` already formats orchestrator diagnostics. These changes
use those existing responsibilities and interfaces.

Actual answers retain fresh pane checks before interpretation and submission.
Native request IDs, original owner/chat checks, secret input handling and the
native client's final validation remain exercised by the existing regressions.
Discovery continues periodic fresh title matching when loaded threads exist.
Its observation lifecycle is independent of IMWork; suppressing that discovery
while IM mode is disabled remains an open item in the approved idle-query scope.

## Required-query observations

The deployment uses WezTerm `20240203-110809-5046fc22`. Probes selected the live
bridge's socket; a separate stale socket inherited by the development host was
not used for these measurements. Only protocol names, counts, timestamps and
process ownership were saved; terminal contents were excluded.

| Experiment | Result | Supported conclusion |
| --- | --- | --- |
| Same GUI, concurrent `list` and `list-clients`, 12-second deadlines | Both timed out; their connections received 1,399 and 1,400 render-change responses respectively. Both owned CLI processes exited. | Connection traffic continued while two different target RPC responses were absent. |
| Single `list`, four-second deadline, payload-free codec logging | `encode_async ListPanes size=3` appeared once; 480 render-change responses arrived; no list response arrived. Owned CLI exited. | The target request completed its client-side write before the response wait. |
| Same-connection Unix socket queue observation | At approximately one second, the server's receive queue still held all three request bytes; the paired client had sent three bytes and received 62,895 bytes. The query subsequently completed. | WezTerm had delayed reading this request while sending data on the same connection. |
| Owned headless mux, idle/output, primary-agent repeat | Twelve successful queries, approximately 7–17ms. | The same installed binary can complete native listing under this isolated workload. |
| Owned GUI, 29 panes, one foreground-process scan | Queries completed in 7–15ms. Only one complete scan was observed. | Continuous callback contention was not established by this fixture. |
| Owned GUI, 29 panes, bounded low-volume output | Six queries completed in 12–101ms; helpers produced 250,848 bytes over about 12 seconds. Queries during output occurred near its beginning. | This fixture did not reproduce the production delay. |

The exact release's
[dispatcher](https://github.com/wezterm/wezterm/blob/5046fc225992db6ba2ef8812743fadfdfe4b184a/wezterm-mux-server-impl/src/dispatch.rs#L47)
subscribes each connection to mux notifications, queues notifications and writes,
and arbitrates them with incoming reads. The pinned
[futures implementation](https://github.com/smol-rs/futures-lite/blob/v1.13.0/src/future.rs#L478)
prefers the first ready branch. The socket queues establish delayed server-side
reads; continuous internal queue occupancy has not been observed directly.
GUI samples also contain render work
and Lua process-info calls; they do not establish a unique cause.

The release's
[codec](https://github.com/wezterm/wezterm/blob/5046fc225992db6ba2ef8812743fadfdfe4b184a/codec/src/lib.rs#L351)
logs the encoded type/size after its write completes. This supplies the
client-side phase evidence above. It does not prove the server read the request.
The upstream [same-release report](https://github.com/wezterm/wezterm/issues/7692)
describes similar control-plane hangs; it supplies context, not local causality.

## Verification records

| Check | Execution evidence |
| --- | --- |
| Bridge regression red | Nine new cases failed because terminal IO occurred before delivery eligibility. |
| Discovery regression red | Two cases failed: empty loaded set queried panes; unloaded reconciliation depended on terminal IO. |
| Diagnostic regression red | Three cases failed: missing recovery context and suppression of distinct nested causes. |
| Affected suites | 112 tests passed across bridge questions, Codex question client, WezTerm adapter and application startup. |
| Product timing fixture | With an 80ms terminal dependency, empty IM-off and IM-on startup completed at the fixture's 0ms resolution with zero queries; one pending request queried once and delivered once. |
| Native Codex smoke | Isolated real App Server plus localhost model/recording IM passed question delivery, native answers, terminal-first resolution, restart replay and multiple questions. |
| Project checks | Workspace typecheck, 1,464 tests across 78 files, CLI build and bundled `--version` (`0.2.3`) passed after the final code change. |
| Coverage | All 1,464 tests passed under coverage; statements/lines 88.21%, branches 84.21%, functions 89.65%. |

Logs and owned-process records are retained in the developer's temporary evidence
directory. Deployment remains owned by the maintainer.
