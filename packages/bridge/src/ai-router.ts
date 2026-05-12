import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * AI-routed IM dispatch — daemon spawns an independent `claude --print`
 * subprocess to triage plain (no-mention) IM messages: decides which cc tab
 * the message should go to + extracts a clean task `intent` (stripped of
 * routing cue words like "前端那个" / "backend 的").
 *
 * Per [DD: AI-routed IM dispatch](../../../docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md).
 *
 * **Why spawn cc instead of using Anthropic SDK directly**: cc CLI default
 * OAuth login goes against the user's Claude.ai (Pro/Max) subscription. SDK
 * approaches require ANTHROPIC_API_KEY (per Anthropic's third-party policy)
 * which would force users to pay separately. multi-cc-im users all have
 * cc installed + logged in, so reusing that auth = zero extra cost.
 *
 * **Why per-message spawn (not long-lived)**: cc TUI is interactive and not
 * designed for daemon stdin/stdout integration; long-lived would require
 * PTY parsing + state-pollution mitigation + hang detection. `claude --print`
 * is one-shot by design — perfect fit for our triage call.
 *
 * **Latency**: ~2-3s per call (cc cold start + haiku inference). Acceptable
 * in IM context (user expects seconds not ms).
 */

const execFileAsync = promisify(execFile);

/**
 * One pending PreToolUse approval visible to the AI router. Caller maps
 * a `PendingPermissionRequest` from `@multi-cc-im/cli-cc` into this shape
 * by attaching the resolved tab title (the cli-cc record only carries
 * `paneId`/`sessionId` — the router prompt needs the user-facing name).
 *
 * Per [DD: natural-language permission reply](../../../docs/superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) §9.1 P2.
 */
export interface PendingRequestForPrompt {
  /** Tab title the request belongs to (matched on the user's IM reply). */
  tabName: string;
  /** Tool cc wants to call (e.g. `'Bash'`, `'Edit'`). Used as match-signal (D5-3). */
  toolName: string;
  /** cc's tool_input verbatim — the AI sees key substrings (rm / node_modules / a file path / URL) for match-signal evaluation. */
  toolInput: Record<string, unknown>;
}

/**
 * AI-side resolution of a natural-language permission reply (DD §9.1 P2).
 * Populated only when the AI decides the user's IM message is a reply to
 * a pending PreToolUse — not a routing request.
 *
 * D5-3 asymmetric trust: AI is instructed (via prompt) to downgrade
 * `allow` → `deny` when the user's message lacks a content match-signal
 * (tool name / key argument substring / clear paraphrase). Deny is always
 * safe; allow needs evidence. Code-level enforcement of the same rule is
 * P3 router scope.
 */
export interface AIPermissionResponse {
  /** Tab the AI matched the reply to (must be one of the `pendingRequests[].tabName` values). */
  target: string;
  /** User's decision relayed verbatim from IM. */
  decision: 'allow' | 'deny';
  /** Short paraphrase the AI built from the user's reply; flows into cc as `permissionDecisionReason`. */
  reason: string;
}

export interface AIRoutingOpts {
  /** The IM message body (already with `#<tab>` prefix stripped if any — but caller should only invoke this for plain no-mention messages). */
  userMsg: string;
  /** Currently visible cc tab titles (filter out empty / un-/rename'd tabs before passing). */
  tabs: readonly string[];
  /** The last-explicitly-mentioned tab title, used as a context signal for pronoun resolution. */
  currentTab: string | null;
  /**
   * Pending PreToolUse prompts visible to the AI. Empty/undefined → no
   * permission section in the prompt + AI never fills `permissionResponse`.
   * Non-empty → AI may match the IM message to one of these instead of
   * treating it as a routing request (DD §9.1 P2).
   */
  pendingRequests?: readonly PendingRequestForPrompt[];
  /**
   * When `true`, render the prompt in **force-permission mode**: AI's job
   * is reduced from "decide routing vs permission" to "extract the
   * answer from a known-to-be-a-permission-reply message". Routing rules
   * (lenient tab matching / topic-mention / Rule 1-3) are stripped from
   * the prompt; OUTPUT spec mandates `permissionResponse` and forbids
   * top-level `target`/`intent`.
   *
   * Caller invariant (router-level): set to `true` whenever
   * `pendingRequests.length > 0`. cc protocol fact: while ANY
   * PreToolUse is pending, cc cannot accept new task prompts —
   * routing is moot. Per v1.10 force-permission DD (2026-05-12).
   */
  forcePermissionMode?: boolean;
  /**
   * Path to the `claude` CLI binary. Default: `'claude'` (resolved via PATH).
   * Tests override to a stub script for deterministic output.
   */
  claudeBinary?: string;
  /**
   * Model to spawn cc with. Default: `'claude-haiku-4-5'` (fast + cheap).
   * Override only for testing or if user wants higher-quality routing.
   */
  model?: string;
  /** Spawn timeout in ms. Default 15s. */
  timeoutMs?: number;
}

export interface AIRoutingResult {
  /** Tab title the AI selected, or null if the AI couldn't decide. */
  target: string | null;
  /**
   * The user's message stripped of routing cue words ("前端那个" / "backend 的"
   * etc.), ready to be sent to cc as a clean prompt. Null if the AI couldn't
   * extract a useful intent.
   */
  intent: string | null;
  /** Short (<15 char) reason from the AI; daemon log only, not user-facing. */
  reason: string | null;
  /**
   * Populated when the AI matches the user's IM message to a pending
   * PreToolUse (DD §9.1 P2). Null when no pending or AI decided it's a
   * routing request. Caller (router) routes on this field's presence.
   */
  permissionResponse: AIPermissionResponse | null;
}

/**
 * Default subprocess timeout. Bumped from 15s → 30s per user smoke
 * 2026-05-11: cc cold-start (≈2-5 s) + Haiku inference (≈2-10 s) + a
 * 10-tab routing prompt can easily push past 15 s on a slow network,
 * leading to SIGTERM-kill (exit 143) of an otherwise-valid request.
 * 30 s gives generous headroom; if it's still hitting timeout, the
 * reason text now distinguishes timeout from other exit modes.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_CLAUDE_BINARY = 'claude';

/**
 * Render the triage prompt by interpolating tabs / current / userMsg into
 * the locked template (per DD #73 §6.3).
 *
 * **Important**: do NOT mention cc slash commands or `/rename` in the
 * prompt — the spawned cc instance is itself a Claude Code agent that knows
 * about those, and naming them risks the agent treating the message as a
 * cc command rather than as a triage task.
 */
export function renderRoutingPrompt(opts: {
  userMsg: string;
  tabs: readonly string[];
  currentTab: string | null;
  pendingRequests?: readonly PendingRequestForPrompt[];
  forcePermissionMode?: boolean;
}): string {
  if (opts.forcePermissionMode) {
    return renderForcePermissionPrompt(opts);
  }

  const tabList = opts.tabs.length === 0
    ? '(no active tabs)'
    : opts.tabs.map((t) => `  - ${t}`).join('\n');

  const currentLine = opts.currentTab ?? 'none';

  const pendingBlock = renderPendingBlock(opts.pendingRequests);
  const outputSpec = pendingBlock === ''
    ? OUTPUT_SPEC_ROUTING_ONLY
    : OUTPUT_SPEC_WITH_PERMISSION;

  return `You are the IM routing assistant for multi-cc-im.

Product context:
multi-cc-im is a personal bridge — the user sends messages from an IM
(WeChat / Telegram / Lark/Feishu / etc.) and the daemon dispatches them
to the matching Claude Code (cc) session running locally. Each cc
session corresponds to one workflow context (frontend / backend /
testing / docs / etc.) and has a user-set semantic name — its wezterm
tab title.

Active Claude Code tabs:
${tabList}

current (the last tab the user explicitly #-mentioned; may or may not
be related to the current message):
${currentLine}

The user's current IM message:
"${opts.userMsg}"

You must produce two things:
1. Decide which tab is the best target for this message.
2. Extract the user's real intent — strip routing cue words
   (e.g. "the frontend one", "tell backend", "前端那个", "给后端")
   so what reaches cc is the pure task description, not the routing
   wrapper.

==================================================================
MATCHING RULES (in priority order)
==================================================================

Rule 1 — IF A TAB NAME APPEARS IN THE MESSAGE → PICK THAT TAB.

  "Appears" means literally appears in the message text. BOTH usages
  count, no exceptions:

    (a) As a route word:    "tell multi-cc-im to ..."
                            "#frontend please ..."
                            "跟 multi-cc-im 说xxx"

    (b) As a topic / subject word:
                            "multi-cc-im 已经合并了"      (PICK multi-cc-im)
                            "the multi-cc-im PR is done"  (PICK multi-cc-im)
                            "frontend bug 修好了"          (PICK frontend)

  Do NOT bail to "none" just because the tab name is used as a topic
  word. A topic mention is still a routing signal — the user is
  talking about that tab's domain, so route there.

  Matching must be LENIENT (mirrors the deterministic fallback the
  daemon runs after you):

    - Case-insensitive — "multi-cc-IM" matches "multi-cc-im"
    - Ignore whitespace / hyphens / underscores —
      "multi cc im" / "multiccim" / "multi_cc_im" all match
      "multi-cc-im"
    - Tolerate speech-to-text typos — "CRM" / "I'm" / "Aim" may all
      be typos of "IM"; "front and" may be typo of "frontend"
    - Tolerate Chinese-English code mixing — "frontend那个" / "给后端"
      / "那个 api" / "Multiccrm" (voice-typo for multi-cc-im)

  If you find ANY tab-name match (lenient), PICK that tab. Defaulting
  to "none" is a routing failure — the daemon falls back to a literal
  substring match in code afterward, so if you don't pick, you lose
  the chance to also strip routing cue words from intent.

Rule 2 — PRONOUN CONTINUES PREVIOUS CONTEXT → PICK current.

  When the user uses a pronoun like "it" / "that" / "those" / "它" /
  "这个" / "那个" without naming a tab, route to \`current\` (when
  non-null). The previous tab the user #-mentioned is the most likely
  referent.

Rule 3 — TRULY UNROUTABLE → "none".

  Only fall back to "none" when BOTH:
    (a) No tab name appears in any form after lenient matching, AND
    (b) The message doesn't continue prior context via pronouns.

  If you are tempted to bail because the message is "long" or "looks
  like a description", re-check Rule 1 — most messages contain enough
  signal.
${pendingBlock}
==================================================================
OUTPUT
==================================================================

Pick EXACTLY ONE target. Multiple targets are forbidden. If several
tabs are plausibly mentioned, pick the one the message is most about
(usually the one whose name appears first or is most specific).

CRITICAL: The "intent" field MUST be written in the **same language**
as the user's IM message:
  - User message in Chinese → intent in Chinese
  - User message in English → intent in English
  - Mixed Chinese-English ("frontend那个搞一下") → keep the natural mix
Do NOT translate the user's message into another language. The intent
is forwarded verbatim into the target cc tab; mismatched language
forces cc to mentally translate before doing the actual task.

Output JSON, no markdown wrapping:
${outputSpec}`;
}

const OUTPUT_SPEC_ROUTING_ONLY = `{
  "target": "<exact tab name from the active list above>" | "none",
  "intent": "<task description with routing cues stripped, in the user's source language>" | null,
  "reason": "<short internal explanation, ≤15 words — used for debugging>"
}`;

const OUTPUT_SPEC_WITH_PERMISSION = `{
  "target": "<exact tab name from the active list above>" | "none",
  "intent": "<task description with routing cues stripped, in the user's source language>" | null,
  "reason": "<short internal explanation, ≤15 words — used for debugging>",
  "permissionResponse": {
    "target": "<exact tab name from the PENDING list above>",
    "decision": "allow" | "deny",
    "reason": "<short paraphrase of the user's reply, in the user's source language>"
  } | null
}

Set "permissionResponse" only when the user's message is a reply to a
PENDING request. In that case set top-level "target" and "intent" to
null — a permission reply does not also route a new task. Otherwise
set "permissionResponse" to null and route normally.`;

/**
 * Render the optional "PENDING TOOL PERMISSION REQUESTS" section.
 *
 * Per DD §9.1 P2 (2026-05-11). The block lists each pending PreToolUse,
 * spells out the **D5-3 asymmetric trust rule** (allow needs a content
 * match-signal; deny is always safe), and tells the AI to set the
 * `permissionResponse` output field instead of routing when the user's
 * message is a natural-language reply ("multi-cc-im 那个我同意" /
 * "deny the bash one").
 *
 * Returns `''` (so the rendered prompt is identical to the routing-only
 * variant) when `pendingRequests` is missing or empty — the block must
 * not appear when there's nothing to approve, otherwise the AI is
 * primed to look for "permission reply" semantics in plain task
 * messages.
 */
/**
 * Force-permission prompt variant (v1.10, 2026-05-12). When the daemon
 * detects ANY pending PreToolUse PermissionRequest at the moment of
 * routing, the user's plain IM message CAN ONLY be a permission reply —
 * cc's tool protocol won't accept a new task prompt while a tool call
 * is mid-execution (PreToolUse blocks the cc turn). So routing is moot.
 *
 * This prompt is the deterministic counterpart: strip all routing-vs-
 * permission decision logic, give the AI a focused job:
 *
 *   1. Identify which pending the message answers (target → tab name)
 *   2. Apply the appropriate extraction rule:
 *      - Regular tool (Bash / Edit / etc.) → ASYMMETRIC TRUST D5-3
 *      - AskUserQuestion → option-label match or free-text passthrough
 *   3. Output `permissionResponse` (top-level target/intent forbidden)
 *
 * Why a separate prompt body instead of conditional sections: stripping
 * routing rules unconditionally makes the AI's path through the prompt
 * shorter, reducing both inference latency AND ambiguity. The v1.7/v1.9
 * prompt's routing rules ("Rule 1: if a tab name appears, PICK") were
 * winning over permission-reply intent when the user's IM reply
 * contained a tab name (real smoke 2026-05-12: "跟 multi-cc-im 说 瘦身吧"
 * got routed instead of treated as an AskUserQuestion answer). The fix
 * is structural — at this point we KNOW the reply is a permission
 * answer, so don't pretend the AI has a choice.
 */
function renderForcePermissionPrompt(opts: {
  userMsg: string;
  tabs: readonly string[];
  currentTab: string | null;
  pendingRequests?: readonly PendingRequestForPrompt[];
}): string {
  const tabList =
    opts.tabs.length === 0
      ? '(no active tabs)'
      : opts.tabs.map((t) => `  - ${t}`).join('\n');
  const currentLine = opts.currentTab ?? 'none';
  // The pending block is reused as-is — it carries the AskUserQuestion
  // SPECIAL RULE + ASYMMETRIC TRUST (D5-3) for regular tools. Both stay
  // relevant in force mode; only routing rules get stripped.
  const pendingBlock = renderPendingBlock(opts.pendingRequests);

  return `You are the IM permission-reply extractor for multi-cc-im.

==================================================================
FORCE PERMISSION MODE
==================================================================

The user's current IM message MUST be a reply to one of the pending
PreToolUse calls below. cc's protocol does not accept new task prompts
while a tool call is mid-execution, so the daemon knows for certain
this is a permission reply — your only job is to extract the answer.

Active Claude Code tabs (for context — DO NOT route to them):
${tabList}

current (last #-mentioned tab; informational, NOT a routing target):
${currentLine}

The user's current IM message:
"${opts.userMsg}"
${pendingBlock}
==================================================================
OUTPUT
==================================================================

You MUST fill \`permissionResponse\`. Top-level \`target\` / \`intent\` are
ALWAYS null in this mode — there is no routing decision to make.

Output JSON, no markdown wrapping:
${OUTPUT_SPEC_FORCE_PERMISSION}`;
}

const OUTPUT_SPEC_FORCE_PERMISSION = `{
  "target": null,
  "intent": null,
  "reason": "<short internal explanation, ≤15 words — used for debugging>",
  "permissionResponse": {
    "target": "<exact tab name from the PENDING list above>",
    "decision": "allow" | "deny",
    "reason": "<picked option's exact label OR user's verbatim free text OR allow/deny paraphrase per tool's SPECIAL RULE>"
  }
}

\`permissionResponse\` is REQUIRED in this mode — do NOT output \`null\`.
If no pending entry plausibly matches the user's message, still emit
\`permissionResponse\` with the best-guess pending's target and
\`decision: "deny"\` + \`reason: "<user's verbatim message>"\` — the user
can re-issue if mismatched, never silently drop.`;

function renderPendingBlock(
  pendingRequests: readonly PendingRequestForPrompt[] | undefined,
): string {
  if (!pendingRequests || pendingRequests.length === 0) return '';

  const bullets = pendingRequests
    .map((p) =>
      p.toolName === 'AskUserQuestion'
        ? formatAskUserQuestionPendingBullet(p)
        : formatRegularPendingBullet(p),
    )
    .join('\n\n');

  // The "SPECIAL RULE for AskUserQuestion" sub-section only fires when at
  // least one AskUserQuestion entry is present — keeps the prompt lean
  // for the common case (Bash/Edit-only pendings) and avoids priming AI
  // for AskUserQuestion semantics that don't apply.
  const hasAskUserQuestion = pendingRequests.some(
    (p) => p.toolName === 'AskUserQuestion',
  );

  return `
==================================================================
PENDING TOOL PERMISSION REQUESTS
==================================================================

These cc tool calls are waiting for an IM-side reply:

${bullets}

If the user's current IM message is a natural-language reply to one of
these (e.g. "multi-cc-im 那个我同意", "node 的拒绝", "deny the rm one",
"1", "I pick Postgres", "我选第二个"), fill the OUTPUT
\`permissionResponse\` field instead of routing.

ASYMMETRIC TRUST RULE (D5-3) — applies to "allow" only:

  Output decision="allow" ONLY when the user's message contains a
  CONTENT MATCH-SIGNAL — at least one of:

    (a) The tool name explicitly ("Bash" / "Edit" / "WebFetch" / etc.)
    (b) A substring of a key tool-input argument
        (e.g. "rm" / "node_modules" / a filename / a URL fragment)
    (c) A clear paraphrase of the operation
        (e.g. "删除", "执行命令", "fetch the URL")

  WITHOUT a match-signal, downgrade allow → deny. A bare "yes" /
  "同意" could refer to any pending request — safe default is deny,
  the user can re-issue with content if they really meant allow.

  Deny is safe without a match-signal: deny does NOT require any
  match-signal because denying any pending prompt is always
  conservative. If the user's message reads as a refusal ("拒绝",
  "no", "stop", "取消"), set decision="deny" on the most likely
  target tab.

Multiple pending requests + ambiguous reply → degrade to deny on
the best-guess target (user can re-issue).
${hasAskUserQuestion ? ASK_USER_QUESTION_RULES : ''}`;
}

/**
 * Special prompt rules for AskUserQuestion entries — cc widget questions
 * use the deny+reason channel as the answer transport, NOT as an
 * allow/deny gate. Per [DD AskUserQuestion IM bridge §6 P4](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md).
 *
 * Only appended to the prompt when at least one AskUserQuestion entry
 * is in \`pendingRequests\` — keeps the prompt lean otherwise.
 */
const ASK_USER_QUESTION_RULES = `
SPECIAL RULE for AskUserQuestion (widget question) entries:

  These cc widget questions are NOT permission gates. The user's IM
  reply names one of the listed options (by number, by exact label,
  by paraphrase) OR provides free text. The output for an
  AskUserQuestion entry MUST be:

    permissionResponse: {
      target: "<tab name from the AskUserQuestion entry>",
      decision: "deny",          ← ALWAYS deny for AskUserQuestion
      reason: "<picked option's EXACT label OR user's verbatim free text>"
    }

  - If the user matched one of the listed options: reason = that
    option's EXACT label string from the list (clean — cc parses
    cleanly from the transcript). NOT the description, NOT a
    paraphrase — the literal label.
  - If the user's reply doesn't clearly match any option: reason =
    the user's verbatim message (cleaned of routing prefix like
    "#<tab>"). Pass through unchanged so cc gets the raw text.
  - decision MUST always be "deny" for AskUserQuestion entries. The
    cc-side hook interprets deny+reason as the user's answer;
    "allow" would let cc proceed with the tool with no answer in
    transcript (broken).

  The ASYMMETRIC TRUST RULE (D5-3) above applies ONLY to regular tool
  permission entries — AskUserQuestion is exempt. There is no "allow"
  for AskUserQuestion that could be downgraded, so the rule is moot.
`;

/**
 * Render a regular tool permission pending entry — one line, compact.
 * Pre-existing format from DD v1.7 P2.
 */
function formatRegularPendingBullet(p: PendingRequestForPrompt): string {
  const inputStr = formatToolInputForPrompt(p.toolInput);
  return `  - tab=${p.tabName}  tool=${p.toolName}  input=${inputStr}`;
}

/**
 * Render an AskUserQuestion pending entry — multi-line with the question
 * text + each option's label + (optional) description. Per [DD AskUserQuestion
 * IM bridge §6 P4](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md):
 * AI needs to see what the options are to map user's reply to one.
 *
 * Single-question rendering: first \`questions[0]\` only. Multi-question is
 * rare; if questions.length > 1 the bullet emits a note pointing the user
 * to cc TUI for the rest. Mirrors orchestrator P3 IM-side behavior.
 *
 * Defensive on shape mismatch (missing/wrong \`questions\`): returns a
 * minimal bullet with a "malformed" placeholder so AI knows there's a
 * pending entry it can't fully parse but doesn't crash the prompt
 * rendering.
 */
function formatAskUserQuestionPendingBullet(
  p: PendingRequestForPrompt,
): string {
  const questionsRaw = p.toolInput.questions;
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) {
    return `  - tab=${p.tabName}  tool=AskUserQuestion  (malformed — no questions array; bail to cc TUI)`;
  }
  const first = questionsRaw[0] as {
    question?: unknown;
    options?: unknown;
  };
  const questionText =
    typeof first.question === 'string'
      ? first.question
      : '<question text missing>';
  const options = Array.isArray(first.options) ? first.options : [];

  const lines = [
    `  - tab=${p.tabName}  tool=AskUserQuestion`,
    `    question: "${questionText}"`,
    `    options:`,
  ];
  options.forEach((opt, i) => {
    const o = opt as { label?: unknown; description?: unknown };
    const label = typeof o.label === 'string' ? o.label : `option ${i + 1}`;
    const desc =
      typeof o.description === 'string' && o.description.length > 0
        ? ` — ${o.description}`
        : '';
    lines.push(`      ${i + 1}. ${label}${desc}`);
  });
  if (questionsRaw.length > 1) {
    lines.push(
      `    (cc asked ${questionsRaw.length} questions; only #1 shown — additional questions answered in cc TUI)`,
    );
  }
  return lines.join('\n');
}

/**
 * Stringify a tool_input record into a compact one-line representation
 * the LLM can use for the match-signal check (D5-3). We don't pretty-
 * print or quote-escape — the goal is "the AI can grep this for `rm` /
 * `node_modules` / a filename / a URL", not perfect round-trip JSON.
 *
 * Long values are truncated so a single pathological input doesn't
 * dominate the prompt. Truncation matters here because the prompt is
 * an LLM context window — see DD §6.4 for budget guidance.
 */
const TOOL_INPUT_VALUE_MAX = 200;
function formatToolInputForPrompt(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const valueStr = typeof v === 'string' ? v : JSON.stringify(v);
    const truncated =
      valueStr.length > TOOL_INPUT_VALUE_MAX
        ? `${valueStr.slice(0, TOOL_INPUT_VALUE_MAX)}…`
        : valueStr;
    parts.push(`${k}=${truncated}`);
  }
  return parts.length === 0 ? '{}' : parts.join(' ');
}

/**
 * Build the argv for the spawned `claude --print` call.
 *
 * Flags (per DD #73 §6.4):
 * - `--print`                    — headless one-shot (no TUI)
 * - `--model claude-haiku-4-5`   — fastest/cheapest model
 * - `--output-format json`       — structured cc envelope around our inner JSON
 * - `--permission-mode bypassPermissions` — no tool prompts (we don't call tools)
 * - `--disable-slash-commands`   — skip skills/commands loading
 * - `--setting-sources user`     — only ~/.claude/, skip project CLAUDE.md
 */
export function buildClaudeArgs(opts: { model: string; prompt: string }): string[] {
  return [
    '--print',
    '--model', opts.model,
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--disable-slash-commands',
    '--setting-sources', 'user',
    opts.prompt,
  ];
}

/**
 * Parse the cc `--output-format json` envelope to extract the inner LLM
 * output, then JSON-parse that to get our `{ target, intent, reason }`.
 *
 * cc envelope shape (from real cc output):
 *   { result: "<inner string>", session_id: "...", usage: {...}, ... }
 *
 * The inner string is supposed to be our JSON. Sometimes cc may wrap it
 * in markdown fences (` ```json ... ``` `) despite us asking for none — we
 * strip those defensively.
 */
export function parseRoutingOutput(stdout: string): AIRoutingResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return failure('cc envelope not JSON');
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('result' in envelope) ||
    typeof (envelope as { result: unknown }).result !== 'string'
  ) {
    return failure('cc envelope missing result');
  }
  let inner = (envelope as { result: string }).result.trim();

  // Strip markdown fence if present (despite prompt asking not to).
  if (inner.startsWith('```')) {
    const firstNewline = inner.indexOf('\n');
    if (firstNewline > 0) inner = inner.slice(firstNewline + 1);
    if (inner.endsWith('```')) inner = inner.slice(0, -3).trim();
    else if (inner.endsWith('```\n')) inner = inner.slice(0, -4).trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return failure('inner not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return failure('inner not object');
  }
  const obj = parsed as Record<string, unknown>;
  const targetRaw = obj.target;
  const intentRaw = obj.intent;
  const reasonRaw = obj.reason;

  const target =
    typeof targetRaw === 'string' && targetRaw !== 'none' && targetRaw.length > 0
      ? targetRaw
      : null;
  const intent =
    typeof intentRaw === 'string' && intentRaw.length > 0 ? intentRaw : null;
  const reason = typeof reasonRaw === 'string' ? reasonRaw : null;
  const permissionResponse = parsePermissionResponse(obj.permissionResponse);

  return { target, intent, reason, permissionResponse };
}

function failure(reason: string): AIRoutingResult {
  return { target: null, intent: null, reason, permissionResponse: null };
}

/**
 * Extract the optional `permissionResponse` field from the inner LLM JSON.
 * All three sub-fields are required for a valid response; any miss → null
 * (caller falls back to routing path). `decision` is strictly
 * `'allow'|'deny'` — anything else (typo, unexpected value) is treated as
 * "AI did not give us a usable response" rather than guessing.
 */
function parsePermissionResponse(raw: unknown): AIPermissionResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const target = obj.target;
  const decision = obj.decision;
  const reason = obj.reason;
  if (typeof target !== 'string' || target.length === 0) return null;
  if (decision !== 'allow' && decision !== 'deny') return null;
  if (typeof reason !== 'string') return null;
  return { target, decision, reason };
}

/**
 * Spawn `claude --print` to triage the IM message. Returns null target/intent
 * if the AI couldn't decide or anything went wrong (caller echoes
 * `❌ 无法识别` and asks user to fall back to `#<tab>`).
 *
 * Errors NEVER propagate up — every failure mode (timeout / non-zero exit /
 * malformed JSON / cc binary missing) returns a null result. The caller
 * sees the same outcome as a deliberate "none" from the AI.
 */
export async function routeViaAI(
  opts: AIRoutingOpts,
): Promise<AIRoutingResult> {
  const claudeBinary = opts.claudeBinary ?? DEFAULT_CLAUDE_BINARY;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const prompt = renderRoutingPrompt({
    userMsg: opts.userMsg,
    tabs: opts.tabs,
    currentTab: opts.currentTab,
    pendingRequests: opts.pendingRequests,
    forcePermissionMode: opts.forcePermissionMode,
  });
  const args = buildClaudeArgs({ model, prompt });

  // Strip WEZTERM_PANE before spawning cc. The hook receiver
  // (`packages/cli-cc/src/hook-receiver.ts:127`) gates on
  // `process.env.WEZTERM_PANE` to decide whether to write Stop files; if
  // the spawned cc inherits the daemon's WEZTERM_PANE, its Stop hook
  // writes a file that the daemon then forwards back to IM, leaking the
  // routing JSON envelope. Removing the var makes the hook silently exit
  // without writing anything, which is the correct behavior for a
  // headless triage subprocess.
  const childEnv = { ...process.env };
  delete childEnv.WEZTERM_PANE;

  let stdout: string;
  try {
    const result = await execFileAsync(claudeBinary, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB plenty for cc envelope
      env: childEnv,
    });
    stdout = result.stdout;
  } catch (err) {
    return {
      target: null,
      intent: null,
      reason: explainExecError(err, timeoutMs),
      permissionResponse: null,
    };
  }

  return parseRoutingOutput(stdout);
}

/**
 * Maximum length of a captured stderr line in the diagnostic reason
 * string. Long enough to see a one-line error, short enough not to
 * blow up the daemon log + IM echo (the reason eventually flows into
 * `[AI router]` stderr log via `aiTrace.reason`).
 */
const STDERR_SNIPPET_MAX = 80;

/**
 * Decode a `child_process.execFile` rejection into a human-readable
 * reason string covering all failure modes we care about diagnostically:
 *
 *  - `ENOENT`         → cc binary missing from PATH
 *  - timeout          → Node's execFile sent SIGTERM after `timeoutMs`
 *                       elapsed. Detected via `killed=true`, `signal`
 *                       matching SIGTERM/SIGKILL, or legacy ETIMEDOUT.
 *                       Returns "cc timeout after Nms" + stderr snippet.
 *  - numeric exit code → cc exited with non-zero (e.g. 1 for command
 *                       error). Returns "cc exited code=N signal=S
 *                       stderr=\"...\"".
 *  - everything else  → "cc exec failed: <code|unknown>" + signal +
 *                       stderr snippet.
 *
 * Per user smoke 2026-05-11: the previous "cc exec failed: 143" message
 * obscured the fact that SIGTERM-killed (exit 128+15=143) processes are
 * almost always Node's timeout firing. This helper makes timeout
 * detection explicit + includes stderr so the user can see cc's actual
 * complaint if any.
 */
export function explainExecError(err: unknown, timeoutMs: number): string {
  const e = err as Error & {
    code?: unknown;
    signal?: string | null;
    killed?: boolean;
    stderr?: Buffer | string;
  };
  const stderrText =
    typeof e.stderr === 'string'
      ? e.stderr
      : Buffer.isBuffer(e.stderr)
        ? e.stderr.toString('utf-8')
        : '';
  const stderrFirstLine = stderrText.split('\n')[0]?.trim() ?? '';
  const stderrSuffix = stderrFirstLine
    ? ` stderr="${stderrFirstLine.slice(0, STDERR_SNIPPET_MAX)}"`
    : '';

  // ENOENT — cc binary not in PATH (fail-fast, no signal / stderr).
  if (e.code === 'ENOENT') {
    return 'cc not in PATH';
  }

  // Timeout — Node fires SIGTERM on timeout, sets `killed=true`. Some
  // Node versions set `code = 'ETIMEDOUT'` (string); newer versions
  // leave `code` as the post-SIGTERM exit code (number 143). Detect
  // any of the three signals.
  const isTimeout =
    e.killed === true ||
    e.code === 'ETIMEDOUT' ||
    e.signal === 'SIGTERM' ||
    e.signal === 'SIGKILL';
  if (isTimeout) {
    const sigSuffix = e.signal ? ` signal=${e.signal}` : '';
    return `cc timeout after ${timeoutMs}ms${sigSuffix}${stderrSuffix}`;
  }

  // Numeric exit code — cc ran but exited non-zero.
  if (typeof e.code === 'number') {
    const sigSuffix = e.signal ? ` signal=${e.signal}` : '';
    return `cc exited code=${e.code}${sigSuffix}${stderrSuffix}`;
  }

  // Everything else — unknown shape, surface what we have.
  const codeRepr = e.code != null ? String(e.code) : 'unknown';
  const sigSuffix = e.signal ? ` signal=${e.signal}` : '';
  return `cc exec failed: ${codeRepr}${sigSuffix}${stderrSuffix}`;
}
