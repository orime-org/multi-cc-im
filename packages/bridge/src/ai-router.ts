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

export interface AIRoutingOpts {
  /** The IM message body (already with `@<tab>` prefix stripped if any — but caller should only invoke this for plain no-mention messages). */
  userMsg: string;
  /** Currently visible cc tab titles (filter out empty / un-/rename'd tabs before passing). */
  tabs: readonly string[];
  /** The last-explicitly-mentioned tab title, used as a context signal for pronoun resolution. */
  currentTab: string | null;
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
}

const DEFAULT_TIMEOUT_MS = 15_000;
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
}): string {
  const tabList = opts.tabs.length === 0
    ? '(no active tabs)'
    : opts.tabs.map((t) => `  - ${t}`).join('\n');

  const currentLine = opts.currentTab ?? 'none';

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

current (the last tab the user explicitly @-mentioned; may or may not
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
                            "@frontend please ..."
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
  non-null). The previous tab the user @-mentioned is the most likely
  referent.

Rule 3 — TRULY UNROUTABLE → "none".

  Only fall back to "none" when BOTH:
    (a) No tab name appears in any form after lenient matching, AND
    (b) The message doesn't continue prior context via pronouns.

  If you are tempted to bail because the message is "long" or "looks
  like a description", re-check Rule 1 — most messages contain enough
  signal.

==================================================================
OUTPUT
==================================================================

Pick EXACTLY ONE target. Multiple targets are forbidden. If several
tabs are plausibly mentioned, pick the one the message is most about
(usually the one whose name appears first or is most specific).

Output JSON, no markdown wrapping:
{
  "target": "<exact tab name from the active list above>" | "none",
  "intent": "<task description with routing cues stripped>" | null,
  "reason": "<short internal explanation, ≤15 words — used for debugging>"
}`;
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
    return { target: null, intent: null, reason: 'cc envelope not JSON' };
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('result' in envelope) ||
    typeof (envelope as { result: unknown }).result !== 'string'
  ) {
    return { target: null, intent: null, reason: 'cc envelope missing result' };
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
    return { target: null, intent: null, reason: 'inner not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { target: null, intent: null, reason: 'inner not object' };
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

  return { target, intent, reason };
}

/**
 * Spawn `claude --print` to triage the IM message. Returns null target/intent
 * if the AI couldn't decide or anything went wrong (caller echoes
 * `❌ 无法识别` and asks user to fall back to `@<tab>`).
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
    const code = (err as Error & { code?: unknown }).code;
    const reason =
      code === 'ETIMEDOUT'
        ? 'cc timeout'
        : code === 'ENOENT'
          ? 'cc not in PATH'
          : `cc exec failed: ${code ?? 'unknown'}`;
    return { target: null, intent: null, reason };
  }

  return parseRoutingOutput(stdout);
}
