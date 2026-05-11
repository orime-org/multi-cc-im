# DD: Lark group-chat support (`#bot` in group chats)

**Date**: 2026-05-12
**Status**: 🟡 DRAFT — pending user step-5 decision

---

## 0. Motivation

User wants the Feishu bot to work in **group chats** they belong to, not only in 1-on-1 DM. Use case: the user is in a team / family / project group, wants to `#frontend hello` from that group and have cc reply.

Per earlier scoping (2026-05-12 conversation):
- **Personal use only** — only the bot owner can route from groups; other group members' messages are ignored.
- ACL collapses to **owner-only** (no per-tab allowlist / per-user permission).
- Bot acts as a "second entry point" alongside DM; not a multi-user shared assistant.

This DD does NOT cover: multi-user routing, per-tab allowlist, per-group config. Those are out-of-scope for v1.9.

---

## 1. Core constraints

- **C1 — Owner-only**: the bot accepts routing commands ONLY from the configured owner's `open_id`. Messages from other group members are silently dropped (no error echo — that'd leak the bot's presence + leak which commands were attempted).
- **C2 — No public IP**: `WSClient` long-connection only. No webhook. Already enforced by current architecture.
- **C3 — One symbol, all chats**: the `#<tab>` routing prefix from [DD 2026-05-12 routing-symbol-change](2026-05-12-routing-symbol-change-dd.md) must work identically in DM and groups. No group-specific syntax.
- **C4 — Privacy default**: a group bot exposes the user's command surface to all group members. Tool-permission prompts (`Bash(rm -rf /private/repo)`) contain sensitive details; routing failure echoes leak which tabs exist. Privacy-default = "what would a co-worker incidentally seeing the chat learn about the user's work?".
- **C5 — Backward compat with DM**: existing 1-on-1 flow must not regress. Single setting toggle on the Feishu Open Platform side is allowed; daemon code must work for both.

---

## 2. 尽调 (Feishu Open Platform — real evidence)

Fetched 2026-05-12 from `open.larksuite.com/document/server-docs/im-v1/...`:

### 2.1 Event payload differs only by one field

`im.message.receive_v1` event delivers the same JSON shape for P2P and group; one field switches:

```json
{
  "message": {
    "chat_type": "p2p" | "group",
    "chat_id": "oc_xxxxxxxx",  // same format both contexts
    "message_id": "om_xxxx",
    "message_type": "text",
    "content": "{\"text\":\"...\"}",
    "mentions": [...]  // present when bot/users @-mentioned
  },
  "sender": {
    "sender_id": { "open_id": "ou_xxxx", ... }
  }
}
```

### 2.2 @-bot in group text is a PLACEHOLDER

In a group, when user types `@MyBot #frontend hello`, the inbound `content.text` arrives as:

```
"@_user_1 #frontend hello"
```

— literal `@_user_1` placeholder, **not** the bot's display name. The mapping lives in `mentions`:

```json
"mentions": [
  {
    "key": "@_user_1",
    "id": {
      "open_id": "ou_<the-bot's-open-id>",
      "user_id": "...",
      "union_id": "..."
    },
    "name": "MyBot"
  }
]
```

**Implication**: the bridge `parser.parse()` currently checks `text.startsWith('#')`. With `"@_user_1 #frontend hello"`, that check fails and the message falls through to AI router as plain. Need a preprocessing step to strip the bot's @-mention placeholder before parsing.

### 2.3 chat_id is the same key for outbound in both contexts

`im.v1.message.create` with `receive_id_type='chat_id'` works for both DM and group. Current outbound code (`adapter.ts:329-358`) already uses `chat_id` from `replyCtx.chatId` — no change needed for the basic "reply to source chat" path.

### 2.4 OAuth scope determines what bot receives

Three relevant scopes (one or more must be granted on the Feishu Open Platform):

| Scope | Bot receives |
|---|---|
| `im:message.p2p_msg(:readonly)` | DM events (currently used) |
| `im:message.group_msg(:readonly)` | ALL group messages where bot is present (firehose) |
| `im:message.group_at_msg(:readonly)` | Only messages explicitly @-mentioning bot |

### 2.5 reply API exists but isn't strictly necessary

The `create` endpoint can include `root_id` / `parent_id` / `thread_id` for nested-reply semantics; there's also a dedicated `reply` endpoint. Neither is required for basic group support — `chat_id` alone gives a "new message in chat" which works.

---

## 3. Dimensions & candidates

### D1 — Permission scope (what the bot subscribes to in groups)

| ID | Candidate | First-pass note |
|---|---|---|
| D1-1 | Don't add group support (status quo P2P only) | Required candidate per CLAUDE.md. Working baseline. |
| **D1-2** | `im:message.group_at_msg(:readonly)` — only @-bot in groups | Bot is silent unless user explicitly @s it. Mirrors DM "user → bot direct" pattern. |
| D1-3 | `im:message.group_msg(:readonly)` — every group message | Firehose. Daemon spawns cc-triage per message → cost. Privacy concern — bot is implicitly observing co-workers. |
| D1-4 | Both `group_at_msg` AND `group_msg` | Strict superset of D1-3 — `group_msg` already covers @-messages. No-op vs D1-3. |

### D2 — `@_user_N` placeholder handling in text

| ID | Candidate | First-pass note |
|---|---|---|
| D2-1 | Strip only the **bot's** @-mention placeholder (preserve other users' @s) | Cleanest. User typing `@<coworker> #frontend ...` keeps the coworker reference visible to AI / cc. |
| D2-2 | Strip **all** `@_user_N` placeholders uniformly | Simpler implementation (regex `/@_user_\d+\s*/g`). Loses semantic info if user @-ed multiple parties for context. |
| D2-3 | Don't preprocess — let parser see `@_user_1 #frontend hello` as plain | Plain message → AI router fallback. Inconsistent UX vs DM (DM `#frontend hello` is exact-route; group falls to AI). |

### D3 — Where cc's text reply (Stop hook) goes

Currently `state/IMOrigin` is a single file, latest-inbound-wins. Group introduces a second chat surface (the group's `chat_id`) alongside DM (user's DM `chat_id`).

| ID | Candidate | First-pass note |
|---|---|---|
| D3-1 | Latest-IMOrigin-wins (status quo) | Breaks across chats: ask in A-group → 20s of cc work → user sends `/list` in DM → IMOrigin overwritten with DM's chat_id → cc reply goes to DM, surprising both contexts. |
| **D3-2** | Per-tab sticky chat_id | Each tab remembers which chat last routed to it. cc reply goes back to that chat. Echoes user's "I sent the command from here, reply comes back here". |
| D3-3 | Per-chat IMOrigin map (`state/IMOrigin/<chatId>.json`) | More general but doesn't solve the "which one" question — still need per-tab mapping to pick. |
| D3-4 | Force-DM (cc reply always goes to user's DM, never the group) | Privacy max — group members never see cc output. But user's mental model fights: "I asked in the group, response should be in the group". |

### D4 — Where PreToolUse permission prompts go

Permission prompts contain sensitive command details (`Bash(rm -rf /private/repo)`, `Edit /etc/hosts`, etc.). Different sensitivity profile than D3 (regular text reply is usually benign).

| ID | Candidate | First-pass note |
|---|---|---|
| D4-1 | Same chat as the routing message (= D3-2 per-tab) | UX continuity. But leaks sensitive command surface to group. |
| **D4-2** | Force-DM for permission prompts (split from D3) | Daemon must know user's DM `chat_id`. Privacy default. |
| D4-3 | Force-DM only when source chat is a group; same chat when source is DM | Conditional D4-1 + D4-2. Slightly more complex. |
| D4-4 | Mask command details in group ("⏳ approval needed for `Bash(...)` — see DM") + full prompt to DM | Hybrid: group gets a redacted ping so user knows there's a pending; full sensitive detail only in DM. |

D4-2 requires the daemon to know the user's DM `chat_id`. Two ways to acquire:
- **(a)** Setup wizard asks for a `userOpenId` and daemon constructs a P2P chat by sending a message via `receive_id_type='open_id'` (the chat is implicitly created on first send).
- **(b)** Daemon caches the first P2P inbound's `chat_id` to `state/UserDmChatId` and uses that. Simpler, no wizard change, but requires the user to DM the bot at least once after enabling group support.

### D5 — Reply-in-thread

| ID | Candidate | First-pass note |
|---|---|---|
| **D5-1** | Plain new message in chat (status quo `chat_id` only) | No-thread, simple, works. |
| D5-2 | Use `reply` API with `parent_id = inbound message_id` | cc reply is nested under the user's routing message in the chat UI. Better thread continuity but only valuable in groups (DM doesn't benefit). Adds a new code path. |
| D5-3 | Conditional: thread-reply in groups, plain in DM | Best UX. Most code. |

---

## 4. Per-dim matrix

### D1 (scope)

| Dim | D1-1 (no group) | D1-2 (group_at_msg) | D1-3 (group_msg) |
|---|---|---|---|
| Privacy (C4) — bot observability | ✅ none | ✅ only @-events | ❌ every group message observed |
| Daemon cost (cc-triage per msg) | ✅ none | ✅ low (only @-msgs) | ❌ high (every msg) |
| UX expectation match | ⚠️ user wants group | ✅ "@bot to talk to bot" | ⚠️ confusing — bot answers unprovoked? |
| Implementation cost | ✅ zero | ⚠️ moderate (parser preprocess + scope + tests) | ⚠️ same scaffolding |
| Other group members' reaction | ✅ n/a | ✅ only see explicit @s | ❌ feel surveilled |

### D2 (@-placeholder strip)

| Dim | D2-1 (bot only) | D2-2 (all @) | D2-3 (none) |
|---|---|---|---|
| Routes work in group | ✅ | ✅ | ❌ falls to AI |
| Preserves user's intent (e.g. @coworker context) | ✅ | ❌ silently rewrites | ✅ |
| Implementation complexity | ⚠️ needs to identify bot's own open_id | ✅ trivial regex | ✅ trivial (no-op) |

### D3 (cc reply destination)

| Dim | D3-1 (latest) | D3-2 (per-tab) | D3-3 (per-chat map) | D3-4 (force DM) |
|---|---|---|---|---|
| Cross-chat correctness | ❌ overwrites | ✅ | ✅ | ✅ |
| "Reply where I asked" UX | ⚠️ if no intervening | ✅ | ✅ | ❌ |
| Privacy | ⚠️ | ⚠️ | ⚠️ | ✅ |
| State complexity | ✅ minimal | ⚠️ new state file | ❌ new dir structure | ⚠️ user-DM cache |
| Backward compat | ✅ no-op for DM-only | ✅ no-op for DM-only | ✅ no-op for DM-only | ⚠️ DM = DM, same effect |

### D4 (permission prompt destination)

| Dim | D4-1 (=D3) | D4-2 (force DM) | D4-3 (conditional) | D4-4 (hybrid) |
|---|---|---|---|---|
| Sensitive detail privacy | ❌ leaks to group | ✅ DM only | ✅ DM when group source | ⚠️ partial (ping in group) |
| User responsiveness | ✅ where they look | ✅ if user uses DM | ✅ | ⚠️ split-screen |
| Implementation cost | ✅ piggyback D3 | ⚠️ user-DM cache | ⚠️ + per-source branching | ❌ two-message protocol |

### D5 (thread reply)

| Dim | D5-1 (plain) | D5-2 (always thread) | D5-3 (conditional) |
|---|---|---|---|
| Group context continuity | ⚠️ separate msg | ✅ nested | ✅ nested in group |
| DM thread is overkill | n/a | ⚠️ unneeded | ✅ avoided |
| New code path | ✅ none | ⚠️ reply API integration | ⚠️ + branching |

---

## 5. Recommendations

| Dim | Recommendation | Reason (traceable to matrix) |
|---|---|---|
| **D1** | **D1-2** `im:message.group_at_msg(:readonly)` | Best privacy + cost + UX match (D1 matrix every row but "no group"). Mirrors DM "user → bot directly" pattern. |
| **D2** | **D2-1** strip only the bot's @-mention placeholder | Routes work in group (D2 row 1) + preserves user's @-coworker context (D2 row 2). Needs to know bot's own `open_id` — already derivable from app credentials at startup (Feishu `auth.v3.app.access_token` returns `app.bot.open_id`, or use first `mentions[].id.open_id` whose `name` matches bot's display name — TBD in implementation). |
| **D3** | **D3-2** per-tab sticky chat_id | Best cross-chat correctness + "reply where I asked" UX (D3 rows 1+2). Privacy concern for non-sensitive cc text reply is acceptable — the user opted into the group by routing from there. Implementation: extend the existing per-tab sticky state to also persist `chat_id`. |
| **D4** | **D4-2** force-DM for permission prompts | Privacy default (C4): sensitive command details (`Bash(rm -rf ...)`) never leak to group. Use the (b) acquisition path — daemon caches the first P2P inbound `chat_id` to `state/UserDmChatId`. If the cache is empty (user has only ever used the group), echo a one-time "please DM me /start to enable group routing — permission prompts go to DM" in the group as a fallback to bootstrap. |
| **D5** | **D5-1** plain send (status quo) | Defer thread-reply to a follow-up DD. Simplifies P1-P4 milestones. D5-2/D5-3 are pure UX polish, not blocking. |

### Key safety property

D1-2 + D4-2 combination produces this audit-friendly behavior:
- In a group, bot only sees messages where user @-mentioned it. Other group activity is invisible to daemon.
- cc text reply (status, progress, results) goes to the group where command was issued — visible to group members.
- Tool permission prompts (`Bash` / `Edit` / `WebFetch`) ALWAYS go to user's DM. Group members never see what cc is being asked to execute.
- Audit log line `[group dispatch] chat=<chatId> tab=<X> ...` for every group-sourced action, mirroring `[AI router]` and `[AI permission]`.

---

## 6. User decision (step 5 of DD process)

| Dim | Recommendation | User decision |
|---|---|---|
| D1 | D1-2 — group_at_msg only | ⏳ |
| D2 | D2-1 — strip only bot's @-placeholder | ⏳ |
| D3 | D3-2 — per-tab sticky chat_id | ⏳ |
| D4 | D4-2 — force-DM for permission prompts | ⏳ |
| D5 | D5-1 — plain send (no thread) | ⏳ |

When all five `⏳` rows resolve, this DD enters **LOCKED** and implementation milestones in §7 move into [`docs/conventions.md`](../../conventions.md).

---

## 7. Implementation milestones (post-lock)

| ID | Scope |
|---|---|
| **P1** | `packages/im-lark/src/adapter.ts` extend event handler: branch on `chat_type`; in group path resolve bot's own `open_id` (cache from `auth.v3.app.access_token` endpoint at adapter start); strip the bot's `@_user_N` placeholder from `content.text` (D2-1); enforce owner-only (drop events where `sender.sender_id.open_id !== ownerOpenId`). |
| **P2** | Setup wizard: lark schema gains optional `ownerOpenId` field (auto-derived from first DM inbound if not provided in setup, but persisted in `credentials/lark.json` after first capture for restart resilience). |
| **P3** | `packages/cli-cc/src/state-files.ts` + bridge: extend `RouterState` (or new state) with per-tab sticky `chat_id`. Per-pane file `state/<paneId>.SourceChat` or extend existing IMOrigin schema. D3-2. |
| **P4** | Orchestrator: introduce `state/UserDmChatId` cache, populated on first P2P inbound. PreToolUse forward (D4-2) reads from this cache. Bootstrap echo when cache empty + group inbound triggers permission flow. |
| **P5** | Tests: adapter unit (group event handling / @-placeholder strip / owner-only filter / chat_type branching); router unit (sticky chat_id); orchestrator integration (force-DM permission with cache hit / cache miss / DM-only fallback). |
| **P6** | Docs: README + README.zh-CN — small "Use bot in group chats" section; conventions.md status row v1.9 + revision log; setup-feishu.md — instructions to enable the `im:message.group_at_msg:readonly` scope + add bot to group. |

---

## 8. Open questions for review

1. **D2-1 implementation**: how to resolve bot's own `open_id`? Two paths:
   - (a) Fetch `app.bot.open_id` from `auth.v3.app.access_token` response at adapter startup. Adds one API call but deterministic.
   - (b) On first inbound where `mentions[].name` matches the bot's known display name. Inferred, more fragile.
   - Prefer (a). TBD whether the SDK exposes this cleanly.
2. **D4-2 cache miss fallback**: if user hasn't DM-ed the bot yet, where does the permission prompt go?
   - Proposed: echo a one-line "DM me /start first" in the source group (no command details), wait for user to DM, then retroactively replay? Or just drop with a warning? Edge case scope.
3. **Backward compat with existing `state/IMOrigin`**: current single-file IMOrigin still works for DM-only users who don't enable group scope. P3 must keep it functional or migrate atomically.

---

## 9. Review log

- **2026-05-12 (a)** — DD drafted. User scope pre-locked: personal-only, ACL owner-only. Web fetches captured §2 hard facts. Recommendations §5 build on the matrix in §4.
