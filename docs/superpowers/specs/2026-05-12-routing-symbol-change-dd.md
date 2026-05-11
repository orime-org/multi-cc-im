# DD: Routing prefix change `@` → `#`

**Date**: 2026-05-12
**Status**: ✅ LOCKED — user decided 2026-05-12
**Supersedes**: [`2026-05-04-routing-syntax-dd.md`](2026-05-04-routing-syntax-dd.md) §G' for the prefix character only — all other routing rules (4-level fuzzy match / multi-target via space / `<prefix>all` broadcast / sticky-current / `<prefix><tab> /1 /2` permission) unchanged.

---

## 1. Motivation

Real-account smoke 2026-05-12: user reports that on Feishu (desktop + mobile), typing `@` in the message composer triggers Feishu's **user-mention picker** UI. The picker converts the typed handle into a Lark mention object — the resulting message payload's `text` field contains only a placeholder, NOT the literal `@<tab>` string the bridge parser expects.

Concrete failure path:

1. User in a Feishu group wants to route `@bot @frontend hello`.
2. Picker fires on first `@`, user selects bot — message gains a mention object for the bot.
3. Picker fires again on second `@`, no user named "frontend" exists → user dismisses picker or types something else.
4. Even if user persists, Lark's text field comes through to the bridge as `@<bot_mention_object> ...` with the inline-typed `@frontend` either rewritten or stripped.
5. Bridge `parser.parse()` (which gates on `text.startsWith('@')`) sees something it can't handle → falls through to plain / AI router.

This is a **protocol-level** problem, not a UX inconvenience. The `@` character is owned by Feishu's UI layer; user cannot reliably get the literal `@frontend` string into the message body.

Cross-IM check: Telegram, WeChat, Discord all have similar `@`-mention pickers. `@` as a tab-routing prefix is fundamentally fragile across modern IMs.

---

## 2. Constraints

- **C1 — One symbol, all platforms**: the prefix must work consistently in Feishu (today), Telegram (future), WeChat (already removed but may return). Symbol-per-IM is a recipe for user confusion.
- **C2 — Easy to type on mobile keyboards** (CN + EN): the user uses the IM primarily from a phone. Multi-tap symbols, dead keys, or shift-only-on-some-layouts symbols disqualify.
- **C3 — Visually distinct from natural text**: tab-routing must be unambiguous at the start of a message. Symbols that frequently occur in normal Chinese / English (full stops, commas, quotes, parentheses) are out.
- **C4 — No IM-layer rewrite**: must NOT trigger any IM's input picker, autocomplete, formatting parser, or hashtag/mention conversion.
- **C5 — One symbol, hard cutover**: user directive 2026-05-12 — `彻底一点，全部改掉，不要保留其他的`. No dual-syntax, no escape hatches, no compat shim.

Per CLAUDE.md「明令禁止的补丁词汇」: this rules out D1-3 ("`@` + `#` dual") and D1-5 ("escape via backticks"). Listed for completeness in §3 but eliminated up front.

---

## 3. Candidate enumeration

### D1 — Approach (do we change at all, and how)

| ID | Candidate | First-pass note |
|---|---|---|
| **D1-1** | Don't change — keep `@`, document the Feishu limitation, expect user workaround | Per CLAUDE.md DD candidate枚举 must include 不做 X. But Feishu has no documented escape; this is functional fail, not a workaround. |
| **D1-2** | Replace `@` with a different single-character prefix (sub-dim D2 below) | The natural fix. |
| D1-3 | Dual syntax — `@` and `<new>` both work | Compat shim. CLAUDE.md「明令禁止的补丁词汇」. Eliminated. |
| D1-4 | No prefix, parser keys on cmd word (`to frontend hello` / `tab frontend hello`) | Drops the visual cue + complicates parsing (where does the tab name end, where does the body start?). Loses 4-level fuzzy match design. |
| D1-5 | Escape via backticks (`` `@frontend` ``) | Feishu picker fires on the `@` regardless of surrounding chars. Eliminated. |

D1-2 wins by elimination. Question reduces to which character.

### D2 — Symbol choice (assuming D1-2)

Candidates restricted to single ASCII chars present on all phone keyboards without shift / multi-tap:

| ID | Symbol | First-pass note |
|---|---|---|
| **D2-1** | `#` | Slack channel / Discord channel / Twitter hashtag / IRC. Universal "scope marker" convention. |
| D2-2 | `>` | Shell / IRC prompt. Looks like quote or redirect. Visually confusing as routing. |
| D2-3 | `!` | Slack alerts (`!here` `!channel`). Frequently used in natural Chinese/EN text as punctuation. |
| D2-4 | `:` | Emoji shortcode marker (`:smile:`). Some IMs trigger emoji picker. RISKY. |
| D2-5 | `+` | No IM special handling. Visually weak; "add" semantics misleading. |
| D2-6 | `^` | No IM special handling. Visually weak. Multi-tap on some keyboards. |
| D2-7 | `~` | Markdown strikethrough (`~text~`). Some IMs render. RISKY. |
| D2-8 | `.` | Sentence terminator. Constantly in user prose. Eliminated. |
| D2-9 | `*` | Markdown bold (`*text*`). Rendered. Eliminated. |
| D2-10 | `&` | HTML/URL escape (`&amp;`). Eliminated. |
| D2-11 | `=` | No special handling but visually atypical. Tab `=exact` matcher already overloads it; would collide. |

---

## 4. 尽调 (Due diligence per top candidates)

### `#` (D2-1)

- **Feishu text rendering**: `#` has NO inline parsing in Feishu IM. No hashtag conversion, no scope marker, no UI picker. Verified by trial — typing `#frontend` in a Feishu message leaves it as plain text in the `text` field.
- **Lark Open API event payload**: `im.message.receive_v1` `body.content` JSON's `text` field passes `#` through verbatim. No mention object created.
- **Other IMs sanity check**:
  - Telegram bot API: `#` is not parsed by Bot API as anything special. Telegram client renders `#hashtag` as a clickable hashtag in chat history, but the bot receives raw text.
  - WeChat (if revived later): `#` has no special handling.
  - Discord: `#channel-name` is rendered as channel link in client, but bot APIs receive raw text. Bridge would not be Discord-rendered.
- **Convention precedent**: Slack channels (`#general`), Discord channels (`#general`), Twitter (`#hashtag`), IRC (`#room`), Git (`#issue-123`) — `#` is THE de-facto "scope/topic identifier" character in chat / dev tools. Zero learning curve.
- **Mobile keyboard accessibility (CN + EN)**:
  - iOS English: `#` is on the first-page symbol layer (Shift + 3 alternative)
  - iOS Chinese (拼音): `#` requires switching to symbol mode but is on first symbol page
  - Android keyboards: identical
  - 1 keystroke after symbol-mode toggle; same effort as `@`
- **Visual clarity**: `#frontend` is unambiguous, hard to confuse with prose.

### `>` (D2-2)

- **Feishu rendering**: no special handling, passes through.
- **Risk**: `>` is commonly used as quote/cite marker in Markdown (`> text`). Feishu may not parse, but other IMs (Telegram, Slack) DO render `> text` as block quote. Cross-IM consistency lost.
- **Convention**: not a recognized "addressing" character anywhere.
- **Verdict**: viable but loses cross-IM consistency. Inferior to `#`.

### `!` (D2-3)

- **Feishu rendering**: passes through.
- **Risk**: `!` at sentence-start is exclamation in natural text ("!好的"). Conflicts with the rule "leading prefix = tab routing".
- **Verdict**: false positives — user-typed surprise/emphasis at message start gets parsed as routing. Eliminated.

### `:` (D2-4)

- **Feishu rendering**: `:emoji_name:` triggers emoji autocomplete picker in many clients.
- **Risk**: same input-rewrite class of bug as `@`.
- **Verdict**: HIGH RISK of repeating the `@` failure mode. Eliminated.

---

## 5. Matrix

| Dim | `#` | `>` | `!` | `:` |
|---|---|---|---|---|
| IM picker / formatter rewrite risk (C4) | ✅ none | ✅ none in Feishu; quote-rendered in TG/Slack | ✅ none | ❌ emoji picker risk |
| Natural-text false positive (C3) | ✅ rare | ✅ rare | ❌ common ("!好的") | ⚠️ moderate (":时间") |
| Mobile keyboard cost (C2) | ✅ 1 key | ✅ 1 key | ✅ 1 key | ✅ 1 key |
| Cross-IM consistency (C1) | ✅ universal | ⚠️ TG/Slack quote conflict | ⚠️ visually exclamation | ❌ emoji conflict |
| Convention precedent | ✅ Slack/Discord/Twitter/IRC channels | ❌ no convention | ⚠️ Slack alerts | ❌ no convention |
| Visual distinctness | ✅ high | ⚠️ medium | ⚠️ medium | ❌ low |

---

## 6. Recommendation

**`#`** (D1-2 + D2-1).

Traceable evidence:

1. Matches every constraint C1-C4 in §5 — zero IM-layer rewrite, zero natural-text collision, mobile-easy, cross-IM safe.
2. Universal precedent (Slack / Discord / Twitter / IRC / GitHub issues) — zero learning curve.
3. `>` is the next-best but loses cross-IM consistency (TG/Slack render as quote).
4. `!` `:` `~` `*` all eliminated by §3/§4 (false positives, picker rewrites, markdown conflicts).

---

## 7. User decision (step 5 of DD process)

| Dimension | Recommendation | User decision |
|---|---|---|
| D1 (approach) | D1-2 — replace `@` with a different single-char prefix | ✅ accepted 2026-05-12 |
| D2 (which symbol) | D2-1 — `#` | ✅ accepted 2026-05-12 (user directive: `改成井号，彻底一点，全部改掉，不要保留其他的`) |
| Cutover | hard cutover, no compat / dual-syntax / escape | ✅ accepted 2026-05-12 |

DD is **LOCKED**.

---

## 8. Implementation

Single PR, no milestones (mechanical replacement):

- `packages/bridge/src/parser.ts`: `text.startsWith('@')` → `'#'`; `text[cursor] === '@'` → `'#'`; comments + JSDoc updated.
- `packages/bridge/src/matcher.ts`: comment references `@<query>` → `#<query>`. No regex changes (matcher operates on already-stripped names).
- `packages/bridge/src/router.ts`: all echo strings (`'❌ no current session — send \`@<name>\` first or \`/list\`'` etc.) → `#<name>`. Comment references.
- `packages/bridge/src/orchestrator.ts`: comment references.
- `packages/bridge/src/ai-router.ts`: prompt examples (`@frontend hello`) → `#frontend hello`. The PENDING block / D5-3 rule examples that reference the rigid syntax → updated.
- `packages/cli-cc/src/state-files.ts`: lifecycle comment that mentioned `@<tabname> /1` → `#<tabname> /1`.
- Tests: `parser.test.ts` + `router.test.ts` + `orchestrator.test.ts` — bulk replace `@<word>` strings used as test inputs / assertions.
- `README.md` + `README.zh-CN.md` — all examples.
- `docs/architecture.md` + `docs/dev.md` — references.
- `docs/conventions.md` — routing-syntax row + revision log entry for v1.8.

NOT touched:
- `@multi-cc-im/<package>` npm package names — these are scope names, unrelated to routing.
- Historical `@multi-cc-im /<cmd>` references in code comments — these describe v1.4 dead syntax already removed. Left as historical narrative.
- Existing DD docs that locked old syntax — left as historical record. This DD supersedes their §G' for the prefix character only.

## 9. Notes for future

If a future IM (Telegram, WeChat revival) DOES treat `#` specially (e.g., Telegram's clickable hashtag client rendering), the bot still receives raw text — clickable rendering is client-only, parser is unaffected.

If a future IM's `#` is rewritten (none known today), this DD reopens.
