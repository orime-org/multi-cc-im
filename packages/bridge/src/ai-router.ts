import { spawn } from 'node:child_process';
import {
  AskUserQuestionAIOutputSchema,
  PermissionDialogAIOutputSchema,
  type AskUserQuestionAnswerEntry,
  type AskUserQuestionItem,
  type PermissionDialogAnswer,
} from '@multi-cc-im/shared';

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
 * **Latency**: ~3-6s per call (cc cold start + Sonnet 4.6 inference).
 * Slower than Haiku 4.5 (~2-3s) — trade-off accepted per 2026-05-13:
 * Haiku was fragile on complex multi-sentence + multi-topic messages
 * (failed to strip routing cues / rewrite 3rd-person pronouns); Sonnet
 * 4.6's stronger instruction-following is worth the extra 1-3s.
 * Acceptable in IM context (user expects seconds not ms).
 */

/**
 * Spawn `claude --print` with prompt passed via argv (NOT stdin), then
 * immediately close stdin so cc receives EOF and proceeds to process argv.
 *
 * **Why not `execFileAsync`** (regression discovered 2026-05-16, daemon.log):
 * Node's `execFile`/`execFileAsync` leaves the child's stdin as an
 * **open pipe** by default — the parent never writes, never ends. cc
 * 2.1.141 `--print` mode probes stdin and waits for EOF (presumably to
 * support `echo "..." | claude --print` for additional context). With
 * stdin pipe open and no data, cc waits up to its own timeout, then
 * Node's `timeout` option fires SIGTERM at `timeoutMs`. Result: 100%
 * `AI router target=none reason="cc timeout after 30000ms / Warning:
 * no stdin data rec…" fallback=substring` in production, AI routing
 * effectively dead, daemon silently fell back to substring matching.
 *
 * **Fix**: spawn + `child.stdin.end()` immediately signals EOF; cc
 * then proceeds to use the argv prompt without waiting.
 *
 * Memory references: `feedback_execfile_input_footgun.md` (use spawn +
 * `stdin.end()` for stdin-reading children) + `feedback_node_spawn_stdin_epipe.md`
 * (`stdin.on('error', () => {})` to swallow EPIPE if the child closes
 * its read side before we end the write side).
 *
 * **Rejection shape**: mirrors `child_process.execFile` rejection
 * (`code` / `signal` / `killed` / `stderr`) so `explainExecError`
 * (which classifies failures as ENOENT / timeout / non-zero exit / etc.)
 * works unchanged against the new error.
 */
function runClaudeArgvOnly(opts: {
  binary: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, [...opts.args], { env: opts.env });

    // Close stdin **immediately** — see function JSDoc for cc 2.1.141
    // `--print` behavior. swallow EPIPE/ECONNRESET on the write side in
    // case cc has already closed its read side by the time we end.
    child.stdin.on('error', () => {
      /* intentional swallow per feedback_node_spawn_stdin_epipe.md */
    });
    child.stdin.end();

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const wrapped = Object.assign(err, {
        stdout: stdoutBuf,
        stderr: stderrBuf,
      });
      reject(wrapped);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve({ stdout: stdoutBuf });
        return;
      }
      const err = new Error(
        `Command failed: ${opts.binary} ${opts.args.join(' ')}`,
      ) as Error & {
        code?: number | null;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      err.code = code;
      err.signal = signal;
      err.killed = timedOut;
      err.stdout = stdoutBuf;
      err.stderr = stderrBuf;
      reject(err);
    });
  });
}

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
   * Model to spawn cc with. Default: `'claude-sonnet-4-6'` (per 2026-05-13
   * swap from Haiku 4.5 — Haiku misread routing cues in complex
   * multi-sentence messages, Sonnet's instruction-following is the
   * trade-off worth the ~1-3s extra latency).
   * Override only for testing or if user wants different quality/latency.
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
 * 2026-05-11: cc cold-start (≈2-5 s) + Sonnet 4.6 inference (≈3-8 s,
 * up from Haiku's ≈2-10 s ceiling — Sonnet is slightly faster on
 * inference but slower on first-token; net latency similar) + a 10-tab
 * routing prompt can easily push past 15 s on a slow network, leading
 * to SIGTERM-kill (exit 143) of an otherwise-valid request. 30 s gives
 * generous headroom; if it's still hitting timeout, the reason text
 * now distinguishes timeout from other exit modes.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Default cc model used for IM-routing triage. Per 2026-05-13 swap:
 * Sonnet 4.6 replaces Haiku 4.5 because Haiku was fragile on complex
 * multi-sentence + multi-topic messages (failed to strip routing cues
 * / rewrite 3rd-person pronouns). Exported so tests can verify the
 * default without spawning the actual cc binary.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
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

  return `You are the IM dispatcher for multi-cc-im.

==================================================================
YOUR ROLE (read this first)
==================================================================

The user is talking TO YOU (the dispatcher) ABOUT what they want sent
to a Claude Code (cc) tab. Your output (the \`intent\` field) becomes
what gets forwarded into cc — so phrase it AS IF cc itself is the
reader, not as if you're describing the user's request to a 3rd party.

Concretely: the user says "你跟 X 说 …, 让他 …" — "你" is YOU, "他" is
cc. Strip "你" routing cues, rewrite "他" (3rd-person about cc) into
"你" / direct 2nd-person addressed AT cc.

Product context:
multi-cc-im is a personal bridge — the user sends messages from an IM
(WeChat / Telegram / Lark/Feishu / etc.) and the daemon dispatches them
to the matching cc session running locally. Each cc session corresponds
to one workflow context (frontend / backend / testing / docs / etc.)
and has a user-set semantic name — its wezterm tab title.

Active Claude Code tabs:
${tabList}

current (the last tab the user explicitly #-mentioned; may or may not
be related to the current message):
${currentLine}

The user's current IM message:
"${opts.userMsg}"

You must produce two things:
1. Decide which tab is the best target for this message.
2. Extract the user's intent — see INTENT EXTRACTION below.

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
      "breatic frontend" / "breatic-frontend" both match "breatic_frontend"
      "work temp" matches "work_temp"
    - Tolerate Chinese-English code mixing — "frontend那个" / "给后端"
      / "那个 api"
    - Tolerate speech-to-text (STT) typos — BE AGGRESSIVE with phonetic
      matching. The user's IM message often comes from voice input,
      and STT systems regularly mishear tab names. If a message string
      is at most ≤2 character substitutions/insertions/deletions away
      from a tab name (within similar length), TREAT IT AS A MATCH and
      pick that tab. Do NOT bail to "none" over single-character STT
      noise. Examples of mishearings cc tab names regularly suffer:

        "Multi-CCRM" / "Multi-CRM" / "Multi CCM" / "Multiccrm"
          → multi-cc-im   (STT hears "cc-im" as "CRM" / "CCM" / "CRN")
        "CRM" / "I'm" / "Aim" / "IBM"
          → IM            (1-char distance, "I + M" mishears)
        "no.js" / "nojs" / "knowed" / "nord"
          → node
        "front and" / "frunt end" / "frantend"
          → frontend
        "work tamp" / "walk temp" / "work tab"
          → work_temp
        "brattic" / "Britain" / "breatic" with typos
          → breatic

      The phonetic-match rule beats the strict "literal substring"
      check the deterministic fallback runs after you. If you don't
      pick on STT typos, no later layer recovers them — the user just
      sees "无法识别目标" and has to retype with #<tab>.

  TIE-BREAK — MOST-SPECIFIC TAB WINS when several candidates match:

    If two or more tab names lenient-match the message, AND one is a
    "more specific" version of the other (longer name / nested within
    the longer one after normalization), PICK THE MORE SPECIFIC one.

      Tabs:    "breatic" / "breatic_frontend" / "breatic_bugs"
      Message: "你跟 breatic frontend 说 ..."
      → PICK "breatic_frontend" (not "breatic"; the message names the
        more specific tab).

      Tabs:    "node" / "node_test"
      Message: "node test 跑挂了"
      → PICK "node_test".

    Only fall back to "none" via Rule 3 when matches are NOT in a
    nested relation (e.g. both "frontend" and "backend" literally
    appear with no specificity ordering).

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

==================================================================
INTENT EXTRACTION (3-part split — read carefully)
==================================================================

Split the user's message into 3 categories and handle each:

(1) ROUTING CUES — words addressing YOU about WHICH tab:
    "你跟 X 说" / "tell backend" / "frontend那个" / "给后端"
    → STRIP. They never reach cc.

(2) TASK BODY — what cc should actually do:
    "重构 auth 模块" / "fix the bug in foo.ts"
    → KEEP, BUT REWRITE 3rd-person about cc → 2nd-person addressed AT cc:
      "让他 X"       → "请你 X" (or just "X")
      "his code"     → "your code"
      "cc 应该 Y"    → "请 Y"
      "tell him to Z" → "Z"

(3) META-INSTRUCTIONS — directives addressed to YOU about HOW cc should
    approach the task (not part of the task itself):
    "让他先出计划" / "用 TDD" / "先 review 再改" / "出 plan 不实施"
    "make sure he plans first" / "have it run tests after"
    → REWRITE as 2nd-person directives addressed TO cc, append after
      the task body, connected with a period or comma.

------------------------------------------------------------------
Example A (meta-instruction handling — Chinese):
  User:   "你跟 backend 说重构 auth 模块，让他先出计划"
  Split:  routing="你跟 backend 说"
          body="重构 auth 模块"
          meta="让他先出计划" → "请先出计划，不要直接实施"
  intent: "重构 auth 模块。请先出计划，不要直接实施。"
  target: "backend"

Example B (real case 2026-05-12):
  User:   "你跟 work temp 说写一个项目本地的 stop hook 测试。
           如果 token 占用 20% 就开始调用 neat-freak。让他先出计划"
  Split:  routing="你跟 work temp 说"
          body="写一个项目本地的 stop hook 测试。如果 token 占用 20%
                就开始调用 neat-freak"
          meta="让他先出计划" → "请先出计划，不要直接实施"
  intent: "写一个项目本地的 stop hook 测试。如果 token 占用 20% 就开始
           调用 neat-freak。请先出计划，不要直接实施。"
  target: "work_temp"

Example C (meta-instruction handling — English):
  User:   "tell frontend to add a login page, make him plan first"
  Split:  routing="tell frontend to"
          body="add a login page"
          meta="make him plan first" → "please plan first, don't
                implement directly"
  intent: "Add a login page. Please plan first, don't implement directly."
  target: "frontend"

Example D (no meta-instructions — passthrough with pronoun rewrite):
  User:   "让 backend 把那个旧的 cache 清一下，他自己决定怎么清"
  Split:  routing="让 backend"
          body="把那个旧的 cache 清一下"
          meta="他自己决定怎么清" → "你自己决定怎么清"
  intent: "把那个旧的 cache 清一下，你自己决定怎么清。"
  target: "backend"

Example A.1 (degenerate-short body — real case 2026-05-15):
  User:   "你跟 multi-ccim 说合并了"
  Split:  routing="你跟 multi-ccim 说" (含 STT typo "multi-ccim" → multi-cc-im
                                       via phonetic-match)
          body="合并了"
          (no meta)
  intent: "合并了"
  target: "multi-cc-im"

  KEY POINT: even when the body after stripping is **only 1-3 words**
  ("合并了" / "OK" / "done" / "ready" / "已经好了"), DO NOT keep the
  routing prefix. The short body IS the entire task body — that's the
  natural form of "I'm informing X that <short event>". The cc on the
  other end never sees this prompt, never knows the user said "你跟
  X 说", and would be confused to see a 2nd-person prefix addressing
  YOU (the dispatcher) rather than itself.

  WRONG: intent="你跟 multi-ccim 说合并了"  (verbatim — leaks dispatcher reference)
  RIGHT: intent="合并了"                     (cc reads "merged.", makes sense)

Example E (real case 2026-05-13 — multi-sentence with discourse marker
"那" + 3rd-person pronoun mid-body):
  User:   "那你跟 work temp 说，那个文件位置就不用动了，那个原理我都
           清楚了。然后现在来讲的话，就是已经改完了吧？他改完的话，
           然后怎么测试？"
  Split:  routing="那你跟 work temp 说" (含 conversational marker "那"; STRIP)
          body="那个文件位置就不用动了，那个原理我都清楚了。然后现在来
                讲的话，就是已经改完了吧？他改完的话，然后怎么测试？"
          pronoun rewrite: "他改完的话" → "你改完的话"
          (no separable meta — every sentence is task content)
  intent: "那个文件位置就不用动了，那个原理我都清楚了。然后现在来讲的
           话，就是已经改完了吧？你改完的话，然后怎么测试？"
  target: "work_temp"

  KEY POINT: even when the message is 4 sentences across multiple
  topics, the routing-cue strip + 3rd→2nd pronoun rewrite STILL apply.
  Conversational starters like "那" / "OK" / "好" / "那么" / "Then" /
  "So" before the routing cue are part of the routing cue — STRIP
  them too.
------------------------------------------------------------------

LENGTH IS NOT AN EXCUSE — even if the message is 4+ sentences or
contains multiple topics, you MUST still:
  (a) strip the routing cue at the start (incl. conversational
      starters like "那" / "OK" / "好" / "那么" / "Then" / "So")
  (b) rewrite 3rd-person pronouns about cc into 2nd-person
      addressed AT cc

Do NOT pass the user's verbatim message through just because it's
long or complex — the routing cue and pronoun rewrites apply
regardless of message length.

BREVITY IS NOT AN EXCUSE EITHER — even if the body after stripping
is only 1-3 words ("合并了" / "done" / "OK" / "已经好了" / "fixed"),
DO NOT keep the routing prefix to "pad it out". The short body is
the natural form of "informing X that <short event>" — cc receiving
just "合并了" is the correct outcome. If you find yourself thinking
"the body looks too short, maybe the user wanted the prefix
forwarded too" — that's the failure mode this rule prevents. STRIP
and emit.

If you cannot distinguish (2) from (3), default to keeping the segment
as TASK BODY — extra wording is better than dropped intent. Likewise if
you cannot detect any meta-instruction, just rewrite (2) and emit it
verbatim with 3rd-person pronouns converted.
${pendingBlock}
==================================================================
OUTPUT VERIFICATION (run this mental check BEFORE emitting JSON)
==================================================================

Before you return, re-read your \`intent\` field and ask:

  Does my intent contain ANY of these dispatcher-addressing patterns?
    - "你跟 X 说" / "你和 X 说" / "告诉 X" / "让 X" / "跟 X 说"
    - "tell X" / "ask X" / "have X" / "make X" / "let X"
    - any "你" / "you" that refers to ME (the dispatcher) rather than cc
    - any 3rd-person reference to cc ("他" / "him" / "his" / "the AI" /
      "the agent" / "cc 应该" / "cc 会")

  If YES — that's a BUG. The cc on the other end NEVER sees this prompt,
  NEVER knows you exist as a separate agent, NEVER knows the user said
  "你跟 X 说". cc will see your \`intent\` LITERALLY. Strip aggressively
  and re-emit. The 2nd-person "你" in your intent (if any) MUST refer to
  cc itself, not to you.

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
  "intent": "<task body + rewritten meta-instructions (see INTENT EXTRACTION), in the user's source language; routing cues stripped, 3rd-person pronouns about cc rewritten to 2nd-person addressed AT cc>" | null,
  "reason": "<short internal explanation, ≤15 words — used for debugging>"
}`;

const OUTPUT_SPEC_WITH_PERMISSION = `{
  "target": "<exact tab name from the active list above>" | "none",
  "intent": "<task body + rewritten meta-instructions (see INTENT EXTRACTION), in the user's source language; routing cues stripped, 3rd-person pronouns about cc rewritten to 2nd-person addressed AT cc>" | null,
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

  // Router filters AskUserQuestion pendings out of this list before
  // dispatching to the routing / force-permission prompt — AUQ has a
  // separate AI path (`renderAskUserQuestionPrompt`) with a structured
  // answers schema. Everything reaching here is a regular tool (Bash /
  // Edit / WebFetch / etc.) permission request.
  const bullets = pendingRequests
    .map((p) => formatRegularPendingBullet(p))
    .join('\n\n');

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
`;
}

/**
 * Render a regular tool permission pending entry — one line, compact.
 * Pre-existing format from DD v1.7 P2.
 */
function formatRegularPendingBullet(p: PendingRequestForPrompt): string {
  const inputStr = formatToolInputForPrompt(p.toolInput);
  return `  - tab=${p.tabName}  tool=${p.toolName}  input=${inputStr}`;
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
 * - `--model claude-sonnet-4-6`  — Sonnet 4.6 for robust instruction-following
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
    const result = await runClaudeArgvOnly({
      binary: claudeBinary,
      args,
      env: childEnv,
      timeoutMs,
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

// ============================================================================
// AskUserQuestion AI path (DD §9 — D5-D allow + updatedInput.answers)
//
// AUQ has its own AI prompt + parser independent of the routing /
// force-permission path. Router dispatches to it when pending contains
// any AskUserQuestion entry — output is `AskUserQuestionAnswerSchema`
// (per-question option index or free text), which the daemon then
// resolves to a `{questions, answers}` map via `toolInput.questions[i]
// .options[j-1].label`.
// ============================================================================

/**
 * One pending AskUserQuestion visible to the AI router. Caller (router)
 * resolves `paneId → tab title` and passes the full `questions[]` array
 * verbatim from the PreToolUse Request file (so the AI sees the same
 * question text + option labels the user saw in IM).
 */
export interface PendingAskUserQuestion {
  /** Tab title — used both for prompt clarity and the AI's `target` output. */
  tabName: string;
  /** Verbatim `tool_input.questions[]` (validated by AskUserQuestionToolInputSchema upstream). */
  questions: readonly AskUserQuestionItem[];
}

/**
 * Resolved AI answer for one AUQ request. The router maps `answers` into
 * cc's `updatedInput.answers` record (key = `questions[i].question`, value
 * = option label string OR free text OR joined multi-select labels).
 */
export interface AIAskUserQuestionResult {
  /** Matched tab (must be one of the input `pendings[].tabName`). */
  target: string;
  /** Short trace explanation (≤15 words) — daemon log + IM echo. */
  reason: string | null;
  /** Per-question answer entries (validated by AskUserQuestionAnswerSchema). */
  answers: readonly AskUserQuestionAnswerEntry[];
}

/**
 * Render the AskUserQuestion-only AI prompt. AUQ has a different output
 * shape than the routing / force-permission prompts (structured per-
 * question answers, no allow/deny), so it lives in its own prompt path
 * to keep the model's job focused.
 *
 * Per [DD §9.3](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md#93-d5-d-protocol-shape):
 * each `answers[]` entry is either
 *   `{questionIndex, kind:'option', optionIndex}` (1-based, single or array)
 * or
 *   `{questionIndex, kind:'text', text}` (free-text or "Other"-style reply).
 *
 * The AI is told to prefer `option` when the user's IM message clearly
 * matches one of the listed labels (by number, exact label, paraphrase);
 * fall back to `text` for free-form / "your thoughts" answers.
 */
export function renderAskUserQuestionPrompt(opts: {
  userMsg: string;
  pendings: readonly PendingAskUserQuestion[];
}): string {
  const pendingBlock = renderAskUserQuestionPendings(opts.pendings);

  return `You are the IM AskUserQuestion-answer extractor for multi-cc-im.

==================================================================
ASK-USER-QUESTION MODE
==================================================================

cc has called the built-in \`AskUserQuestion\` tool — it asked the user
one or more multiple-choice questions and is waiting for the answer to
be injected back via the hook's \`updatedInput.answers\` field. Your
only job is to extract the user's answer(s) from the IM message below
in a structured form the daemon can convert into that injection.

The user's current IM message:
"${opts.userMsg}"
${pendingBlock}
==================================================================
ANSWER EXTRACTION RULES
==================================================================

For EACH question listed under the matched pending, produce one entry
in the OUTPUT \`answers\` array:

  - If the user's message clearly picks one of the listed options (by
    number, exact label match, or a clear paraphrase) → emit
    \`{questionIndex, kind:"option", optionIndex}\` where \`optionIndex\`
    is 1-based. For multiSelect=true questions when the user picks
    multiple, \`optionIndex\` is an array (e.g. \`[1, 3]\`).
  - If the user wrote free text that doesn't map to any listed option
    (or chose the "your thoughts" / "Other" trailing option) → emit
    \`{questionIndex, kind:"text", text}\` where \`text\` is the user's
    verbatim message (cleaned of any \`#<tab>\` prefix, but otherwise
    unchanged — pass through, do NOT paraphrase).

Constraints:

  - \`questionIndex\` is 0-based and refers to the question's position in
    the matched pending's listed questions.
  - You must produce one entry per question listed (one entry per
    \`questions[i]\`).
  - If multiple AUQ pendings are listed (rare — multiple cc tabs each
    asked at the same time), set \`target\` to the tab whose question(s)
    the user's message most plausibly answers. If truly ambiguous,
    pick the first listed pending.

==================================================================
OUTPUT
==================================================================

Output JSON, no markdown wrapping:
${OUTPUT_SPEC_ASK_USER_QUESTION}`;
}

const OUTPUT_SPEC_ASK_USER_QUESTION = `{
  "target": "<exact tab name from the listed AUQ pendings>",
  "reason": "<short internal explanation, ≤15 words — daemon log + IM echo>",
  "answers": [
    {
      "questionIndex": <0-based question index>,
      "kind": "option",
      "optionIndex": <1-based option index OR array for multi-select>
    }
    | {
      "questionIndex": <0-based question index>,
      "kind": "text",
      "text": "<user's verbatim answer text>"
    }
  ]
}`;

function renderAskUserQuestionPendings(
  pendings: readonly PendingAskUserQuestion[],
): string {
  if (pendings.length === 0) return '';
  const bullets = pendings
    .map((p) => {
      const lines: string[] = [`  - tab=${p.tabName}`];
      p.questions.forEach((q, qi) => {
        lines.push(
          `    question[${qi}]: "${q.question}"${q.multiSelect ? '  (multiSelect)' : ''}`,
        );
        q.options.forEach((opt, oi) => {
          const desc = opt.description.length > 0 ? ` — ${opt.description}` : '';
          lines.push(`      ${oi + 1}. ${opt.label}${desc}`);
        });
      });
      return lines.join('\n');
    })
    .join('\n\n');
  return `
==================================================================
PENDING AskUserQuestion REQUESTS
==================================================================

${bullets}
`;
}

/**
 * Parse the cc envelope output for an AskUserQuestion-mode call. Returns
 * `null` (with a diagnostic stub for the caller to log) on any failure
 * mode — caller treats null as "AI couldn't extract; fall back to a
 * default empty-answer write to keep cc unstuck".
 */
export function parseAskUserQuestionOutput(
  stdout: string,
): AIAskUserQuestionResult | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('result' in envelope) ||
    typeof (envelope as { result: unknown }).result !== 'string'
  ) {
    return null;
  }
  let inner = (envelope as { result: string }).result.trim();
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
    return null;
  }
  const validated = AskUserQuestionAIOutputSchema.safeParse(parsed);
  if (!validated.success) return null;
  return {
    target: validated.data.target,
    reason: validated.data.reason ?? null,
    answers: validated.data.answers,
  };
}

export interface AskUserQuestionViaAIOpts {
  userMsg: string;
  pendings: readonly PendingAskUserQuestion[];
  claudeBinary?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Spawn `claude --print` for AUQ extraction. Returns null on any failure
 * (timeout / non-zero exit / parse error) — caller writes a fallback
 * empty-answers PermissionResponse so cc doesn't stall.
 */
export async function routeAskUserQuestionViaAI(
  opts: AskUserQuestionViaAIOpts,
): Promise<AIAskUserQuestionResult | null> {
  const claudeBinary = opts.claudeBinary ?? DEFAULT_CLAUDE_BINARY;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const prompt = renderAskUserQuestionPrompt({
    userMsg: opts.userMsg,
    pendings: opts.pendings,
  });
  const args = buildClaudeArgs({ model, prompt });

  const childEnv = { ...process.env };
  delete childEnv.WEZTERM_PANE;

  let stdout: string;
  try {
    const result = await runClaudeArgvOnly({
      binary: claudeBinary,
      args,
      env: childEnv,
      timeoutMs,
    });
    stdout = result.stdout;
  } catch {
    return null;
  }

  return parseAskUserQuestionOutput(stdout);
}

// ============================================================================
// PermissionRequest hook event AI path
// (cc sensitive-path dialog reply triage — DD 2026-05-13 P6)
//
// When IMWork.auto=false and cc fires PermissionRequest hook, daemon
// forwards the dialog to IM with numbered options derived from cc's
// `permission_suggestions`. User replies free-form in IM; this AI path
// extracts the structured answer (single-yes / always-allow-suggestion-N
// / deny) which daemon then resolves into the on-disk Response file.
// ============================================================================

/**
 * One pending PermissionDialog visible to the AI router. Caller (router)
 * resolves `paneId → tab title` and renders the dialog's
 * `permission_suggestions` as numbered options.
 */
export interface PendingPermissionDialog {
  /** Tab title — used both for prompt clarity and the AI's `target` output. */
  tabName: string;
  /** cc tool that triggered the dialog (e.g. `'Bash'`, `'Edit'`). */
  toolName: string;
  /**
   * Best-effort path/command summary extracted by daemon (`file_path` /
   * `command` / etc.). Shown to AI so it can recognize "the .claude/
   * one" / "the rm one" in user's natural-language reply.
   */
  toolInputSummary: string;
  /**
   * cc's `permission_suggestions` array (PermissionUpdate objects).
   * Opaque — we rely on a best-effort `summarizePermissionSuggestion`
   * to give the AI a human-readable label per entry. The AI returns a
   * 1-based index back; daemon resolves into the actual cc payload.
   */
  permissionSuggestions: readonly unknown[];
}

export interface AIPermissionDialogResult {
  /** Matched tab (must be one of input `pendings[].tabName`). */
  target: string;
  /** Short trace explanation (≤15 words) — daemon log + IM echo. */
  reason: string | null;
  /** Structured answer per DD §3 D6. */
  answer: PermissionDialogAnswer;
}

/**
 * Best-effort summarize one PermissionUpdate entry from cc's
 * `permission_suggestions` for prompt rendering + IM display. cc's
 * actual shape (verified against cc 2.1.88 source):
 *
 *   {
 *     type: 'addRules',
 *     behavior: 'allow',
 *     destination: 'session',
 *     rules: [{toolName: 'Edit', ruleContent: 'Edit(./.claude/**)'}]
 *   }
 *
 * We extract the first rule's `ruleContent` if present; fall back to a
 * type/destination summary. Defensive on any shape mismatch (cc protocol
 * isn't version-stable per DD §2.5).
 */
export function summarizePermissionSuggestion(s: unknown): string {
  if (typeof s !== 'object' || s === null) return '<unknown suggestion>';
  const sug = s as Record<string, unknown>;
  if (Array.isArray(sug.rules) && sug.rules.length > 0) {
    const first = sug.rules[0];
    if (typeof first === 'object' && first !== null) {
      const rule = first as Record<string, unknown>;
      if (typeof rule.ruleContent === 'string' && rule.ruleContent.length > 0) {
        return rule.ruleContent;
      }
    }
  }
  const typeStr = typeof sug.type === 'string' ? sug.type : '?';
  const destStr =
    typeof sug.destination === 'string' ? sug.destination : '?';
  return `${typeStr}/${destStr}`;
}

/**
 * Render the PermissionRequest AI prompt. The AI's job is narrow:
 * map a free-text IM reply into the documented decision shape per
 * DD §3 D6 (single-yes / always-allow-suggestion-N / deny).
 */
export function renderPermissionRequestPrompt(opts: {
  userMsg: string;
  pendings: readonly PendingPermissionDialog[];
}): string {
  const pendingBlock = renderPermissionDialogPendings(opts.pendings);
  return `You are the IM PermissionRequest-answer extractor for multi-cc-im.

==================================================================
PERMISSION-REQUEST MODE
==================================================================

cc fired a permission dialog because it wants to edit a sensitive
path (e.g. \`.claude/* / .git/* / .env\` / etc.) — paths that cc's
internal safety gate forces an "ask" on regardless of any
user-level allow rule. The daemon forwarded the dialog to IM
verbatim with numbered options derived from cc's own
\`permission_suggestions\`. Your only job is to extract the user's
choice from the IM message below.

The user's current IM message:
"${opts.userMsg}"
${pendingBlock}
==================================================================
ANSWER EXTRACTION RULES (DD §3 D6)
==================================================================

Map the user's IM reply to ONE of these answer shapes:

1. SINGLE-YES (this call only, no session-wide rule):
   - Triggers: "1" / "yes" / "ok" / "好" / "同意" / "同意一次" /
     "allow once" / "for this time" / similar.
   - Output: \`{behavior: "allow"}\` — NO \`appliedSuggestionIndex\`.

2. ALWAYS-ALLOW-SUGGESTION-N (session rule from cc's list):
   - Triggers: user picks one of the numbered suggestions listed
     above by number ("2", "3"), label ("\`Edit(./.claude/**)\`"),
     or paraphrase ("总是允许" / "always allow" / "yes always" /
     "yes and remember").
   - Output: \`{behavior: "allow", appliedSuggestionIndex: <1-based
     index INTO the suggestions list>}\`. The index points into the
     "suggestions:" block under each pending entry. Daemon resolves
     it back to cc's opaque PermissionUpdate object.
   - **CRITICAL**: \`appliedSuggestionIndex\` MUST be ≥ 1 and ≤ the
     number of suggestions listed. Never invent a new index. Never
     fabricate a custom always-allow that wasn't in the list (per
     DD §3 D6-A).

3. DENY:
   - Triggers: "no" / "deny" / "拒绝" / "取消" / "stop" / similar.
   - Output: \`{behavior: "deny", message: <short paraphrase of why,
     in user's source language, ≤25 chars>}\`.

4. AMBIGUOUS reply → safe default = DENY with
   \`message: "<user's verbatim message>"\`. Daemon shows it to cc;
   user can re-issue from cc TUI.

==================================================================
OUTPUT
==================================================================

Output JSON, no markdown wrapping:
${OUTPUT_SPEC_PERMISSION_DIALOG}`;
}

const OUTPUT_SPEC_PERMISSION_DIALOG = `{
  "target": "<exact tab name from the listed pendings>",
  "reason": "<short internal explanation, ≤15 words — daemon log + IM echo>",
  "answer":
    {
      "behavior": "allow",
      "appliedSuggestionIndex": <1-based index into suggestions list, OR omit for single-yes>
    }
    OR
    {
      "behavior": "deny",
      "message": "<short user-facing explanation in source language>"
    }
}`;

function renderPermissionDialogPendings(
  pendings: readonly PendingPermissionDialog[],
): string {
  if (pendings.length === 0) return '';
  const bullets = pendings
    .map((p) => {
      const lines: string[] = [
        `  - tab=${p.tabName}`,
        `    tool=${p.toolName}`,
        `    target=${p.toolInputSummary}`,
        `    suggestions:`,
      ];
      p.permissionSuggestions.forEach((s, i) => {
        lines.push(`      ${i + 1}. ${summarizePermissionSuggestion(s)}`);
      });
      if (p.permissionSuggestions.length === 0) {
        lines.push(`      (none — cc offered no always-allow suggestions)`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
  return `
==================================================================
PENDING PermissionRequest DIALOGS
==================================================================

${bullets}
`;
}

/**
 * Parse the cc envelope output for PermissionRequest mode. Returns null
 * on any failure (caller falls back to a default deny so cc doesn't
 * stall — see router P7).
 */
export function parsePermissionRequestOutput(
  stdout: string,
): AIPermissionDialogResult | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('result' in envelope) ||
    typeof (envelope as { result: unknown }).result !== 'string'
  ) {
    return null;
  }
  let inner = (envelope as { result: string }).result.trim();
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
    return null;
  }
  const validated = PermissionDialogAIOutputSchema.safeParse(parsed);
  if (!validated.success) return null;
  return {
    target: validated.data.target,
    reason: validated.data.reason ?? null,
    answer: validated.data.answer,
  };
}

export interface PermissionRequestViaAIOpts {
  userMsg: string;
  pendings: readonly PendingPermissionDialog[];
  claudeBinary?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Spawn `claude --print` for PermissionRequest extraction. Returns null on
 * any failure (timeout / non-zero exit / parse error) — caller treats null
 * as "AI couldn't decide; fall back to default deny so cc doesn't stall".
 */
export async function routePermissionRequestViaAI(
  opts: PermissionRequestViaAIOpts,
): Promise<AIPermissionDialogResult | null> {
  const claudeBinary = opts.claudeBinary ?? DEFAULT_CLAUDE_BINARY;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const prompt = renderPermissionRequestPrompt({
    userMsg: opts.userMsg,
    pendings: opts.pendings,
  });
  const args = buildClaudeArgs({ model, prompt });

  const childEnv = { ...process.env };
  delete childEnv.WEZTERM_PANE;

  let stdout: string;
  try {
    const result = await runClaudeArgvOnly({
      binary: claudeBinary,
      args,
      env: childEnv,
      timeoutMs,
    });
    stdout = result.stdout;
  } catch {
    return null;
  }

  return parsePermissionRequestOutput(stdout);
}
