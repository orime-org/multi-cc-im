# DD: AskUserQuestion IM bridge (cc widget → IM 双向)

**Date**: 2026-05-12
**Status**: ✅ LOCKED 2026-05-12 — user decided all 6 dimensions

---

## 0. Motivation

Live ground-truth 2026-05-12 (Ask 模式 smoke):

```
daemon stderr:
  [PreToolUse pane=6] ask IM: AskUserQuestion({"questions":[{"question":"Ask 模式下…)

IM (Feishu):
  [multi-cc-im] 准备跑工具:
    AskUserQuestion({"questions":[{"question":"Ask 模式下 AskUserQuestion 触发测试 …","header":"…","opti…)
  ⏳ 10 秒内回复，否则默认放行:
    #multi-cc-im /1   = 允许
    #multi-cc-im /2   = 拒绝
```

Two facts:

1. **AskUserQuestion DOES fire `PreToolUse` hook** (cc docs were right; earlier diagnosis was wrong because the user was in `auto` mode, which short-circuits with no log).
2. The current PreToolUse forward treats AskUserQuestion as a regular "may I run a tool?" approval — **wrong UX**:
   - Renders raw `tool_input` JSON, truncated, unreadable in IM
   - `/1` allow / `/2` deny semantics don't match the widget's 1-N option selection
   - In `/start` (auto-approve) mode the hook silent-allows → cc renders widget in TUI → IM sees nothing → user has to attend the TUI
   - Even in `/start off` (ask) mode the IM forward is unusable JSON

User directive 2026-05-12:

> "askuserquestion hook 放过了，但是 TUI 会一直显示。所以不然是用户是否开启了 hook 放过 pretooluse， askuserquestion 都在 IM start 的情况下都必须发送给 IM。而且不能用 yes 和 no 来表达要转换成通常的文本表达，类似现在有选项，希望听到你的回答。 1 XXXX 2XXXX 3XXX 4 你的考虑之类的"

> "用户只要在 IM 输入文本就行。不用限定必须是数字。因为 daemon 给 CC 的是 deny。然后加上 reason 这样 CC 就可以理解了"

Translation:
- AskUserQuestion must forward to IM whenever IMWork is on, **regardless of auto/ask mode**
- IM display must be numbered options + "your thoughts" (free text), not `/1`/`/2` semantics
- User's IM reply is free text (anything) — daemon parses → returns to cc as `permissionDecision: 'deny'` with `reason: <user's answer>` — cc interprets the reason as the user's response

---

## 1. Constraints

- **C1 — Don't break v1.7 flow**: regular tool permission forwarding (`Bash` / `Edit` / etc. → `/start off` ask mode → `#<tab> /1` `/2` OR natural language) must stay intact.
- **C2 — D5-C semantic correctness**: cc's `permissionDecision: 'deny'` + `reason` must be a stable channel for surfacing the user's answer. If cc treats `deny` as "cancel the tool, don't try again" but ignores the reason, the whole design breaks.
- **C3 — Hook timeout extension**: cc's PreToolUse hook has a settings-side timeout (we set to `10s` for regular tools). Holding for IM reply needs more time (user may take minutes). Per-tool timeout split required.
- **C4 — IMWork off (`/stop`)**: AskUserQuestion forwarding must respect the same gate as other forwards. When IMWork is off, cc renders widget natively (no IM forward); user attends TUI.
- **C5 — No keystroke injection** (D5-C was picked, not D5-B): daemon must NOT inject keystrokes into cc TUI to pick options. The deny+reason path keeps cc TUI cleanly bypassed.

---

## 2. 尽调 (real evidence, 2026-05-12)

### 2.1 cc PreToolUse hook scope (per [cc hooks docs](https://code.claude.com/docs/en/hooks))

PreToolUse matchers (verified live):

> Bash, Edit, Write, Read, Glob, Grep, **Agent**, **WebFetch**, **WebSearch**, **AskUserQuestion** (multiple-choice prompts), **ExitPlanMode**, MCP tools (`mcp__*`).

AskUserQuestion's `tool_input` schema includes the full `questions` array with `options[]` (label, description).

### 2.2 cc hook decision protocol

`PreToolUse` hook script writes JSON to stdout:
- `{"permissionDecision": "allow"}` → cc proceeds with the tool (renders widget for AskUserQuestion)
- `{"permissionDecision": "deny", "permissionDecisionReason": "..."}` → cc cancels the tool; the reason is logged into cc transcript and accessible to cc's next assistant turn
- `{"permissionDecision": "ask"}` → cc shows native permission menu (we never use this — overrides user allow rules per CLAUDE.md prohibition)
- Hook timeout → cc default-allows

### 2.3 cc settings.json multi-matcher entries

cc settings.json supports multiple hook entries per event, each with a `matcher` regex against tool name. We can have:

```json
{
  "PreToolUse": [
    { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "...", "timeout": 300 }] },
    { "matcher": "Bash|Edit|Write|WebFetch|Agent", "hooks": [{ "type": "command", "command": "...", "timeout": 10 }] }
  ]
}
```

Same hook command, different timeouts. The hook receiver reads `tool_name` from stdin and dispatches accordingly.

### 2.4 Existing v1.7 NL permission reply plumbing

`listPendingPermissionRequests(stateDir)` already returns every pending `*.PermissionRequest.*.json` with `paneId / sessionId / requestId / toolName / toolInput / createdAt`. The router's `handlePlainWithAI` already feeds this to the AI router for natural-language matching. **Extending this for AskUserQuestion is incremental, not greenfield.**

The current `permissionResponse` shape returned by the AI is `{ target, decision: 'allow'|'deny', reason }`. For AskUserQuestion the AI will always return `decision: 'deny'` with `reason` set to the user's verbatim or AI-paraphrased answer.

---

## 3. Dimensions & user decisions

| Dim | Choice | Why (per user) |
|---|---|---|
| **D1 — Trigger** | **B** — AskUserQuestion special-cased; IMWork on → always forward, regardless of auto/off | User directive: auto 模式吞了 widget 是 wrong UX; AskUserQuestion 在任何 IM 模式下都必须 reach IM |
| **D2 — cc TUI behavior** | **B** — hook holds (poll for response file) until IM reply arrives; cc TUI never renders the widget | User directive: TUI 一直显示是问题 — hook hold + deny 后 cc 就不渲染 widget |
| **D3 — IM format** | Numbered options + label + description excerpt + "N+1. 你的考虑（自由文本）" trailing option | User directive: `1 XXXX 2XXXX 3XXX 4 你的考虑` 风格 |
| **D4 — IM reply parsing** | **B** — AI router maps natural language ("我同意第二个" / "deny the bash one" / "do option 3 with X tweak") to an option OR passes free text through | User directive: 不限定数字 |
| **D5 — IM reply → cc injection** | **C** — `permissionDecision: 'deny'` + `reason: <user's answer or AI-paraphrased option>` | User directive: daemon 给 cc 的是 deny + reason，cc 自己理解 |
| **D6 — Free text** | **B** — supported; any IM text gets routed back as the reason | User directive: 用户在 IM 输入文本就行，不用限定必须是数字 |

---

## 4. Recommendation & safety property

Combined behavior:

1. User in cc TUI talks to cc (or sends a routing msg from IM that triggers cc work).
2. cc decides to use AskUserQuestion → fires `PreToolUse` hook.
3. Hook receiver special-cases `tool_name === 'AskUserQuestion'`:
   - IMWork off → silent exit (cc renders widget natively in TUI)
   - IMWork on (auto OR ask) → write `PermissionRequest` file with `toolName='AskUserQuestion'` + full `toolInput` → poll for response (up to ~5 min)
4. Daemon picks up the new PermissionRequest, recognizes `toolName='AskUserQuestion'`, formats IM message:
   ```
   [<tab>] cc 想问你:
     <question>

     1. <option1 label>
        <option1 description>
     2. <option2 label>
        <option2 description>
     ...
     N+1. 你的考虑（自由文本）

   请回复
   ```
5. User replies in IM (number / natural language / free text).
6. Bridge router's `handlePlainWithAI` (v1.7 plumbing) sees the pending AskUserQuestion, AI parses the reply:
   - Matches an option → reason = option's `label` (clean, deterministic)
   - Free text doesn't match → reason = user's verbatim text
7. Bridge writes `PermissionResponse` with `decision: 'deny'` + the chosen reason.
8. Hook receiver's poll picks up the response → outputs `{permissionDecision: 'deny', permissionDecisionReason: <reason>}` to cc.
9. cc cancels the AskUserQuestion tool with reason; sees the reason in transcript; treats it as the user's response; continues the turn.
10. cc Stop hook fires when turn ends → bridge forwards cc's continuation back to IM normally.

### Safety properties

- **Other tools unchanged**: Bash/Edit/WebFetch/etc. still go through the v1.7 NL permission flow (allow/deny semantics with optional natural-language replies). Only AskUserQuestion is special-cased.
- **IMWork off respected**: cc renders widget in TUI as before; no IM disturbance.
- **Hook timeout**: per-tool split (5 min for AskUserQuestion, 10s for others). Long hold doesn't risk regular tool flow.
- **cc's deny+reason interpretation risk** (C2): smoke-test before declaring done. If cc fails to interpret deny reason as the user's answer (e.g., cc retries the tool or gives up), the design needs revision (potentially D5-B keystroke injection fallback).
- **Always-log audit trail**: new `[AskUserQuestion forward] tab=X options=N reply="..."` log line mirrors `[AI router]` / `[AI permission]`.

---

## 5. User decision (step 5 of DD process)

| Dim | Choice | Status |
|---|---|---|
| D1 | B — IMWork on → always forward | ✅ accepted 2026-05-12 |
| D2 | B — hook holds until IM reply | ✅ accepted 2026-05-12 |
| D3 | numbered options + 你的考虑 | ✅ accepted 2026-05-12 |
| D4 | B — AI natural-language parsing | ✅ accepted 2026-05-12 |
| D5 | C — deny + reason | ✅ accepted 2026-05-12 |
| D6 | B — free text supported | ✅ accepted 2026-05-12 |

DD is **LOCKED**.

---

## 6. Implementation milestones

| ID | Scope |
|---|---|
| **P1** | `apps/multi-cc-im/src/setup-hooks.ts` — split `PreToolUse` into two settings.json entries: `matcher: "AskUserQuestion"` with `timeout: 300` (5 min), and the existing `Bash\|Edit\|Write\|WebFetch\|Agent` matcher with `timeout: 10`. Same hook command both. Atomic settings.json write (preserves existing user backup pattern). Tests for the new shape. |
| **P2** | `packages/cli-cc/src/hook-receiver.ts` — extend the PreToolUse decision tree with an early special-case for `tool_name === 'AskUserQuestion'`: bypass the `IMWork.auto === true` short-circuit (D1-B), write PermissionRequest with the full `tool_input.questions[]`, poll for response with extended timeout (~5 min), output `{permissionDecision: 'deny', permissionDecisionReason: <response.reason>}` per D5-C. Regular-tool tree path unchanged. Unit tests for the new branch. |
| **P3** | `packages/bridge/src/orchestrator.ts` — when forwarding a PermissionRequest with `toolName === 'AskUserQuestion'`, format the IM message per D3 (numbered list with `你的考虑` trailing). Audit log line `[AskUserQuestion forward] tab=X options=N`. Regular-tool forwarding path unchanged. |
| **P4** | `packages/bridge/src/ai-router.ts` — extend the PENDING block prompt to handle AskUserQuestion entries: when a pending has `toolName === 'AskUserQuestion'`, the AI's job is to pick an option (return its label as reason) or pass user's free text through. Output schema unchanged (`{target, decision, reason}` — decision is always `'deny'` for AskUserQuestion). |
| **P5** | Tests across cli-cc / bridge: hook special-case branch, orchestrator format, AI prompt option-matching, free-text passthrough, IMWork-off bypass (cc renders TUI natively). Real-account smoke checklist for cc's deny+reason interpretation (C2). |
| **P6** | Docs: README — small "cc widget questions in IM" section under "Tool permission flow"; conventions.md status row v1.9 + revision log; setup-feishu.md unchanged. |

Each milestone = one PR (mirrors v1.7's P1-P6 cadence). Total ~5-6 PRs.

---

## 7. Open technical questions / smoke risks

1. **cc's interpretation of deny+reason for AskUserQuestion** (C2 risk). Hypothesis: modern Claude sees "deny with reason: 'I'll go with option 2: 测试'" and interprets as user's answer. **Real-account smoke after P1-P4** before declaring done. Mitigation if cc misinterprets: fall back to D5-B (keystroke injection) — bigger code change, P3+P4 redesign.
2. **5-minute hook timeout impact on cc UX**. If user never replies in IM, cc waits 5 min then default-allows → renders widget in TUI. Acceptable but document the behavior.
3. **AI prompt complexity**. The AI router now juggles three pending types: regular tool permission (allow/deny), AskUserQuestion (always-deny with answer reason), and AskUserQuestion + regular pending in the same prompt. Prompt size grows. Smoke-test on Haiku 4.5 (current model) for clarity.
4. **Concurrent AskUserQuestion** (rare): two cc tabs both ask at once. Each pending has unique `requestId` already → AI prompt lists both → user's IM reply must mention which (`#<tab>` prefix). Existing infrastructure covers this; needs explicit test.

---

## 8. Review log

- **2026-05-12 (a)** — DD drafted after live smoke confirmed `AskUserQuestion` fires `PreToolUse` (cc docs were right; earlier "doesn't fire" diagnosis was wrong, root cause was auto-mode silent-allow short-circuit). User locked all 6 dimensions in the same conversation: D1-B / D2-B / D3-numbered / D4-B / D5-C / D6-B. Status flipped to ✅ LOCKED. P1-P6 milestones move into [`docs/conventions.md`](../../conventions.md) status table.
