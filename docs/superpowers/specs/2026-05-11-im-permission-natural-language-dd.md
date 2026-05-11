# DD: Natural-language IM permission replies

**Date**: 2026-05-11
**Status**: ✅ **LOCKED** (decisions accepted by user 2026-05-11; see §10)
**Author**: multi-cc-im maintainer
**Scope**: extend the PreToolUse permission flow so users can approve / deny a pending tool call in IM with natural language (e.g. `"multi-cc-im 那个我同意"` / `"node 的请求拒绝"`) instead of the rigid `@<tab> /1` / `@<tab> /2` syntax. Affects `packages/bridge/src/{router,ai-router,orchestrator}.ts`, the AI-router prompt, and `RouterResult` shape (cross-package contract via `@multi-cc-im/shared` if extended).

---

## 1. Why this is a "重大决策"

Per [`CLAUDE.md`](../../../CLAUDE.md) DD heuristic, four triggers fire:

- **安全模型** — Tool-call permission is the most sensitive entry point. An AI misclassification (allow vs deny vs "this is a regular IM message") can cause `rm -rf` to run when the user said "no". Worse than a routing miss because it touches real side effects.
- **跨包接口** — `RouterResult` shape likely expands; orchestrator gets a new branch (write `PermissionResponse` file instead of cc dispatch); AI-router prompt + output schema change; bridge needs to know which tabs have pending Requests.
- **反悔代价 > 1 周** — Once users get used to natural-language replies, removing the feature is a UX regression. The implementation also affects multiple files + needs careful test coverage.
- **"用现有 SDK 不造轮子"准则** — Prompt design + disambiguation between "this is a permission reply" and "this is a regular IM message" needs evidence-based comparison, not vibe.

Reversal cost ≈ 1-2 weeks (code + tests + prompt iteration + user retraining if rolled back).

---

## 2. Use-case constraints (locked)

These constraints come from existing project rules and are **non-negotiable** for any candidate:

1. **No public IP** — the daemon stays no-webhook. All permission replies come over the existing WSClient inbound channel (just like routing today).
2. **Existing rigid syntax must keep working** — the `@<tab> /1` / `@<tab> /2` flow has been smoke-tested through W7 + PRs #104–#113. Whatever we add must not break it.
3. **Deny by default on ambiguity** — when AI can't confidently classify a message as approve / deny, the daemon must NOT auto-allow. Falling through to "no decision" (let the existing 10s timeout fire its default-allow) is acceptable; auto-allowing on a misread is not.
4. **Per-pane state** — PermissionRequest files are paneId+sid keyed; permission responses must be routed to the exact `(paneId, sid, requestId)` triple that's pending, not just "any pending Request".
5. **No new external dependency** — the AI evaluation reuses the existing `claude --print` subprocess pattern (W3 DD #73). No new prompt-frameworks or LLM-router libraries.

---

## 3. Decision dimensions

| Dim | Question | Status |
|---|---|---|
| **D1** | Keep `@<tab> /1` / `@<tab> /2` rigid syntax as backward compat? | 🟡 candidates §4 |
| **D2** | How does the AI know which tabs have pending PermissionRequests? | 🟡 candidates §5 |
| **D3** | How does the AI output the permission decision? Same JSON as routing, or separate? | 🟡 candidates §6 |
| **D4** | When a plain IM message arrives, how to disambiguate "regular cc dispatch" from "permission reply"? | 🟡 candidates §7 |
| **D5** | Safety fallbacks for AI misclassification | 🟡 candidates §8 |

---

## 4. D1 — Backward compat for `@<tab> /1` / `@<tab> /2` syntax

### 4.1 Candidates

| | Candidate | Notes |
|---|---|---|
| **D1-1** | **Keep rigid syntax forever, no AI permission** (do-nothing baseline) | Current state. AI permission feature not built. |
| **D1-2** | **Drop rigid syntax**, route all permission replies through AI | AI is the only path. Less code surface but more LLM-dependent. |
| **D1-3** | **Keep rigid syntax as deterministic fast path + AI for natural language** | Parser detects `/1`/`/2` early like today; AI engages only when no parser match. Mirrors the W5 substring-fallback pattern. |

### 4.2 Matrix

| Candidate | Feature delivered | Constraint #2 (`/1` `/2` keeps working) | Safety floor | UX |
|---|---|---|---|---|
| **D1-1** | ❌ no | ✓ | safe (deterministic only) | rigid only |
| **D1-2** | ✓ | ❌ violates | LLM-dependent | best |
| **D1-3** | ✓ | ✓ | safe (rigid path bypasses AI) | best |

### 4.3 Recommendation: D1-3

Trace to matrix:
- D1-1: ❌ feature delivered (no AI path = doesn't solve the user's ask)
- D1-2: ❌ constraint #2 (drops the rigid syntax we just spent W7 + #112 hardening)
- D1-3: ✓ on every column

This is the only candidate that actually delivers the feature without breaking the existing flow. Mirrors W5's substring fallback pattern (try deterministic first, AI second).

---

## 5. D2 — AI awareness of pending PermissionRequests

### 5.1 Candidates

| | Candidate | Notes |
|---|---|---|
| **D2-1** | **AI doesn't know about Requests; daemon verifies post-hoc** | AI just classifies the message + picks a tab. Daemon checks if that tab has a pending Request matching the decision. If not → fall through to regular cc dispatch (or error echo). Simpler prompt but more daemon-side state checking. |
| **D2-2** | **Orchestrator maintains in-memory pending-Request map; prompt is enriched** | When AI is asked to classify, prompt includes "Tab X has pending Request: Bash(rm -rf node_modules); Tab Y has no pending Request". AI can match content. Daemon state needs to track + sync (chokidar watcher already sees Request file events). |
| **D2-3** | **Daemon re-scans `*.PermissionRequest.*` files at each plain message** | No in-memory state; scan disk each time. Trades small per-message latency for state simplicity. |

### 5.2 Matrix

| Candidate | State complexity | Per-msg latency | Race risk | AI prompt richness |
|---|---|---|---|---|
| **D2-1** | none | none | none | ❌ blind (no Request info in prompt) |
| **D2-2** | medium (Set + watcher sync) | low after first | ⚠ in-mem vs disk drift on watcher lag | ✓ full Request payload |
| **D2-3** | none | small (readdir + readFile per Request) | none | ✓ full Request payload |

### 5.3 Recommendation: D2-3

Trace to matrix:
- D2-1: ❌ blind AI can't match "我同意刚才那个 rm -rf" to a specific Request (semantic gap)
- D2-2: ⚠ state drift risk (chokidar event lag — Request file written, watcher event not yet fired, message arrives in-between → daemon thinks no pending Request)
- D2-3: same prompt richness as D2-2 without the in-mem state + race risk; readdir on a small state dir (typically <10 files) is ~1 ms on local SSD — negligible

Sync read is OK because the AI-router subprocess (~2-10s) dominates per-message cost; +1 ms readdir doesn't move the needle.

---

## 6. D3 — AI output schema

### 6.1 Candidates

| | Candidate | Notes |
|---|---|---|
| **D3-1** | **Extend the existing AI-router output JSON with `permissionResponse?: {target, decision, reason?}`** | One AI call covers both routing + permission. Single prompt iteration. Daemon picks branch based on which field is populated. |
| **D3-2** | **Separate AI calls: routing vs permission. Daemon decides which to run** | Daemon checks: any pending Request? If yes → run permission AI; if no → run routing AI. Two prompts (cleaner separation but 2× cold-start cost when both applicable). |
| **D3-3** | **Single AI call returns a `mode: 'route' \| 'permission'` discriminator + relevant fields** | Combined prompt but explicit branch tag from AI. Helps debugging (you see which mode AI thought it was in). |

### 6.2 Matrix

| Candidate | AI calls / msg | Schema change | Daemon dispatch | Debug clarity |
|---|---|---|---|---|
| **D3-1** | 1 | minimal (`permissionResponse?`) | check which field populated | implicit |
| **D3-2** | 1-2 | minimal (no schema change) | gate-based, clear | clearest |
| **D3-3** | 1 | small (mode tag + fields) | switch on mode | explicit |

### 6.3 Recommendation: D3-1

Trace to matrix:
- D3-2: ❌ 2× AI cold-start cost when there are pending Requests AND the user might be doing regular routing — pays the latency twice
- D3-3: viable but `mode` tag is redundant with the populated-field check; D3-1's "check which field is set" is type-system-sound + no separate enum to keep in sync
- D3-1: 1 AI call, smallest schema delta, clear branch logic (`if (aiTrace.permissionResponse) write Response; else route normally`)

Debug clarity gap with D3-3 is partial — we already log `[AI router]` trace (#111); we'll extend it to include `permissionResponse=...` when populated, which gives the same observability.

---

## 7. D4 — Disambiguation: regular IM vs permission reply

### 7.1 Candidates

| | Candidate | Notes |
|---|---|---|
| **D4-1** | **AI decides solely from message content** | AI reads the message + tab list + (optionally pending Requests per D2). Picks: routing target / permission target / nothing. No daemon-side disambiguation. |
| **D4-2** | **Daemon precondition gate**: AI only enters permission mode if there's at least one pending Request | If no pending Requests anywhere → skip permission classification entirely, run routing only. Reduces false-positive permission triggers. |
| **D4-3** | **Explicit user prefix**: `@perm ...` or `/perm ...` triggers permission mode; otherwise routing | Like Slack's `/` commands. Predictable, deterministic. But violates the "natural language" UX the user asked for. |

### 7.2 Matrix

| Candidate | False positive risk | UX (natural language) | Implementation |
|---|---|---|---|
| **D4-1 alone** | ⚠ AI may treat "我同意他的方案" as permission when no Request pending | best | AI-only |
| **D4-2 alone** | 0 | n/a (requires sub-policy for what AI does within gate) | small daemon gate |
| **D4-2 + D4-1** | 0 (gated by precondition) | best within the gate | gate + AI |
| **D4-3** | 0 | ❌ violates "natural language" requirement | parser change |

### 7.3 Recommendation: D4-2 + D4-1

Trace to matrix:
- D4-3: ❌ violates the explicit user requirement that the reply be natural language (no rigid prefix)
- D4-1 alone: ⚠ false positives when no Request is pending — user says "我同意" in regular chat → AI mis-classifies as permission → orphaned write
- D4-2 + D4-1: gate enforces "AI permission mode only when there's something to permission" — eliminates false positives by structure, not by hoping AI is careful

Concretely: in `handlePlainWithAI`, before running AI, check `findPendingPermissionRequests(stateDir)`. If empty → run routing AI only (current behavior). If non-empty → run combined routing-or-permission AI with pending-Request info in the prompt.

---

## 8. D5 — Safety fallbacks for AI misclassification

### 8.1 Candidates

| | Candidate | Notes |
|---|---|---|
| **D5-1** | **No fallback — trust AI fully** | Don't do this. Permission is the most sensitive entry point; AI errors cause real damage (allow vs deny on `rm -rf`). |
| **D5-2** | **AI returns `confidence: 0-1` field; below threshold → defer to existing 10s hook timeout** (default-allow, but user can re-reply with `/1` / `/2`) | AI hedges its bet. Low-confidence permission interpretation → daemon writes NO PermissionResponse → hook hits timeout → default allow + user sees the prompt in IM still. Safe-ish but timeout default-allow is itself a risk. |
| **D5-3** | **Default-deny on AI permission interpretation (asymmetric trust)** | AI is allowed to say "deny this" without further check; AI is NOT allowed to say "allow this" without high confidence. Approve requires extra signal (matching content tokens in user reply, or fall back to `/1` / `/2`). |
| **D5-4** | **Default to "no decision" on any AI permission output; require user `/1` / `/2` confirmation** | AI's natural-language understanding is purely a UX hint ("✓ looks like you want to approve — confirm with `@<tab> /1`"). Most conservative. Defeats most of the UX benefit. |
| **D5-5** | **Log every AI permission decision + reason via daemon stderr `[AI permission]` line** | Independent of which decision logic we pick — always log for traceability. Mirrors the W7 `[AI router]` trace line. |

### 8.2 Matrix

| Candidate | Auto-allow risk | Auto-deny risk | UX vs ideal | Constraint #3 (deny-by-default) |
|---|---|---|---|---|
| **D5-1** | ⚠⚠⚠ high | ⚠ high | best | ❌ violates |
| **D5-2** | ⚠ (low conf → hook timeout → default-allow) | low | small downgrade | ⚠ partial |
| **D5-3** | low (allow needs match-signal) | medium (allow may be downgraded to deny) | small downgrade | ✓ satisfies |
| **D5-4** | 0 | 0 | large (requires `/1` reconfirm) | ✓ satisfies |
| **D5-5** | orthogonal (log only) | orthogonal | orthogonal | orthogonal |

### 8.3 Recommendation: D5-3 + D5-5

Trace to matrix:
- D5-1: ❌ constraint #3 — never acceptable for permission gate
- D5-2: ⚠ constraint #3 — "default-allow on low confidence" pushes risk to the hook timeout layer, which currently defaults to `allow` (per `cli-cc/hook-receiver.ts:286`). Aligning the timeout to `deny` is a separate, more invasive change (changes a contract used by every existing permission flow).
- D5-3: ✓ constraint #3 — AI's deny passes through freely (safe); allow requires the user's reply to also contain a content token matching the Request (tool name, key arg, or paraphrase that AI must justify in `reason`). When the match-signal isn't there, AI is instructed to **emit deny** (not "skip writing Response"), because the existing hook-timeout default-allow would otherwise leak through.
- D5-4: too conservative — defeats the natural-language UX the feature is for. Equivalent to D1-1 in practice.
- D5-5: independent of the above; mandatory.

Concretely D5-3 means the AI prompt instructs:
> If you are inclined to ALLOW, double-check the user's message contains either the tool name (e.g. "Bash"), a key argument substring (e.g. "rm", "node_modules"), or a clear paraphrase (e.g. "删除"). If none of those match, emit `decision: 'deny'` with `reason: 'user message did not match the Request content; conservative deny'`. The user can then re-confirm via `@<tab> /1` to override.

---

## 9. Recommendations

Per-dimension matrices + traces in §4.2 / §5.2 / §6.2 / §7.2 / §8.2.

- **D1 → D1-3** — keep rigid syntax + add AI for natural language (mirrors W5 substring-fallback pattern; only candidate satisfying constraint #2 + feature delivery)
- **D2 → D2-3** — daemon scans `*.PermissionRequest.*` on each message (revised from pre-尽调 lean D2-2 after recognising the state-drift race the watcher path introduces; D2-3 gives same prompt richness without in-memory state)
- **D3 → D3-1** — extend `RouterResult` with `aiTrace.permissionResponse?` (single AI call, smallest schema delta; `[AI router]` trace log extends to cover permission visibility)
- **D4 → D4-2 + D4-1** — daemon precondition gate (only enter permission mode when something is pending) + AI decides within the gate (eliminates false positives by structure, not by hope)
- **D5 → D5-3 + D5-5** — asymmetric trust (AI deny passes through; AI allow requires content match-signal, falls to deny if missing — `safe by default` per constraint #3) + always log via `[AI permission]` trace line

### 9.1 Implementation milestones (post-DD lock)

| ID | Scope |
|---|---|
| **P1** | `packages/cli-cc/src/state-files.ts`: export `listPendingPermissionRequests(stateDir)` helper that reads + parses all `*.PermissionRequest.*.json` files (paneId, sid, requestId, toolName, toolInput, createdAt). |
| **P2** | `packages/bridge/src/ai-router.ts`: extend prompt to accept optional `pendingRequests` array; extend output JSON with `permissionResponse?: {target, decision, reason}`; update `AIRoutingResult` type. Add prompt rules (D5-3 match-signal logic + content-token guidance). |
| **P3** | `packages/bridge/src/router.ts handlePlainWithAI`: when called, first run `listPendingPermissionRequests`. If non-empty, include them in the AI prompt. After AI returns: if `aiTrace.permissionResponse` is populated → set `RouterResult.permissionResponse` field for orchestrator dispatch. Backward compat: parser's existing `@<tab> /1 /2` path is unchanged (D1-3). |
| **P4** | `packages/bridge/src/orchestrator.ts`: on `result.permissionResponse` (from AI path), call the same `handlePermissionResponseFromIM(paneId, decision, replyCtx)` helper that the rigid-syntax path uses. Log `[AI permission] target=<x> decision=<allow\|deny> reason="..."`. |
| **P5** | Tests: router unit tests for AI permission path (4-6 scenarios: clean approve / clean deny / approve-without-match-signal-degrades-to-deny / message also has tab name but no pending → routes normally / multi-tab pending → AI picks one); ai-router prompt tests for new rules; orchestrator integration test for the dispatch branch. |
| **P6** | Docs: README mention natural-language permission replies (small addition under permission section); conventions.md status row + revision log v1.7. |

---

## 10. User decision (step 5 of DD process)

Track per-dimension decision below. Each dimension is independent — user can accept or override the recommendation.

| Dim | Recommendation | User decision |
|---|---|---|
| D1 | D1-3 — rigid syntax + AI natural-language layered (§4.3) | ✅ accepted 2026-05-11 |
| D2 | D2-3 — daemon scans `*.PermissionRequest.*` per message (§5.3) | ✅ accepted 2026-05-11 |
| D3 | D3-1 — extend AI output with `permissionResponse?` (§6.3) | ✅ accepted 2026-05-11 |
| D4 | D4-2 + D4-1 — precondition gate + AI decides within (§7.3) | ✅ accepted 2026-05-11 |
| D5 | D5-3 + D5-5 — asymmetric trust (deny safe / allow needs match-signal) + always log (§8.3) | ✅ accepted 2026-05-11 |

All five rows resolved. DD is **LOCKED**. P1-P6 implementation milestones in §9.1 move into [`docs/conventions.md`](../../conventions.md) status table.

When all five `⏳` rows resolve, this DD enters **LOCKED** and implementation milestones move into [`docs/conventions.md`](../../conventions.md).

---

## 11. Review log

- **2026-05-11 (a)** — initial draft. Candidate enumeration for 5 dimensions completed. Awaiting user review of candidate list before running 尽调 / drafting matrix.
- **2026-05-11 (b)** — candidate list accepted by user verbatim. Matrices + traceable recommendations added per dim. Pre-尽调 lean revised for D2 from D2-2 (in-memory + watcher) to D2-3 (disk-scan per message) after recognising the watcher-vs-event race risk. DD now at Step 4; awaiting user step-5 picks per dimension.
- **2026-05-11 (c)** — User accepted all 5 recommendations verbatim. DD status flipped to **LOCKED**. P1-P6 implementation milestones reflected in [`docs/conventions.md`](../../conventions.md) status table.
