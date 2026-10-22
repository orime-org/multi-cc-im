# Codex and WezTerm acceptance

## Scope and environment

The deployment terminal is WezTerm. The maintainer deploys the merged GitHub
code and performs real Feishu account acceptance. Development acceptance uses
an owned WezTerm window, an isolated Codex home/state directory, a localhost
Responses fixture and an in-memory IM adapter.

| Component | Version or implementation |
| --- | --- |
| Product baseline | Main commit `454af8a194a3dfd360cd04d832b5c31a45062358` |
| Terminal | WezTerm `20240203-110809-5046fc22`, actual GUI window and CLI |
| Agent | Codex `0.163.0`, actual TUI and native App Server |
| Title identity | Native `thread-id` title and current loaded thread IDs |
| Hook entry | `runCodexHookCommand` with isolated payloads/configuration |
| Question transport | Product Codex adapter and bridge orchestrator |
| Model and IM | Local fixtures |

## Execution record

| Check | Executed path | Result |
| --- | --- | --- |
| Prompt submission | Product WezTerm adapter pastes text, then sends Enter after 300ms | Native TUI submits the prompt to the local model |
| Native question identity | Actual pane title, loaded IDs and product question client | The question belongs to the created pane |
| Hook identity deadline | Product resolver with a 600ms terminal-listing limit | Correct pane identified in 6ms |
| Stop origin | Product hook entry receives a Stop fixture | Stop state file carries the correct pane and thread |
| Automatic tool approval | Product hook entry receives PreToolUse with IM mode enabled | Native `hookSpecificOutput` contains single-call allow |
| Question delivery | Real native question through the product adapter/orchestrator | Test IM receives the question and its `/answer` reference |
| Answer return | Test IM submits option 2 through the product IM handler | Native model input contains `choice.answers = ["Two"]` |
| Cleanup | Close the recorded test pane and stop the owned server | Test pane/processes exit; native server diagnostics are empty |

The hook checks exercise the production entry with supplied event fixtures.
The question check exercises an actual TUI-issued native request and verifies
the submitted answer in the next model request. These are separate checks.

The test process uses `CHOKIDAR_USEPOLLING=1` for its isolated bridge watcher,
matching the host's documented native-watcher resource limitation. Production
watcher behavior remains as described in the EMFILE recovery documentation.

The existing [two-TUI identity probe](../../../scripts/codex-identity-probe.mts)
and [question bridge smoke](../../../scripts/codex-question-smoke.mts) provide
repeatable shared-server identity, answer ordering and reconnect checks.
See [developer verification](../../dev.md#codex-native-question-bridge-acceptance)
for commands and full-suite results.

## Repository verification

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm test` | 1,303 passed; 10 watcher-event failures and 14 EMFILE errors |
| `CHOKIDAR_USEPOLLING=1 pnpm test` | 1,313 passed |
| `CHOKIDAR_USEPOLLING=1 pnpm exec tsx scripts/codex-question-smoke.mts` | IM-first, terminal-first, late answers, restart replay and multiple questions passed |
| Native adapter tests in an independent `origin/main` checkout | The same 10 failing cases and 14 EMFILE errors |

The branch changes documentation. Its production code, tests, dependency
manifests and lockfile match the product baseline above.

## Deployment acceptance

After deploying the GitHub code, select Claude Code/Codex as needed and select
`wezterm` in the wizard. Review Codex hooks with `/hooks` and enable `thread-id`
with `/terminal-title` in an already-running TUI. In Feishu, use `/start` and
`/list`, send a message to `#<tab title>`, then answer a native question through
the bot. Real Feishu delivery and account configuration are verified by the
maintainer in that deployment environment.
