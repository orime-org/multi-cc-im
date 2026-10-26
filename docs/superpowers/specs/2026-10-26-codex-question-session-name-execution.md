# Codex native questions by session name: execution record

## Goal and verified cause

The user confirmed that ordinary Codex/Claude messages work and approved
repairing native question forwarding using the `/rename` session name.
At main `40e7f5f`, discovery and answer eligibility required terminal pane
listing and title-ID matching. The native request already carried its original
thread/request identity, and `thread/read` supplied the name. Terminal listing
was therefore a prerequisite introduced by the question implementation.

The accepted [design](2026-10-26-codex-question-session-name-dd.md) uses the
existing local native connection for loaded-thread metadata, subscription and
the original native answer. It changes the question record to `sessionName`
and exposes the existing serialized `refresh()` operation. The permission-hook
matcher, ordinary routing and Stop paths retain their established contracts.

## Implementation and regression evidence

| Acceptance | Execution and result |
| --- | --- |
| Name-driven discovery and delivery | Native client and Bridge regressions first failed against the pane-based implementation. The affected client/Bridge/orchestrator suites then passed. Missing, null, empty, blank and duplicate names receive `/rename` diagnostics; other unique names remain eligible. |
| Fresh name before interpretation | Tests rename or duplicate a name after the last discovery poll and immediately answer. The interpreter receives the refreshed unique name; invalid naming prevents interpretation and submission. |
| Rename during interpretation | A retained review finding was reproduced in the production Bridge. Two failing regression variants preceded the captured-input-name fix. The native request remains the answer target when the current name changes during interpretation. |
| Question protocol and unavailable terminal | `scripts/codex-question-smoke.mts` ran actual Codex 0.164.0 with a disposable home, localhost model and recording IM. It passed IM-first and terminal-first answers, late replies, restart replay, multiple questions and a native rename during interpretation. Terminal queries and terminal input were both zero. |
| Two real native TUIs | `scripts/codex-identity-probe.mts` ran Codex 0.164.0 in two owned PTYs. Each question name was checked against its actual TUI thread; separate answers reached the local model input. The same fixture passed production Stop names and permission-hook origin checks. The script records the observed version. |
| Ordinary Codex Stop | Actual native hooks through the built CLI, shared watcher and recording IM passed two same-project sessions and a renamed session while the terminal API was unavailable. |
| Claude and mixed dispatch | Isolated production hook/receiver/watcher checks passed ordinary name routing, Stop, PreToolUse allow/deny, PermissionRequest and AskUserQuestion. Orchestrator regressions cover these Claude dispatch paths while a Codex native question is pending. |
| Failure and lifecycle handling | Client/Bridge tests and an independent socket probe cover wrong owner/chat, wrong interpreter target, duplicate names and recovery, disconnect/reconnect, original request IDs, secret inputs and late answers. |
| WezTerm diagnostic | Failing timeout/invalid-JSON assertions preceded the error-text correction. The adapter identifies pane routing and permission origin lookup as affected capabilities and retains the original cause and socket/CLI checks. |

The model and IM implementations in these checks are fixtures. Actual Codex
and the production native client/Bridge run against them. The maintainer owns
deployment and real Feishu account acceptance. Fixture shutdown awaits its
owned server/TUI processes and removes its disposable home.

## Independent review

The design review found the missing awaitable metadata-refresh interface.
The user accepted exposing the existing refresh before implementation.

| Implementation review | Frozen commit | Retained result and verification |
| --- | --- | --- |
| First | `c0958c0` | Two within-promise findings: rename during interpretation rejected a valid result, and the WezTerm diagnostic described the former question dependency. Both were personally reproduced, fixed in `34ae781` and regression-tested. |
| Second | `34ae781` | No retained code finding. The reviewer ran independent lifecycle/fix probes; the implementer reran both probes, including duplicate-name recovery, disconnect/reconnect and late answers. |

| 轮次 | 承诺内 | 承诺外 | 不正当使用 | 开发/运维级 | 代码质量 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 0 | 0 | 0 | 0 |
| 2 | 0 | 0 | 0 | 0 | 0 |

The original review returns and execution logs are retained outside Git. The
two rounds were checked against their original session records; counts describe
each review at its frozen commit.

During documentation synchronization, the caller scan found the optional
two-TUI script still using the removed question `paneId`/`listPanes` interface.
Commit `331363d` aligns that test caller with the accepted name contract. Its
standalone TypeScript check and actual two-TUI smoke passed, followed by an
independent read-only caller verification. Production code matches `34ae781`.

On 2026-10-26 the user accepted the recommendation to use real protocol and
message-content verification and exempt this terminal/Feishu interaction from
the web-specific visual-adversary procedure.

## Final verification

| Check | Recorded result |
| --- | --- |
| Main synchronization | Latest `origin/main` was `40e7f5f`; the task branch was already up to date before final checks. |
| Workspace typecheck | `pnpm typecheck` passed. |
| Full unit suite | `CHOKIDAR_USEPOLLING=1 pnpm test:coverage` passed 1,475 tests across 78 files. |
| Final coverage | 88.23% statements/lines, 84.32% branches and 89.82% functions. |
| CLI build and bundled load | `pnpm --filter multi-cc-im build` passed; `./bin/multi-cc-im --version` returned `0.2.3`. |
| Standalone two-TUI script typecheck | Passed with strict TypeScript, bundler resolution and JSX enabled for the imported monitor code. |
| Final product smokes | Native question, bundled native Stop and Claude hook/Bridge smokes passed after the final CLI build. |
| Wording review and links | Independent review checked 14 documents and new comments/diagnostics with no retained finding; 24 added/changed Markdown relative links resolved. |

The complete branch diff was checked against main. The repository has no lint
script. Final logs and the original review returns are retained outside Git;
the PR records the executed checks. Real Feishu deployment acceptance belongs
to the maintainer.
