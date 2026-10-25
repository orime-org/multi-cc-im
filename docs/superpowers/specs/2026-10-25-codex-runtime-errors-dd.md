# Codex runtime failures and version diagnostics

## Approved outcome

The maintainer requires version-independent operation: attempt the existing
native protocol, and report actual failures with the observed runtime version,
operation, original reason, and recovery instructions. There is no version
allowlist, range, startup version probe, or admission decision based on version.
The maintainer reports Claude works, Feishu-to-Codex works, and Codex replies
do not reach Feishu after upgrading. Deployment remains maintainer-owned.

## Current evidence

Baseline: `9f8a4097aa3d6e8d933f8c93bbebcb8ef9269df2`.

| Observation | Evidence |
| --- | --- |
| Initialization rejects every user agent except `/0.163.0`. | `packages/cli-codex/src/app-server-protocol.ts:22-25` |
| Stop name lookup applies that check before sending `thread/read`. | `stdio-metadata.ts:60-65`; `session-name.ts:33` |
| A missing resolved name prevents writing the reply event. | `hook-receiver.ts:548-549` |
| Questions and permission-origin discovery use the same check. | `local-client.ts:88`; `question-client.ts:110-113`; `hook-origin.ts:26` |
| Both transports discard RPC error code/message. | `local-client.ts:78`; `stdio-metadata.ts:60` |
| The Stop diagnostic hardcodes a tested version. | `session-name.ts:42` |
| Installed 0.164.0 initializes successfully in an isolated home. | Native probe on 2026-10-25: `codex-cli 0.164.0`; initialize returns matching home and Unix platform. |
| Native failures already carry useful details. | Same probe: `thread/read` of an absent UUID returns code `-32600`, message `thread not loaded: <requested UUID>`. |

The isolated probe used an owned stdio process, no model calls or real IM.
Its child exited normally and a subsequent process check found it absent.
Local evidence is retained outside Git; machine-specific paths are omitted here.
The [official protocol documentation](https://learn.chatgpt.com/docs/app-server#message-schema)
specifies replies containing either a result or an error with code and message.
These observations establish the specific tested operations, not all APIs.

## Decision and alternatives

This corrects the existing integration within `cli-codex`; it selects no new
dependency, storage format, process model, or cross-package interface.

| Candidate | Evidence and outcome |
| --- | --- |
| Add 0.164.0 or an allowed range | Retains the same unsupported inference from a version string; explicitly rejected by the maintainer. |
| Remove only the comparison | Restores successful initialization but retains discarded RPC errors and fixed-version recovery text at the cited sites; does not satisfy the approved diagnostic outcome. |
| Remove admission checks and retain actual runtime failure context | Uses the existing official initialize and error responses, preserves identity checks, and satisfies the maintainer's approved outcome. Selected. |
| Replace transport or parse private Codex storage | Neither native evidence nor the cited code requires either change; outside the approved repair. |

## Implementation contract

Initialization still validates the selected home and platform. `userAgent` is
optional diagnostic input; missing, malformed, unfamiliar, older and newer
values cannot reject otherwise valid operations. Extract the observed version
token without comparing it with a supported set. Before initialization, or when
the response supplies no usable token, report `unknown` explicitly. Do not run a
separate version command inside a hook or use the installed binary's version to
misidentify an already running server.

One shared formatter retains operation, observed version, original error and
cause, and terminal recovery instructions. RPC errors retain their integer code
and message; do not serialize optional error data, request params or credentials.
Already contextualized errors are not repeatedly wrapped. Each local pending
request retains its method. The local client exposes its observed version for
response-schema failures in its callers. The stdio reader returns the response
and observed version together, so subsequent metadata validation has the same
context. Both are package-internal contracts.

Stop failures explicitly say the reply was not forwarded; existing `/rename`
guidance remains. Question and permission-origin errors retain their existing
sinks and native-terminal handling. Loaded-thread, exact identity, root-source,
secret-question, answer-validation and single-home restrictions remain intact.

## Lifecycle invariants

No lifecycle transition is added or removed. The stdio state owner remains
`readCodexThreadMetadata`; existing states and events are reproduced below from
`stdio-metadata.ts:27-88`. `outcome` is written only by `close`.

| State | Matching initialize reply | Matching read reply | Notification | Failure / timeout / early EOF | Child close | Late IO error |
| --- | --- | --- | --- | --- | --- | --- |
| initializing | Capture version; validate home/platform; reading, or close with actual failure | Wrong response id: close with failure | Consume | closing with failure | finished; reject | closing with failure |
| reading | Wrong response id: close with failure | closing with selected result/error | Consume | closing with failure | finished; reject | closing with failure |
| closing | Ignore | Ignore | Ignore | Ignore new primary outcome | finished; settle selected outcome | Add raw error identity to diagnostics |
| finished | Ignore | Ignore | Ignore | Ignore | Listener is once-only | Ignore |

Closing ends owned stdin and uses the existing bounded TERM/KILL timers.
The total budget remains capped at 800 ms. Valid metadata survives abnormal
cleanup. Preserve raw error identities in the diagnostic set, then contextualize
on emission, so stdout/readline forwarding is reported once. The selected
failure retains its operation at selection time. Local client pending calls
retain their existing resolve/reject/timeout/disconnect lifecycle. Reconnection
and question de-duplication remain in their existing owners.

## Acceptance

| Case | Required observation |
| --- | --- |
| Arbitrary version or unusable version metadata | Stop reads the exact native name; questions attach and answers return through the existing channel. |
| Wrong home/platform | Actual validation error; no request against an unvalidated identity; observed version retained when supplied. |
| RPC failure | Operation, version or explicit unknown, original code/message and recovery guidance reach the existing sink. |
| Invalid result after successful initialize | Method and observed version remain available, including Stop metadata and loaded/read/resume schemas. |
| Cleanup faults | Selected result/failure preserved; distinct late errors reported, forwarded same-identity error once. |
| Native upgraded runtime | Actual 0.164.0 Stop reaches bundled entry, reply queue and recording IM with exact name/text; native question smoke succeeds. No real deployment. |
| Existing behavior | Claude regression tests, all required tests/typecheck, production build and bin load pass. |

## Execution record

Acceptance on 2026-10-25:

| Check | Result |
| --- | --- |
| TDD regression run before implementation | 30 failed / 73 passed across the three targeted files; version acceptance and diagnostic assertions fail on the baseline. |
| Final Codex package tests | 227 passed in 12 files. |
| Full suite with coverage | 1,448 passed in 78 files; statements/lines 88.19%, branches 84.05%, functions 89.63%; all 80% thresholds passed. |
| Typecheck | All workspace packages passed. |
| Production build and `./bin/multi-cc-im --version` | Passed; bundle loads and reports `0.2.3`. |
| Installed 0.164.0 native Stop smoke | Two same-project sessions delivered exact names and bodies through actual Stop hooks, bundled entry, shared watcher, bridge and recording IM. A third reply used the renamed native session. Terminal API was unavailable and inherited pane was unrelated. |
| Installed 0.164.0 native question smoke | IM-first, terminal-first, late replies, restart replay and multiple questions passed through product bridge/test IM back to native model input. |
| Actual native RPC failure through the product reader | Nonexistent UUID produced `thread/read`, observed `0.164.0`, original `-32600` and `thread not loaded` message, and recovery instructions. |
| Owned process cleanup | Bounded smoke drivers and their recorded native fixture processes exited; subsequent process checks found those PIDs absent. |

Native filesystem watching on this host reported EMFILE in the initial Codex
adapter test run. Final watcher-based tests and smokes used
`CHOKIDAR_USEPOLLING=1` only in their own process environments. No user process
was terminated and no user-global configuration or hook installation changed.
Native smokes used temporary homes, localhost model fixtures and recording IM;
the maintainer performs deployment and real Feishu account acceptance.

The earlier 0.163.0 measurements remain historical evidence; this decision
supersedes runtime version admission. The historical identity research probe
still names its original measured version; it is not a product activation path.
