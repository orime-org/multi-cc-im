import { setTimeout as sleep } from 'node:timers/promises';
import type {
  CLIAdapter,
  CLIHandler,
  HookDecision,
  IMAdapter,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
  PaneToSessionMap,
  PostToolUsePayload,
  PreToolUsePayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
  TermAdapter,
  TermPaneAlive,
  UserPromptSubmitPayload,
} from '@multi-cc-im/shared';
import { route } from './router.js';
import type { RouterDispatch, RouterState, SessionRegistry } from './router.js';

/**
 * DD-locked Step 1 → Step 2 paste-render delay (ms). [hook+wezterm DD W1](../../../docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
 * 命令模板示意 `sleep 0.3` 留给 cc TUI 处理 paste 渲染。
 */
const DEFAULT_SEND_KEYSTROKE_DELAY_MS = 300;

export interface CreateOrchestratorOpts {
  /** Wechat (or future tg / 飞书) IM adapter. */
  imAdapter: IMAdapter;
  /**
   * WezTerm (or future tmux) Term adapter — must satisfy `TermPaneAlive` so
   * the orchestrator can gate every `sendText` per CLAUDE.md「禁止清单」"不
   * 验证 cc 活性就 send-text".
   */
  termAdapter: TermAdapter & TermPaneAlive;
  /** Claude Code (or future codex / aider) CLI adapter. */
  cliAdapter: CLIAdapter;
  /** Joined session registry + paneToSession map (`createSessionRegistry`). */
  registry: SessionRegistry & PaneToSessionMap;
  /** Persistent or in-memory state for `current_session` last-explicit sticky. */
  state: RouterState;
  /** Step 1 → Step 2 paste-render delay (ms). Default 300 per DD W1. */
  sendKeystrokeDelayMs?: number;
  /**
   * Non-fatal error sink (IM / Term failures during routing). Default:
   * silently swallow. Bridge main entry passes its `pino` logger.
   */
  onError?: (err: unknown, context: { phase: string; sessionId?: SessionId }) => void;
}

export interface BridgeOrchestrator {
  /**
   * Wire all 3 adapters and start their event loops. Order:
   * 1. CLI (so SessionStart events can populate registry before IM dispatches)
   * 2. Term (no-op v1)
   * 3. IM (long-poll begins; new wechat msgs flow through router)
   */
  start(): Promise<void>;
  /** Reverse order; await running tasks; clear in-memory state. */
  stop(): Promise<void>;
}

/**
 * Wire `IMAdapter` (wechat) ↔ `TermAdapter` (wezterm) ↔ `CLIAdapter` (cc) into
 * a working bridge per [DD: 路由语法 G'](../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md):
 *
 * **Inbound (wechat → cc)**:
 *   IM.onMessage(m) → router.route(m) → for each dispatch:
 *     1. termAdapter.isPaneAlive(paneId) — gate
 *     2. termAdapter.sendText(paneId, content) — Step 1 paste
 *     3. await sleep(sendKeystrokeDelayMs)
 *     4. termAdapter.sendKeystroke(paneId, '\\r') — Step 2 submit
 *   visible echo (router result + dispatch errors) → IM.send(replyCtx)
 *
 * **Outbound (cc Stop → wechat)**:
 *   CLI.onStop(p) → look up `lastReplyCtxBySession[p.session_id]` → if set,
 *   IM.send(p.last_assistant_message, replyCtx). No-op when bridge has never
 *   routed a wechat msg to that session.
 *
 * **Reply-ctx tracking**:
 *   On every successful inbound dispatch, store `incoming.replyCtx` keyed by
 *   target sessionId (overwrite). Multi-target / @all inbound store the same
 *   ctx for every dispatched session. Bridge restart resets the map (current
 *   v1 keeps it in-memory only; persistence would require a per-session file).
 */
export function createOrchestrator(
  opts: CreateOrchestratorOpts,
): BridgeOrchestrator {
  const sendKeystrokeDelayMs =
    opts.sendKeystrokeDelayMs ?? DEFAULT_SEND_KEYSTROKE_DELAY_MS;
  const lastReplyCtxBySession = new Map<SessionId, IMReplyContext>();
  const onError = opts.onError ?? (() => {});

  // ============================================================================
  // Inbound: wechat → router → term sendText 两步法
  // ============================================================================

  async function dispatchOne(d: RouterDispatch): Promise<string | null> {
    const alive = await opts.termAdapter
      .isPaneAlive(d.session.paneId)
      .catch((err) => {
        onError(err, {
          phase: 'isPaneAlive',
          sessionId: d.session.sessionId,
        });
        return false;
      });
    if (!alive) {
      return `⚠️ ${displayName(d.session)} not alive — skip`;
    }
    try {
      await opts.termAdapter.sendText(d.session.paneId, d.content);
      await sleep(sendKeystrokeDelayMs);
      await opts.termAdapter.sendKeystroke(d.session.paneId, '\r');
      return null;
    } catch (err) {
      onError(err, {
        phase: 'sendText',
        sessionId: d.session.sessionId,
      });
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ ${displayName(d.session)} send failed: ${msg}`;
    }
  }

  async function handleInbound(msg: IncomingMessage): Promise<void> {
    const result = await route(msg, {
      registry: opts.registry,
      state: opts.state,
    });

    // Empty result (text=null / image-only) — orchestrator no-op for text path.
    if (result.echo === '' && result.dispatches.length === 0) return;

    // Store replyCtx for each dispatched session (so cc Stop can route back)
    for (const d of result.dispatches) {
      lastReplyCtxBySession.set(d.session.sessionId, msg.replyCtx);
    }

    // Run dispatches in parallel (each pane is independent; router 决策保证
    // 同 pane 不会有冲突 dispatches)
    const dispatchErrors: string[] = (
      await Promise.all(result.dispatches.map(dispatchOne))
    ).filter((e): e is string => e !== null);

    const echoLines: string[] = [];
    if (result.echo.length > 0) echoLines.push(result.echo);
    if (dispatchErrors.length > 0) echoLines.push(...dispatchErrors);

    if (echoLines.length === 0) return;
    try {
      await opts.imAdapter.send(echoLines.join('\n'), msg.replyCtx);
    } catch (err) {
      onError(err, { phase: 'echo' });
    }
  }

  const imHandler: IMHandler = {
    onMessage: handleInbound,
    async onError(err) {
      onError(err, { phase: 'imAdapter' });
    },
  };

  // ============================================================================
  // Outbound: cc Stop → wechat send via stored replyCtx
  // ============================================================================

  async function handleStop(p: StopPayload): Promise<HookDecision | void> {
    const replyCtx = lastReplyCtxBySession.get(p.session_id);
    if (!replyCtx) return; // session never received wechat traffic — silent
    if (p.last_assistant_message.length === 0) return; // empty reply — skip

    try {
      await opts.imAdapter.send(p.last_assistant_message, replyCtx);
    } catch (err) {
      onError(err, { phase: 'forwardStop', sessionId: p.session_id });
    }
  }

  const cliHandler: CLIHandler = {
    async onSessionStart(_p: SessionStartPayload): Promise<void> {
      // Refresh registry so the new session shows up on next inbound dispatch.
      // listAlive() also rebuilds paneToSession cache used by PaneAlive.
      await opts.registry.listAlive().catch((err) => {
        onError(err, { phase: 'sessionStartRefresh' });
      });
    },
    async onUserPromptSubmit(_p: UserPromptSubmitPayload): Promise<void> {
      // Direct cc TUI input — bridge doesn't forward to wechat (Stop hook will
      // carry the assistant reply for forwarding, no need for the prompt itself).
    },
    async onPreToolUse(_p: PreToolUsePayload): Promise<void> {},
    async onPostToolUse(_p: PostToolUsePayload): Promise<void> {},
    async onStop(p: StopPayload): Promise<HookDecision | void> {
      return handleStop(p);
    },
  };

  // ============================================================================
  // Lifecycle
  // ============================================================================

  let started = false;

  return {
    async start(): Promise<void> {
      if (started) throw new Error('createOrchestrator: already started');
      started = true;
      await opts.cliAdapter.start(cliHandler);
      await opts.termAdapter.start({});
      await opts.imAdapter.start(imHandler);
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      await opts.imAdapter.stop().catch((err) => {
        onError(err, { phase: 'stop:im' });
      });
      await opts.termAdapter.stop().catch((err) => {
        onError(err, { phase: 'stop:term' });
      });
      await opts.cliAdapter.stop().catch((err) => {
        onError(err, { phase: 'stop:cli' });
      });
      lastReplyCtxBySession.clear();
    },
  };
}

function displayName(s: { friendlyName: string | undefined; sessionId: string }): string {
  return s.friendlyName ?? `$${s.sessionId.slice(0, 8)}`;
}
