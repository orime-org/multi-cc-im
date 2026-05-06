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
  SessionEndPayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
  TermAdapter,
  TermPaneAlive,
} from '@multi-cc-im/shared';
import { route } from './router.js';
import type { RouterDispatch, RouterState, SessionRegistry } from './router.js';

/**
 * DD-locked Step 1 → Step 2 paste-render delay (ms). [hook+wezterm DD W1](../../../docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
 * Command template uses `sleep 0.3` to give cc TUI time to render the paste.
 */
const DEFAULT_SEND_KEYSTROKE_DELAY_MS = 300;

export interface CreateOrchestratorOpts {
  /** Wechat (or future tg / Lark) IM adapter. */
  imAdapter: IMAdapter;
  /**
   * WezTerm (or future tmux) Term adapter — must satisfy `TermPaneAlive` so
   * the orchestrator can gate every `sendText` per CLAUDE.md "forbidden list":
   * "no send-text without verifying cc is alive".
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
  /**
   * INFO-level event sink — fires for inbound routing decisions, outbound cc
   * Stop forwards / skips, and SessionStart refreshes. Default: silently
   * swallow. \`apps/multi-cc-im/src/start.ts\` wires this to the same stderr
   * logger as its pre-flight banner so users running smoke can watch the
   * full wechat → cc → wechat round-trip in real time.
   */
  log?: (line: string) => void;
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
 * a working bridge per [DD: routing-syntax G'](../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md):
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
  const log = opts.log ?? (() => {});

  // ============================================================================
  // Inbound: wechat → router → term sendText (two-step send)
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

    if (result.dispatches.length > 0) {
      const targets = result.dispatches.map((d) => displayName(d.session)).join(', ');
      log(`[wechat → ${targets}] ${truncate(result.dispatches[0]!.content, 80)}`);
    } else if (result.echo.length > 0) {
      log(`[wechat] router returned echo only: ${truncate(result.echo, 80)}`);
    }

    // Run dispatches in parallel (each pane is independent; router decisions
    // guarantee no conflicting dispatches to the same pane).
    const dispatchErrors: string[] = (
      await Promise.all(result.dispatches.map(dispatchOne))
    ).filter((e): e is string => e !== null);

    const echoLines: string[] = [];
    if (result.echo.length > 0) echoLines.push(result.echo);
    if (dispatchErrors.length > 0) echoLines.push(...dispatchErrors);

    // Surface "/rename hint" for any dispatched session that still lacks a
    // tabTitle. Real-time wezterm poll on every IM event means the hint
    // self-clears once the user runs cc /rename.
    const unnamed = result.dispatches
      .map((d) => d.session)
      .filter((s) => !s.tabTitle || s.tabTitle.length === 0)
      .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
    const hint = renameHintFor(unnamed);
    if (hint) echoLines.push(hint);

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
    const sid8 = p.session_id.slice(0, 8);
    const replyCtx = lastReplyCtxBySession.get(p.session_id);
    if (!replyCtx) {
      log(`[Stop ${sid8}] no wechat origin recorded, skip forward`);
      return; // session never received wechat traffic — silent
    }
    if (p.last_assistant_message.length === 0) {
      log(`[Stop ${sid8}] empty assistant message, skip forward`);
      return;
    }

    // Refresh registry so we see the freshest tabTitle (user may have
    // /rename'd since the last call). Look up THIS session for its display
    // name and prefix the wechat-bound message so the user can tell which
    // cc is replying.
    let prefix = `$${sid8}`;
    try {
      const sessions = await opts.registry.listAlive();
      const me = sessions.find((s) => s.sessionId === p.session_id);
      if (me) prefix = displayName(me);
    } catch (err) {
      onError(err, { phase: 'forwardStopRegistry', sessionId: p.session_id });
    }

    log(
      `[cc → wechat] ${prefix} reply='${truncate(p.last_assistant_message, 80)}'`,
    );
    const body = `[${prefix}]\n${p.last_assistant_message}`;
    try {
      await opts.imAdapter.send(body, replyCtx);
    } catch (err) {
      onError(err, { phase: 'forwardStop', sessionId: p.session_id });
    }
  }

  const cliHandler: CLIHandler = {
    async onSessionStart(p: SessionStartPayload): Promise<void> {
      // Refresh registry so the new session shows up on next inbound dispatch.
      // listAlive() also rebuilds paneToSession cache used by PaneAlive.
      const sid8 = p.session_id.slice(0, 8);
      log(`[SessionStart ${sid8}] cwd=${p.cwd} model=${p.model}`);
      await opts.registry.listAlive().catch((err) => {
        onError(err, { phase: 'sessionStartRefresh' });
      });
    },
    async onStop(p: StopPayload): Promise<HookDecision | void> {
      return handleStop(p);
    },
    async onSessionEnd(p: SessionEndPayload): Promise<void> {
      // Drop in-memory wechat reply context — a future cc that happens to
      // reuse this UUID (e.g. resume after long delay) shouldn't inherit a
      // stale reply target.
      const sid8 = p.session_id.slice(0, 8);
      log(`[SessionEnd ${sid8}] reason=${p.reason}`);
      lastReplyCtxBySession.delete(p.session_id);
      await opts.registry.listAlive().catch((err) => {
        onError(err, { phase: 'sessionEndRefresh' });
      });
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

function displayName(s: { tabTitle: string | undefined; sessionId: string }): string {
  if (s.tabTitle && s.tabTitle.length > 0) return s.tabTitle;
  return `$${s.sessionId.slice(0, 8)}`;
}

/**
 * Produce the one-time "/rename hint" line appended to inbound dispatch
 * echoes when a target cc still has no tab title. User runs cc `/rename
 * <name>` once → next forward observes the new title via real-time
 * `wezterm cli list` poll → hint stops appearing.
 */
function renameHintFor(
  unnamedSessions: Array<{ sessionId: string; cwd: string }>,
): string | null {
  if (unnamedSessions.length === 0) return null;
  const lines = unnamedSessions.map((s) => {
    const sid8 = s.sessionId.slice(0, 8);
    const cwdName = s.cwd.split('/').filter(Boolean).pop() ?? s.cwd;
    return `  · $${sid8} (${cwdName})`;
  });
  return [
    '',
    '[multi-cc-im] tab title missing for:',
    ...lines,
    '  Run `/rename <name>` in each cc TUI to set a friendly name.',
  ].join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
