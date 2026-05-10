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
    ? '(无活的 tab)'
    : opts.tabs.map((t) => `  - ${t}`).join('\n');

  const currentLine = opts.currentTab ?? 'none';

  return `你是 multi-cc-im 的 IM 路由助手。

产品功能:
multi-cc-im 是个人 bridge — user 在 IM 端 (微信 / Telegram / 飞书等) 发消息，
daemon 把消息分发到本机跑着的对应 Claude Code 实例。每个实例对应一个工作流
上下文 (前端 / 后端 / 测试 / 文档等)，都有 user 起的语义化名字。

当前活的 Claude Code tabs:
${tabList}

current (user 上次显式选过的 tab，可能跟当前消息相关也可能不相关):
${currentLine}

User 当前 IM 消息:
"${opts.userMsg}"

请你做两件事:
1. 判断这条消息最适合发给哪一个 tab
2. 提取 user 的真实意图 — 把消息中的路由提示词 ("前端那个" / "backend 的"
   等给 IM 路由的 cue 词) 剥离，留下实际要发给 cc 的纯净任务描述

规则 (按优先级):
1. 消息内容明显跟某个 tab 名字相关 → 选那个
2. 消息用代词「它」「这个」延续上文 → 选 current
3. 模糊或多个都合理 → "none" (intent 不必处理)

只能选一个 target，不允许多个。

输出 JSON (无 markdown 包装):
{
  "target": "<tab name>" | "none",
  "intent": "<剥离路由词后的纯任务描述>" | null,
  "reason": "<15字内分诊理由>"
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
