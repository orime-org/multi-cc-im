# Codex integration audit

Date: 2026-10-22. Status: protocol/configuration and selected-backend routing repairs implemented;
new question transport and permission-policy changes remain outside implementation. Baseline: the current working tree and official
Codex `rust-v0.163.0` source/schema. No real IM messages were sent and no user
session was restarted, interrupted, or given a new prompt during this audit.

## Existing communication path

The integration already has a Codex CLI adapter, hook installer, wizard CLI
selection, and a Codex headless router. IM input is pasted into the selected
terminal pane and submitted separately. A Codex Stop hook writes the common
state-file protocol; the daemon forwards the reply through the IM adapter.
One shared watcher is intentionally used when Claude Code and Codex are both
enabled (`apps/multi-cc-im/src/start.ts`).

This establishes the code path, not a claim that the current installation has
passed a real-account Codex/IM round trip. Existing EMFILE handling remains the
merged PR #246 work and is outside this audit's proposed changes.

## Confirmed gaps at audit time

| Priority | Finding and evidence | Effect | Proposed scope |
|---|---|---|---|
| P0 | `packages/cli-codex/src/setup-hooks.ts::pruneExistingHooks` treats every property of `[hooks]` as an event array and reconstructs third-party handlers using only `type/command/timeout/statusMessage`. An in-memory call to this exported function discarded `hooks.state`, `async`, and `additionalContextLimit`. | Setup can erase persisted trust/disabled state and change other hooks. Since the original state table is omitted, the idempotency comparison also ceases to be a no-op once trust exists. | Preserve non-owned configuration and exact third-party handler fields; edit only this integration's handlers. Back up before any user-file write; verify two consecutive setup runs preserve trust and byte-stable no-op behavior. |
| P0 | `packages/cli-codex/src/hook-receiver.ts::PermissionRequestHookOutput` and its allow/deny/timeout branches emit top-level `decision`. The pinned official output schema requires the decision inside `hookSpecificOutput` with `hookEventName: PermissionRequest`. | The IM response does not occupy the field the current Codex protocol consumes; bridge auto-allow cannot be assumed to suppress the native prompt. | Correct and validate all response branches against the actual upstream consumer/schema. Preserve the established user's auto/ask choice; do not silently change the approval policy. |
| P1 | `packages/cli-codex/src/payloads.ts` requires `agent_id` and `agent_type` on PreToolUse and PermissionRequest. The current official input schema does not require them. An in-memory call to the real parser rejected an otherwise valid minimal PreToolUse input for these two fields. | A valid main-thread hook payload can be rejected before dispatch. `core/src/hook_runtime.rs::thread_spawn_subagent_hook_context` returns `None` outside spawned subagents, consistent with optional agent metadata. | Follow upstream optionality and add consumer-shaped fixtures. Do not require subagent metadata to process a main-thread tool. |
| P1 | `packages/bridge/src/ai-router-codex.ts` passes `--dangerously-bypass-hook-trust` and claims this prevents hooks from running. The official CLI/docs define it as allowing enabled hooks to run without persisted trust. | Unreviewed user/project/plugin hooks can run inside the routing subprocess. Removing terminal environment variables does not disable arbitrary hooks. | Explicitly disable ordinary hooks for the triage invocation using the supported hook feature configuration; remove the trust-bypass flag. Verify hook execution with an inert local marker fixture before any account smoke. |
| P1 | `start.ts` selects Codex only for the ordinary `aiRouter`. `orchestrator.ts` still defaults `aiAskUserQuestionRouter` and `aiPermissionRequestRouter` to functions in `ai-router.ts` that spawn `claude --print`. | A Codex-only installation can route ordinary messages while natural-language approval/question interpretation still depends on Claude Code. | Wire the selected routing CLI through every relevant interpretation path, retaining deterministic reply paths. |
| P1 | The Codex hook installer matches all PreToolUse calls. In ask mode the receiver forwards every matched tool as allow/deny. `orchestrator.ts` handles clarification widgets only under the Claude-specific name `AskUserQuestion`. | Ordinary planning/read tools may generate unnecessary IM prompts. Codex questions such as `request_user_input` are not equivalent to command authorization and have no implemented answer bridge. | Separate genuine authorization requests from questions and ordinary tool observation. Decide the scope/policy before changing the gate. |
| P2 | Native terminal titles can include run-state/progress suffixes; `term-wezterm/src/tab-title.ts` only normalizes Claude-style leading glyphs and default Claude titles. The matcher does support prefix matching. | Simple `#name` can still work via prefix matching, but exact names and displayed session names can vary with activity. Do not claim all Codex routing is broken. | Verify stable naming with current title configuration and exact/prefix routing fixtures before choosing a normalization change. |

## Approval semantics that must stay explicit

Claude Code's existing bridge already implements auto/ask choices in its hooks
and daemon. The Codex receiver has analogous gates, and the shared daemon's
PermissionDialog handler does implement auto-allow. The main observed failure
is the Codex wire format, not the absence of all auto-approval code.

Codex's native `approvals_reviewer = auto_review` is a separate reviewer for
eligible native requests. It must not be described as unconditional allow or
treated as the same mechanism as the bridge's own auto decision.

The current hook receivers also return allow after their existing timeouts.
Changing an ask-mode timeout to native fallback or deny changes the security
model and needs an explicit decision. This audit does not change that behavior.
The native PermissionRequest protocol currently rejects permission/input
rewrites such as Claude-style `updatedPermissions`; do not copy that feature
into the Codex output.

## Integration candidates

| Candidate | Evidence and scope | Consequence |
|---|---|---|
| A. Keep the current implementation | Confirmed defects above remain. | Does not meet reliable approval/setup requirements. |
| B. Correct the existing hook + terminal integration | Official hooks support PermissionRequest allow/deny; existing inbound/Stop/wizard paths already exist. | Recommended for repairing established behavior, subject to implementation-plan approval. No TUI ownership or adapter-interface replacement is needed for the protocol fixes. |
| C. Use the existing official App Server as a cooperating client | Current CLI exposes a shared daemon; a local WebSocket probe successfully attached to the already-active thread and received `turn/plan/updated` without a new prompt or restart. Official App Server also describes approval/question requests. | Candidate for full question/approval/plan cooperation. Receiving a plan event is not proof that every request can be safely answered by a second client. Must verify request ownership, disconnect behavior, authentication, and TUI coexistence before a product architecture decision. |
| D. Build an MCP frontend or own/wrap the user's TUI process | Neither is needed to correct the established hook contract. Owning/wrapping the user's TUI conflicts with the project's first principle. | Not recommended for this task. |
| E. Fork/patch Codex | No upstream change is needed for the confirmed protocol/installer fixes. | Adds distribution and maintenance obligations; not recommended. |

Recommendation: address the confirmed protocol/configuration defects in B,
then separately decide question coverage and whether C is needed. No candidate
is locked by writing this report. Policy-changing work must complete the
project's DD/user-decision process first.

## Plan-panel evidence

The initial project-local plan hook was registered, enabled, and trusted: this was read
through the running server's official `hooks/list`, not inferred solely from a
file. A real `update_plan` call produced a `turn/plan/updated` notification
containing the complete checklist. That call did not produce an observed plan
hook notification or display cache; the lower pane remained in its waiting
state. The exact reason for the missing hook delivery is still unresolved.

The previously cited 0.133.0 no-hot-reload memory is not proof about 0.163.0.
The matching current `tui/src/hooks_rpc.rs` trust flow requests
`reload_user_config`, and `core/src/session/mod.rs::refresh_hooks` can publish
reconfigured hooks at runtime. Do not keep requiring a restart or repeated
trust as an established remedy. The user has already trusted this hook.

The user subsequently chose A: display the verified official plan event
through a local observing connection. This developer panel is now implemented
in `scripts/task-panel-events.mjs` and was verified against actual
`update_plan` calls in the lower terminal pane. It uses existing workspace
`ws`/`zod` versions as direct development dependencies, connects only through
the existing Unix socket, and attaches only to already-loaded threads.
It never answers approval requests or starts turns. The earlier project plan
hook has been removed; global hooks/trust and bridge behavior remain unchanged.

Six isolated Unix-socket tests verify event delivery, session isolation,
malformed-input preservation, private caching, reconnect/cache restoration,
and no approval responses. Four Python viewer tests pass. Typecheck and frozen
lockfile installation pass. All 1,236 tests pass with test-process-only polling;
the native watcher run still hits the previously recorded host EMFILE limit.
The product integration candidates above remain separate from this approved
developer panel; no question/approval architecture is selected by its use.

The tab-title spinner issue is separate: the local macOS reduce-motion setting
is enabled. Codex 0.163.0 reads this once at TUI startup and suppresses activity
animation; changing the OS setting requires relaunching Codex. No system
accessibility preference was modified.

## Approved protocol and configuration repair

The user approved the proposed first two repair areas: PermissionRequest output
and hook configuration preservation. Main-session agent-field optionality is
included because rejecting valid stdin prevents the same approval path from
running. This corrects the existing hook contract; it introduces no new
transport, dependency, approval policy, or cross-package state protocol.

- Installer merging retains the complete hooks table, including trust/disabled
  state and full third-party handler/group data. Exact generated status labels
  identify owned handlers for replacement in their original positions; only
  missing handlers are appended. The official 0.163.0 `hooks/src/lib.rs::hook_key`
  includes group/handler indices, so preserving the state table alone would not
  preserve its meaning if pruning/reappending moved handlers. A separate red
  regression reproduced that positional failure before the in-place fix. It neither manufactures
  trust nor changes hashes. Structural equality avoids rewriting reviewed
  configuration because TOML table key order differs. Original-byte backup and
  atomic replacement remain in place.
- All PermissionRequest allow, deny, and existing timeout-allow returns include
  `hookSpecificOutput.hookEventName = "PermissionRequest"` and nested decision.
  No input/permission updates or session rules are emitted.
- The agent metadata on PreToolUse and PermissionRequest is optional, matching
  the downloaded official `rust-v0.163.0` input schemas. Invalid supplied types
  are still rejected.
- Tests first reproduced eight failures; repaired unit tests verify auto/ask
  response handling, missing/subagent metadata, third-party/state preservation,
  backup contents, stable handler positions, and a byte-stable second install.

The routing subprocess trust bypass and implicit Claude dependency were
subsequently repaired as described below. The question bridge, title
normalization, and older restart-warning wording remain separate findings. Existing timeout behavior is preserved, not newly selected.
No user-global settings were rewritten and no real IM messages were sent.


Final checks: 78 focused tests pass; changed modules have 96.43% line /
84.05% branch coverage. Typecheck and frozen-lockfile installation pass.
The full polling run passes all 1,244 tests. The last native run before the
positional merge correction retained the same 10 live-watcher failures and
14 EMFILE errors; the final correction changes no watcher code. The CLI
bundle builds and `./bin/multi-cc-im --version` loads as 0.2.3. An isolated
built-CLI smoke passes auto/ask × allow/deny through the downloaded official
0.163.0 input/output schemas and confirms the old top-level decision is
rejected. The user's Claude settings compare byte-identical before/after.

## Routing repair after #247

After #247 merged, the user requested continuing the remaining work. W2's
selected backend now supplies all three orchestrator interpretation callbacks.
Codex uses the existing question/permission prompts and shared output schemas;
Claude remains the default only when the user selects cc. No model/approval
policy or native question answering behavior was changed.

The shared Codex executor uses a fresh temporary cwd, disables hooks with the
native per-invocation `--disable hooks` flag, retains user model/provider/auth,
removes terminal-origin environment variables, and cleans per-call files.
It no longer bypasses hook trust or inherits the daemon project directory.
Timeout, missing binary, process failure, missing output, malformed output,
and shared answer validation are covered by executable-fixture tests.

A real Codex 0.163.0 smoke against a localhost fake provider verified a positive
control (the old trust-bypass invocation executes an inert marker hook), then
all three corrected routes (valid outputs, marker absent). The provider also
validated the submitted structured-output schemas against its fixture answers.
The isolated smoke sends no real model/IM traffic or user configuration writes.

The [question-bridge DD](2026-10-22-codex-question-bridge-dd.md) separately records
actual two-client native request probes (first answer wins, both clients see
resolved, disconnect, pending replay, and interruption). Its recommended new
product transport and authoritative thread/pane registration await a user
architecture decision. The observational plan panel still never answers.

Verification: typecheck; 1,265 full polling tests with coverage thresholds
(87.33% lines / 83.07% branches); 89.95% lines / 81.03% branches for the Codex
router; build + bin version 0.2.3. Native mode still has 10 existing live-event
failures / 14 EMFILE errors. User Claude settings compared unchanged.

## Verification required for implementation

- Reproduce each confirmed protocol/config defect with a failing test before
  editing implementation. Include independent upstream-shaped fixtures, not
  merely assertions that mirror the current code's return value.
- Verify native PermissionRequest allow and deny, IM auto and ask, routine
  tools, timeout, late reply, and daemon disappearance with inert commands.
- Verify a Codex-only machine needs no Claude binary for its selected routing
  paths; ordinary messages, permission replies, and questions are separate
  checks.
- Verify inert triage hooks never run, while terminal environment stripping
  still prevents misrouting.
- Verify hook trust/disabled state and third-party definitions survive setup,
  and a second setup invocation is a no-op. Use isolated configuration paths;
  do not use the developer's real global configuration as a test fixture.
- Then run required typecheck/tests/build/bin smoke and update affected docs.
  Real IM account sends require the user's task authorization; none were sent
  during this audit.

## Primary references

- [Official Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Pinned PermissionRequest output schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/schema/generated/permission-request.command.output.schema.json)
- [Pinned PreToolUse input schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json)
- [Pinned hook runtime](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/hook_runtime.rs)
- [Pinned hook identity key](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/lib.rs)
- [Pinned hook discovery/state lookup](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/discovery.rs)
- [Pinned hook trust RPC](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/tui/src/hooks_rpc.rs)
- [Official App Server](https://learn.chatgpt.com/docs/app-server)
- [Official automatic review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- [Existing adapter DD](2026-05-22-codex-cli-adapter-dd.md)


## Real TUI identity finding and withdrawn registration

After the user accepted the local native question transport, the candidate
passed unit/model-input tests but failed an additional actual two-TUI provenance
check. Both native hooks saw the App Server's pane (`700`), whereas client
launch markers were `800` and `900`. This invalidates the proposed automatic
hook-pane registration and also flags inherited-pane assumptions in other
Codex hook paths. The candidate was withdrawn, with no user-global configuration
change, deployment or completed-feature PR. Native transport feasibility still
holds. See the [identity DD](2026-10-22-codex-thread-identity-dd.md) and reproducible
probe for the official title-id alternative, its real truncation, and the
user-approved official-title identity. The plan observer remains observational.

## Approved official-title implementation

The user selected official thread-id auto-discovery, accepting the visible item
and pausing on missing/ambiguous identity. Raw terminal titles are now exposed
separately from friendly names; current loaded native ids are the only matching
set. All Codex Stop/permission hooks use that source, with no inherited-pane
fallback. Native questions use a local cooperating client and correlated IM
answers; auto mode never invents answers, secret input stays in the terminal,
and stale replies never become chat input. Mixed Claude/Codex selection retains
one state watcher plus the Codex question capability.

Installer title updates preserve order, unrelated TUI fields, hook trust and
third-party data, back up before edits, and remain idempotent. The guidance now
points to native /hooks and /terminal-title instead of mandating a restart.
No AGENTS.md/CLAUDE.md changes or user daemon/TUI restarts are part of this work.

Acceptance includes the real two-TUI/shared-server probe (production hook entry,
correct reply pane, auto gate and separate native question answers), a real native
server/product bridge/fake-IM model-input smoke, and full unit/coverage checks.
The actual iTerm2 Python helper has a raw-title contract fixture; live iTerm2 and
real Lark-account round trips are not claimed. Reproduce via docs/dev.md.
