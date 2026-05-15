# DD: AskUserQuestion IM bridge (cc widget → IM 双向)

**Date**: 2026-05-12
**Status**: 🔄 REVISED 2026-05-12 — D5 retracted; see [§9 Revision](#9-revision-d5-retracted--allow--updatedinputanswers-is-the-correct-channel) below. Original D5-C `deny + reason` replaced with D5-D `allow + updatedInput.answers` (official documented path; was missed during candidate enumeration).

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
| **D5 — IM reply → cc injection** | ~~**C** — `permissionDecision: 'deny'` + `reason: <user's answer or AI-paraphrased option>`~~<br>**Revised to D — `permissionDecision: 'allow'` + `updatedInput: {questions, answers}`** (see [§9](#9-revision-d5-retracted--allow--updatedinputanswers-is-the-correct-channel)) | Original: daemon 给 cc 的是 deny + reason。<br>Revised: official agent-sdk docs document `allow + updatedInput.answers` as the standard AUQ answer channel; transcript records tool success not denial. |
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
| D5 | ~~C — deny + reason~~ → **D — allow + updatedInput.answers** | ⚠️ C retracted 2026-05-12 — see [§9](#9-revision-d5-retracted--allow--updatedinputanswers-is-the-correct-channel) |
| D6 | B — free text supported | ✅ accepted 2026-05-12 |

DD was originally **LOCKED** 2026-05-12. **D5 retracted same day after post-smoke docs review** — see [§9](#9-revision-d5-retracted--allow--updatedinputanswers-is-the-correct-channel).

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
- **2026-05-12 (b)** — D5 retracted after post-smoke docs re-verification: user pushed back on `deny + reason` channel pointing to AUQ semantic mismatch (transcript shows `denied` not `succeeded`). Official [agent-sdk/user-input docs](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions) document `allow + updatedInput.answers` as the standard AUQ channel — candidate that was missed during original D5 enumeration. New §9 added; D5 replaced with D-D; timeouts shortened (290s→110s hook, 300_000→120_000 matcher, 310_000→130_000 reaper); timeout path self-constructs empty answers (no deny channel); late-reply dead-drop IM notice added. v1.10 / v1.11 implementations (deny-mode + reaper bumps) flagged for rewrite under new R1-R10 milestones.

---

## 9. Revision: D5 retracted — `allow + updatedInput.answers` is the correct channel

**Date**: 2026-05-12 (post-P5 smoke + docs re-verification)
**Trigger**: After v1.10 / v1.11 made the working smoke pass, the user pushed back: "you keep returning deny — go look up what AskUserQuestion is supposed to return." Re-fetching official docs confirmed a missed candidate.

### 9.1 Missing candidate D5-D

Original D5 enumeration in [§3](#3-dimensions--user-decisions):

- D5-A — `allow` (cc renders widget in TUI) — rejected
- D5-B — keystroke injection — rejected
- D5-C — `deny + reason` — selected (implemented in P1-P4 + v1.10 / v1.11)

Missing candidate **D5-D — `allow + updatedInput.answers`**. The PreToolUse hook output supports a top-level `updatedInput` field that rewrites tool input before execution (per [hooks reference](https://code.claude.com/docs/en/hooks#pretooluse) and demonstrated in [hooks guide](https://code.claude.com/docs/en/hooks-guide#structured-json-output)). For `AskUserQuestion` specifically, the [Agent SDK user-input docs](https://code.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions) document this as **the** standard response shape:

> Build the `answers` object as a record where each key is the `question` text and each value is the selected option's `label`.
>
> ```typescript
> return {
>   behavior: "allow",
>   updatedInput: {
>     questions: input.questions,
>     answers: {
>       "How should I format the output?": "Summary"
>     }
>   }
> };
> ```

With this channel cc treats the tool as completed successfully and records `{questions, answers}` as the tool result in the transcript — not a denial.

### 9.2 Root cause: incomplete docs review

The original DD only checked the [hooks docs](https://code.claude.com/docs/en/hooks) page (PreToolUse `permissionDecision` enum) and never opened the [agent-sdk/user-input docs](https://code.claude.com/docs/en/agent-sdk/user-input) page, where the AUQ response shape lives. Both pages must be read together to obtain the complete protocol — the hooks page lists `updatedInput` as a valid field but does not demonstrate the AUQ-specific shape; the agent-sdk page documents the AUQ shape but presents it through the `canUseTool` callback API. The protocol parity between `canUseTool` callbacks (Agent SDK) and PreToolUse hook output (cc CLI) is implicit, not spelled out.

This violates two project rules:
- [`feedback_dd_question_premise.md`](DD candidate enumeration must be exhaustive)
- [`feedback_upstream_schema_real_smoke.md`](upstream schema must be sourced from official docs)

### 9.3 D5-D protocol shape

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "questions": [/* original toolInput.questions verbatim */],
      "answers": {
        "<question.question>": "<picked option.label OR free text>"
      }
    }
  }
}
```

- single-select: `answers[q.question] = "<label>"` (string)
- multi-select: `answers[q.question] = ["<l1>", "<l2>"]` (array) or `"l1, l2"` joined string
- free-text: `answers[q.question] = "<verbatim user text>"` (use user's literal input, not the word "Other")
- timeout (110s without a PermissionResponse arriving): hook self-constructs `answers[q.question] = ""` (empty string) per question — cc reads empty answers and decides on its own; **deny channel is not used**

### 9.4 Revised dimensions

| Dim | Original | Revised | Rationale |
|---|---|---|---|
| **D5** | C (deny + reason) | **D (allow + updatedInput.answers)** | Official documented path; transcript records tool success, not denial; semantically aligned with AUQ as "user answered a question" rather than "user denied a tool call" |
| D2 | B (hook holds) | B unchanged | Hook still internally polls PermissionResponse file; only the stdout output schema changes (`{allow, updatedInput}` instead of `{deny, reason}`) |
| Other (D1 / D3 / D4 / D6) | — | unchanged | Channel-agnostic — IM forwarding, format, AI parsing, free-text support all reuse the same plumbing |

### 9.5 Revised timeouts

- hook internal poll: 290s → **110s** (2 min is sufficient per user; longer hold burns no-IM-activity time)
- setup-hooks matcher timeout: 300_000ms → **120_000ms**
- daemon reaper AUQ delay: 310_000ms → **130_000ms**
- on timeout, hook self-constructs `answers[q.question] = ""` (per question) → cc decides; **no deny output**
- late-reply (hook already exited when daemon receives the IM reply) → daemon sends IM message `"⏱ cc 已超时，本轮不再等待"` so the user knows the answer did not reach cc

### 9.6 Implementation plan (single PR after this DD revision lands)

| ID | Scope |
|---|---|
| **R1** | `packages/shared` — add `AskUserQuestionAnswerSchema` zod: `answers` array of `{questionIndex, kind: 'option' \| 'text', optionIndex \| text}` |
| **R2** | `packages/cli-cc/src/state-files.ts` — `PermissionResponseFile` becomes a discriminated union: `{decision: 'allow', updatedInput?: Record<string, unknown>, reason?: string}` \| `{decision: 'deny', reason: string}` |
| **R3** | `packages/cli-cc/src/hook-receiver.ts` — read PermissionResponseFile and output `{permissionDecision: 'allow', updatedInput}` on allow, `{permissionDecision: 'deny', permissionDecisionReason}` on deny. Remove v1.10's `isAskUserQuestion → force decision='deny'` hard-coded override. On AUQ-matcher timeout, self-construct empty-answers updatedInput and emit allow |
| **R4** | `apps/multi-cc-im/src/setup-hooks.ts` — AUQ matcher `timeout: 120_000` |
| **R5** | `packages/bridge/src/orchestrator.ts` — `ASK_USER_QUESTION_REAPER_DELAY_MS = 130_000` |
| **R6** | `packages/bridge/src/ai-router.ts` — new `renderAskUserQuestionPrompt(opts)` that outputs `AskUserQuestionAnswerSchema` (option / text per question). Existing force-permission prompt restricted to non-AUQ pending only |
| **R7** | `packages/bridge/src/router.ts` — AUQ branch in `handlePlainWithAI`: detect AUQ in pending, route to AUQ AI prompt, daemon looks up `toolInput.questions[idx].options[i-1].label` and builds `answers` map, writes `{decision: 'allow', updatedInput: {questions, answers}}` |
| **R8** | IM echo two states (option: `target / 你答 ①: <label>`; text: `target / 自由回答: <text>`) + late-reply dead-drop IM notice |
| **R9** | Tests for R1-R8 + real-account smoke (cc transcript MUST show AUQ tool succeeded with `answers`, NOT denied) |
| **R10** | `docs/conventions.md` (status table + revision log) / `docs/architecture.md` AUQ section / READMEs |

Single PR. Scope smaller than the original v1.9 P1-P6 split because no new infrastructure is needed (file IPC + AI router + IM echo all reuse v1.9 plumbing, just with different output shapes).

### 9.7 Lessons captured (added to repo memory)

- **Cross-page docs lookup**: tool-specific protocols often span multiple docs pages (hooks reference + Agent SDK user-input + tool-specific behavior). Fetch all related pages before locking schema. (Captured in `feedback_upstream_schema_real_smoke.md`.)
- **DD candidate completeness**: candidates must include officially documented paths, even when those paths require reading docs outside the primary section.
- **Smoke ≠ semantic correctness**: a passing smoke (cc consumes the response and continues) does not mean the transcript records the right thing. Inspect transcript literals as part of smoke validation, not just behavior.

---

## 10. Sub-revision 2026-05-15 — timeouts back to ~5 min

Direct user feedback via IM 2026-05-15: AskUserQuestion 「好像是失效了，要么就是给的时间太短了。Ask user question 应该至少给300秒，也就是5分钟的时间，不然的话，手机上面 8M 回复根本来不及，它就给空答案了」。

§9.5 revised cc-side timeout from 300_000ms → 120_000ms (and internal poll 290s → 110s, reaper 310s → 130s) under the assumption that **2 min suffices when the user is "briefly attending the phone"**. Real mobile usage on 2026-05-15 falsified that assumption:

- phone IM notification delivery has its own latency
- user switching from whatever app they're in → IM app → tab takes seconds
- reading the question + options + descriptions on a small screen takes longer than on desktop
- thumb-typing a free-text answer is 3-5× slower than keyboard
- if the user is genuinely out (commuting, in a meeting, in a queue), the elapsed wall-clock to reply easily exceeds 2 min

### 10.1 Revised numbers (replaces §9.5)

| Layer | §9.5 value | §10 value | What it protects |
| --- | --- | --- | --- |
| `hook-receiver.ts` `ASK_USER_QUESTION_TIMEOUT_MS` (hook internal poll deadline) | 110_000ms | **300_000ms** | User-perceptible budget — how long the user has from notification to having their reply land in cc's tool result. |
| `setup-hooks.ts` AUQ matcher `timeout` (cc-side OS-level hook kill) | 120 (s) | **310** | cc-side budget. Must equal poll deadline + small margin so the hook stdout deterministic and daemon retry budget aren't truncated. |
| `orchestrator.ts` `ASK_USER_QUESTION_REAPER_DELAY_MS` (daemon orphan cleanup) | 130_000ms | **320_000ms** | Defensive cleanup of SIGKILL'd hooks. Must exceed cc-side timeout so the daemon doesn't unlink a live Request file while the hook is still polling. |

10s margin between adjacent layers preserved.

### 10.2 What did NOT change

- A2 hook IPC mechanism (file-based PermissionRequest/Response)
- B0 D5-D `allow + updatedInput.answers` channel (§9 retract / §9.3 protocol)
- AI router AUQ prompt + answer schema
- Late-reply dead-drop IM notice (`⏱ cc 已超时，本轮不再等待`)
- IM echo two-state rendering (`target / 你答 ①: <label>` vs `target / 自由回答: <text>`)

The change is **literal constants only** — no structural / protocol / scope rework.

### 10.3 Why this is a sub-revision, not a new DD

- One sub-decision changes (timeout magnitude) on an axis already DD-locked (D2-B "hook holds until IM reply")
- Candidate space: trivially small (number to pick; user already provided floor 300s)
- Reversibility: cheap — three constants + 1 test + doc rewrites
- Below "重大决策" threshold (no architecture / safety model / cross-package interface change)

Per CLAUDE.md "5 步 DD 流程" applies to architecture lock-in; sub-revisions of magnitude on an existing axis are recorded inline.

### 10.4 PermissionRequest left at 120s

`setup-hooks.ts` `PermissionRequest` event still has `timeout: 120` (the v1.12 "mirror AUQ" decision per DD #v1.12 D8). User has not reported PermissionRequest timeouts failing on mobile yet, so scope is held to AUQ.

If future feedback shows PermissionRequest dialogs also time out on mobile, the same revision pattern applies (separate sub-revision under v1.12 DD).
