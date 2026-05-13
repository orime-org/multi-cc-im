# DD: PermissionRequest hook IM bridge (cc sensitive-file dialog → IM 双向)

**Date**: 2026-05-13
**Status**: 🟡 DRAFT — pending user lock on D1-D9

---

## 0. Motivation

Live ground-truth 2026-05-13:

```
cc tab work_temp, IMWork.auto=true (/start), tool: Bash mkdir -p .claude/hooks
  ↓
PreToolUse hook fires → daemon step 3 fast-allow → silent exit
  ↓
cc internal checks:
  - checkEditableInternalPath → pass
  - checkPathSafetyForAutoEdit('.claude/hooks') → MATCH DANGEROUS_DIRECTORIES → ask
  ↓
cc TUI dialog renders:
  "Claude requested permissions to edit /.../.claude/hooks which is a sensitive file."
  1. Yes
  2. Yes, and always allow access to .claude/ from this project
  3. No
  ↓
User in IM mode, NOT looking at TUI → cc hangs waiting for keystroke
Daemon doesn't know cc is blocked (PreToolUse already fast-allowed & exited).
IM is silent.
```

User feedback: "我用了 /start 应该不会被打扰". Pre-existing PreToolUse hook fast-allow is the **wrong layer** to intercept this — by design cc's `checkPathSafetyForAutoEdit` runs **after** PreToolUse hook and **before** user-level allow rules ([filesystem.ts:1302-1338](../../../../Users_songxiulei_Desktop_Unit_Agent_Competitive/claude-code-sourcemap/restored-src/src/utils/permissions/filesystem.ts)).

cc protocol provides a separate hook event — `PermissionRequest` — that fires precisely when cc decides to render the TUI permission dialog. We currently don't subscribe to it. Subscribing lets daemon forward the dialog to IM, let user pick in IM, return the decision (+ optionally inject a `'session'` destination allow rule that bypasses subsequent sensitive-gate prompts in the same cc session).

---

## 1. Constraints

- **C1 — Don't break v1.7 / v1.9 flows**: PreToolUse + Stop hook subscriptions stay intact. Regular tool allow/deny (`#<tab> /1` `/2` / natural-language reply) + AskUserQuestion (allow + updatedInput.answers) keep working.
- **C2 — cc PermissionRequest protocol facts** (verified 2026-05-13 against cc 2.1.88 source map):
  - `decision.behavior ∈ {'allow', 'deny'}` only (no `ask` / `defer`).
  - `decision.updatedPermissions` accepts PermissionUpdate[] with `destination`.
  - **Only `destination: 'session'` bypasses the `.claude/*` sensitive gate** ([filesystem.ts:1268-1300](../..)); `userSettings` / `projectSettings` / `localSettings` rules persist to disk but the safety gate runs before them on every new session.
  - hook input contains `permission_suggestions: PermissionUpdate[]` — cc's own "Yes always" suggestion ready for daemon to forward verbatim.
  - **hook fires after** all gates (deny rules / ask rules / safety check) **and before** TUI dialog renders. `allow` return → dialog never renders (no terminal flash).
  - cc default hook timeout = 10 minutes; on cancel/timeout cc falls through to TUI dialog (not default-allow).
  - multi-hook merge: **first-non-null wins** (not most-restrictive).
- **C3 — `/start auto` UX semantic**: in trust mode, daemon must NOT bother IM with every sensitive-path operation, but MUST NOT silently grant `'session'` always-allow rules either (those would erode user's per-operation visibility forever).
- **C4 — Internal poll deadline < cc 10 min timeout**: daemon hook self-handles timeout (mirror v1.9 AUQ 110s pattern) so cc never sees a SIGKILL → never falls back to TUI dialog mid-IM-flow.

---

## 2. 尽调 (cc 2.1.88 source-verified, 2026-05-13)

### 2.1 hookSpecificOutput schema for PermissionRequest

[`restored-src/src/types/hooks.ts:121-134`](../../../../Users_songxiulei_Desktop_Unit_Agent_Competitive):

```typescript
z.object({
  hookEventName: z.literal('PermissionRequest'),
  decision: z.union([
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      updatedPermissions: z.array(permissionUpdateSchema()).optional(),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string().optional(),
      interrupt: z.boolean().optional(),
    }),
  ]),
})
```

### 2.2 hook input

[`hooks.ts:4174-4180`](../..):

```typescript
const hookInput: PermissionRequestHookInput = {
  ...createBaseHookInput(...),
  hook_event_name: 'PermissionRequest',
  tool_name: toolName,
  tool_input: toolInput,
  permission_suggestions: permissionSuggestions,
}
```

`permission_suggestions` is the array of `PermissionUpdate` objects cc would have offered as "Yes, and always allow ..." dialog buttons. Daemon can render these as IM choices and apply the chosen one verbatim.

### 2.3 session destination bypass

[`filesystem.ts:1268-1300`](../..) runs **before** [`filesystem.ts:1305`](../..) safety check:

```typescript
// step 1.6 (BEFORE safety check):
const claudeFolderAllowRule = findRuleInSession(allowRules, path)
if (claudeFolderAllowRule && ruleContent.endsWith('/**')) {
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'rule', rule: claudeFolderAllowRule },
  }
}
// step 1.7 (sensitive gate):
const safetyCheck = checkPathSafetyForAutoEdit(path, ...)
if (!safetyCheck.safe) {
  return { behavior: 'ask', ... }
}
```

Comment in source: `"This MUST come before checking allow rules to prevent users from accidentally granting permission to edit protected files."` Sensitive gate is **deliberately** before allow rules — but session rules (in-memory `alwaysAllowRules.session`) get a special-cased early return that does bypass it. This is the only mechanism that lets the gate be bypassed within a cc session.

### 2.4 multi-hook merge

[`permissions.ts:409-461`](../..): loop iterates hook results, returns immediately on first `allow` or `deny` decision. No aggregation.

### 2.5 timeout behavior

[`hooks.ts:166, 4813-4818`](../..):

```typescript
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes
if (error.name === 'AbortError') {
  return { outcome: 'cancelled', hook }
}
```

Outcome `'cancelled'` is non-blocking; cc moves to next hook or default behavior (TUI dialog, or AI classifier in auto mode if available).

---

## 3. Dimensions & user decisions

| Dim | Choice | Why (per user) |
|---|---|---|
| **D1 — Subscription scope** | **A** — subscribe ALL `PermissionRequest` events (not filtered by sensitive path) | Simpler + future-proof for other cc-internal ask gates beyond `.claude/*`; daemon decides per-call what to forward |
| **D2 — `/start auto` default action** | **A** — silent emit `{decision: {behavior: 'allow'}}` with NO `updatedPermissions` | Per user 2026-05-13: trust mode means daemon auto-approves the single call but preserves per-operation visibility (no session-wide rule injection that would silently erode the gate's intent for the rest of the session) |
| **D3 — `/start off` default action** | **A** — forward to IM, let user pick from `permission_suggestions` + literal "deny" + literal "single-yes" | Mirrors v1.7 PreToolUse off-mode pattern (forward + user decides); reuses cc's own "Yes always X" wording from `permission_suggestions` so IM doesn't drift from cc's intended copy |
| **D4 — IM message format** | Numbered options: each `permission_suggestion` entry as one numbered choice + `N. Single-yes (this call only)` + `N+1. Deny` | Per user 2026-05-13 (mirrors v1.9 D3 AUQ numbered format): clear, predictable, AI / digit / paraphrase all parse |
| **D5 — `/start auto` audit log to IM** | **B** — daemon emits a one-line `🛡️ daemon auto-allowed cc edit to <path>` IM notification (no user action required) | Per user 2026-05-13: preserves user visibility into what daemon let through; not silent (a) and not interactive (c). Single line, throttle if floods (P5 risk) |
| **D6 — User IM override to "always-allow"** | **A** — NOT supported. IM picks single-yes / always-suggestion-X / deny, but daemon doesn't synthesize an always-allow that wasn't in `permission_suggestions` | Protects D2-a consistency; if user really wants session-always they can do it in TUI option 2 once; daemon doesn't second-guess |
| **D7 — Hook output payload schema** | Protocol fact: `{decision: {behavior, updatedInput?, updatedPermissions?}}` (allow) or `{decision: {behavior: 'deny', message?, interrupt?}}` (deny). `interrupt: true` NEVER used (would abort session) | No candidates; cc protocol |
| **D8 — Internal poll deadline** | **110 s** internal poll (mirror v1.9 AUQ); cc-side hook timeout setting 120 s (mirror v1.9 AUQ matcher); cc default 10-min is too long for IM-blocked dialogs | Symmetric with AUQ; on internal timeout daemon emits default allow (no session rule) so cc proceeds + IM gets timeout notice |
| **D9 — Multi-hook coexist** | Assume daemon is the **only** PermissionRequest hook. Document this in README. If user has other PermissionRequest hooks the first-non-null winner is unpredictable (could be ours, could be theirs). | Document, don't enforce; users adding multiple hooks accept the cc-protocol "first wins" semantic |

---

## 4. Recommendation & safety property

Combined behavior:

1. User in cc tab triggers tool requiring sensitive-path access (e.g., `Bash mkdir .claude/hooks`).
2. cc fires PreToolUse hook → multi-cc-im daemon fast-allows (existing v1.7 / v1.9 paths unchanged).
3. cc's `checkPathSafetyForAutoEdit` returns `'ask'` → cc fires `PermissionRequest` hook.
4. multi-cc-im hook subprocess:
   - IMWork off → silent exit → cc falls back to TUI dialog (user in local mode)
   - IMWork.auto = true → emit `{decision: {behavior: 'allow'}}` + fire-and-forget IM notification `🛡️ daemon auto-allowed cc edit to <path>` → exit
   - IMWork.auto = false (`/start off`) → write `<paneId>_<sid>.PermissionRequestRequest.<id>.json` with `tool_name` + `tool_input` + `permission_suggestions` → poll for response (110 s deadline) → emit `{decision: {behavior: <user choice>}, updatedPermissions: [<chosen suggestion>]?}`
5. Daemon picks up the new Request file (chokidar add), formats IM:
   ```
   [<tab>] cc 想编辑敏感路径:
     /path/to/.claude/hooks
     (sensitive: .claude/)

     1. 同意一次 (仅本次调用)
     2. <permission_suggestions[0].ruleContent>  ← cc 建议: 本 session 始终允许 .claude/
     3. 拒绝

   请回复
   ```
6. User replies (number / natural language / free text) → AI router parses → daemon writes Response file with `decision.behavior` + optional `updatedPermissions: [<suggestion>]` for session-allow.
7. Hook subprocess poll picks up Response → writes stdout JSON to cc → cc TUI dialog NEVER renders (allow path) or cc cancels tool (deny path).
8. cc continues. If session-allow rule was injected, subsequent `.claude/*` edits in the same session skip the gate.

### Safety properties

- **Other flows unchanged**: PreToolUse + Stop hook paths untouched.
- **IMWork off respected**: cc renders TUI dialog as before; no IM disturbance.
- **Sensitive gate semantic preserved**: daemon CANNOT silently inject always-allow rules in auto mode (D2-a); user-initiated explicit "always" picks (D3) still go through user's IM decision.
- **Internal timeout**: 110 s daemon hook deadline keeps cc from hanging 10 min on a sleeping user; mirror v1.9 AUQ timing.
- **Audit trail**: new `[PermissionRequest forward pane=X tab=Y path=...] auto=<bool>` daemon log line (similar to v1.9 `[AskUserQuestion forward]`).

---

## 5. User decision (step 5 of DD process)

| Dim | Choice | Status |
|---|---|---|
| D1 | A — subscribe all PermissionRequest events | ⏳ pending user lock |
| D2 | A — `/start auto` silent emit single-yes | ✅ accepted 2026-05-13 |
| D3 | A — `/start off` forward IM with permission_suggestions | ⏳ pending user lock |
| D4 | numbered options + cc's suggestion text verbatim | ⏳ pending user lock |
| D5 | B — `/start auto` IM audit log notification | ✅ accepted 2026-05-13 |
| D6 | A — no IM override to "always" (only from `permission_suggestions`) | ⏳ pending user lock |
| D7 | Protocol fact (no candidate) | — |
| D8 | 110 s internal / 120 s cc-side / mirror AUQ | ⏳ pending user lock |
| D9 | Assume only-hook, document multi-hook caveat | ⏳ pending user lock |

DD enters **LOCKED** state when all rows above are ✅.

---

## 6. Implementation milestones

| ID | Scope |
|---|---|
| **P1** | `apps/multi-cc-im/src/setup-hooks.ts` — add `PermissionRequest` event to `HOOK_EVENTS` + matcher `""` (no per-tool split since PermissionRequest isn't tool-scoped) + `timeout: 120` (cc-side). Atomic settings.json write preserves user backup pattern. Tests for new shape. |
| **P2** | `packages/shared/src/adapter/cli.ts` — add `PermissionRequestPayload` type (mirroring `PreToolUsePayload` shape but with `permission_suggestions: PermissionUpdate[]` field). Update `HookPayload` discriminated union. |
| **P3** | `packages/cli-cc/src/state-files.ts` — new file types: `<paneId>_<sid>.PermissionRequestRequest.<id>.json` (daemon writes from this is wrong — actually: hook writes, daemon reads; mirror existing `PermissionRequest` file pattern) + `PermissionRequestResponseFile` discriminated union (`allow` + optional `updatedPermissions` + optional `reason` / `deny` + required `reason`). |
| **P4** | `packages/cli-cc/src/hook-receiver.ts` — add `PermissionRequest` branch: IMWork null → silent exit, IMWork.auto=true → emit single-yes allow + fire IM audit (D5), IMWork.auto=false → write Request file + poll Response (110s) + emit cc stdout JSON. Hook handler is the FIRST point that knows `permission_suggestions` (cc passes via stdin). |
| **P5** | `packages/bridge/src/orchestrator.ts` — chokidar listens for `PermissionRequestRequest.*` files; format IM per D4 (numbered options + cc's `permission_suggestions` verbatim); add `aiRouter` injection for permission-request-mode (similar to v1.7 plain-AI but for PermissionRequest). New audit log `[PermissionRequest forward pane=X tab=Y path=...] auto=<bool>`. |
| **P6** | `packages/bridge/src/ai-router.ts` — new prompt `renderPermissionRequestPrompt` (output shape: `{target, decision: 'allow'|'deny', appliedSuggestionIndex?, reason}`). Router extracts user's natural-language reply to map to one of the numbered options. |
| **P7** | `packages/bridge/src/router.ts` — wire ai-router PermissionRequest result → `RouterPermissionRequestResponse` (similar to `RouterPermissionResponse` but for PermissionRequest with `updatedPermissions` field). Late-reply dead-drop IM notice per v1.9 §9.5 pattern. |
| **P8** | Tests across all packages: hook receiver IMWork branches, orchestrator format, AI prompt parsing, router branch, file lifecycle. Real-account smoke for `.claude/hooks` edit (the original trigger case). |
| **P9** | Docs: README sections (EN + 中); conventions.md status table row + revision log; sensitive-file UX explainer block mentioning daemon now intercepts these. |

Each milestone = one PR (mirrors v1.7 / v1.9 cadence). Total ~6-8 PRs.

---

## 7. Open technical questions / smoke risks

1. **cc's interpretation of `updatedPermissions` with destination 'session'**. Hypothesis: when daemon emits `{decision: {behavior: 'allow', updatedPermissions: [...]}}`, cc applies the rule to in-memory `alwaysAllowRules.session` and the **next** `.claude/*` edit in the same session early-returns allow at filesystem.ts:1268-1300 without re-triggering PermissionRequest. Real-account smoke after P4-P7 before declaring done.
2. **10 min cc-side hook timeout race with our 110 s internal deadline**. If daemon hook hangs > 120 s (cc-side timeout) but < 10 min (cc internal default), cc SIGKILLs the hook subprocess. Daemon-side reaper must clean up Request/Response files within the same 120 s window. Mirror v1.9 P1 timeout setting in setup-hooks.
3. **`/start auto` IM audit log flood**. If cc fires PermissionRequest rapidly (e.g., loop of `.claude/hooks/foo`, `.claude/hooks/bar`, `.claude/hooks/baz` edits), D5 emits one IM line per call → IM gets flooded. Mitigation: batch within a 2 s window? Or simply throttle per-path?
4. **AI router prompt complexity**. ai-router now juggles four pending types: regular tool permission (v1.7 PreToolUse), AskUserQuestion (v1.9 AUQ allow+updatedInput), PermissionRequest (this DD), routing (v1.4 plain). Prompt budget concern — may need separate AUQ-style isolated path instead of mixing into existing renderPendingBlock.
5. **Multi-hook coexist behavior**. D9 documents but doesn't enforce. If user has e.g. a notification-only hook that also returns decisions, first-wins makes it nondeterministic. Document; smoke uncovered.

---

## 8. Review log

- **2026-05-13 (a)** — DD drafted after live `.claude/hooks` edit hangs IM mode. Two prior agent verification runs confirmed cc 2.1.88 protocol (PermissionRequest hook accepts `updatedPermissions`, only `'session'` destination bypasses sensitive gate, hook fires after all gates and before TUI dialog). User locked D2-A + D5-B in same conversation. D1 / D3 / D4 / D6 / D8 / D9 pending lock.

---

## 9. Lessons captured (running tally)

- 2026-05-13 (during this DD's research): two earlier replies to the same user concern were wrong before getting it right:
  - First reply: "daemon 这边能做的 = 0" — dismissed too early without exploring all cc hook events. PreToolUse is one hook event; cc has many others including PermissionRequest.
  - Second reply: "`~/.claude/settings.json` 加 allow rule 一劳永逸" — wrong because sensitive gate runs **before** user-level allow rules per `filesystem.ts` source comment.
  - Both errors stem from: not querying all cc hook event types before answering "can daemon intercept this?". **Future rule** (memory-worthy): when an "intercept cc behavior X" question comes up, first enumerate ALL hook events cc fires at the relevant lifecycle moment, not just the obvious one. PreToolUse-bias is a recurring trap.

