import { setTimeout as sleep } from 'node:timers/promises';
import type {
  CLIAdapter,
  CLIHandler,
  HookDecision,
  IMAdapter,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
  PaneId,
  PreToolUsePayload,
  StopPayload,
  TermAdapter,
  TermListPanes,
  TermPaneInfo,
} from '@multi-cc-im/shared';
import {
  deleteDaemonPidFile,
  deleteIMOriginFile,
  deleteIMWorkFile,
  deletePermissionFileByPath,
  existsIMWorkFile,
  permissionRequestPath,
  permissionResponsePath,
  readIMOriginFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionResponseFile,
  parsePermissionFilename,
} from '@multi-cc-im/cli-cc';
import { readdir } from 'node:fs/promises';
import type { SessionInfo } from './matcher.js';
import { route, type RouterDispatch, type RouterState, type PaneRegistry } from './router.js';

/**
 * DD-locked Step 1 → Step 2 paste-render delay (ms). [hook+wezterm DD W1](../../../docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
 * Command template uses `sleep 0.3` to give cc TUI time to render the paste.
 */
const DEFAULT_SEND_KEYSTROKE_DELAY_MS = 300;

/** Reaper window — should match hook subprocess timeout (10s). */
const DEFAULT_REAPER_DELAY_MS = 10_000;

export interface CreateOrchestratorOpts {
  /** Wechat (or future tg / Lark) IM adapter. */
  imAdapter: IMAdapter;
  /**
   * WezTerm (or future tmux) Term adapter — must satisfy `TermListPanes` so
   * the orchestrator can resolve `@<tabname>` to paneId via `listPanes()`.
   * No `isPaneAlive` capability needed (DD #61 — daemon trusts user-side
   * `/start` listing for cc liveness).
   */
  termAdapter: TermAdapter & TermListPanes;
  /** Claude Code (or future codex / aider) CLI adapter. */
  cliAdapter: CLIAdapter;
  /**
   * State dir holding per-pane files (e.g. `~/.multi-cc-im/state/`).
   * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
   * file naming is `<paneId>_<sid>.<event>` (cc-hook) + `<paneId>.IMOrigin`
   * (daemon).
   */
  stateDir: string;
  /** In-memory state for `current_pane` last-explicit sticky. */
  state: RouterState;
  /** Step 1 → Step 2 paste-render delay (ms). Default 300 per DD W1. */
  sendKeystrokeDelayMs?: number;
  /**
   * Daemon reaper window (ms) — schedule unlink of orphan
   * `<paneId>_<sid>.PermissionRequest/Response.<id>.json` files this long
   * after chokidar surfaces a new Request. Default `10_000` matches hook
   * subprocess timeout. Tests inject a small value.
   */
  reaperDelayMs?: number;
  /** Non-fatal error sink. */
  onError?: (
    err: unknown,
    context: { phase: string; paneId?: number; sessionId?: string },
  ) => void;
  /** INFO-level event sink for routing decisions / forwards. */
  log?: (line: string) => void;
}

export interface BridgeOrchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire `IMAdapter` (wechat) ↔ `TermAdapter` (wezterm) ↔ `CLIAdapter` (cc) into
 * a working bridge. Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 *
 * **Inbound (IM → cc)**:
 *   IM.onMessage(m) → router.route(m) (using `termAdapter.listPanes()`) →
 *   for each dispatch:
 *     1. Write `<paneId>.IMOrigin` with msg.replyCtx (typed; imType discriminator)
 *     2. termAdapter.sendText(paneId, content) — Step 1 paste
 *     3. await sleep(sendKeystrokeDelayMs)
 *     4. termAdapter.sendKeystroke(paneId, '\\r') — Step 2 submit
 *   visible echo (router result + dispatch errors) → IM.send(replyCtx)
 *
 * **Outbound (cc Stop → IM)**:
 *   CLI.onStop(p) → check `<paneId>.IMOrigin` file → if exists, IM.send(reply, ctx)
 *   and **delete the file**. ONE-SHOT semantic: subsequent Stops without a
 *   fresh IM dispatch skip forward. `imType` discriminator on stored ctx
 *   selects which adapter `send()` to call (multi-IM-future-proof).
 *
 * **IMWork (global manual switch)**:
 *   `<stateDir>/IMWork` 0-byte tombstone. User toggles via `@multi-cc-im /start`
 *   (write file) and `/stop` (delete file). When off, daemon refuses IM-to-cc
 *   dispatches (router-level gate) and refuses cc-to-IM forwards (handleStop
 *   gate). daemon start auto-resets to off.
 */
export function createOrchestrator(
  opts: CreateOrchestratorOpts,
): BridgeOrchestrator {
  const sendKeystrokeDelayMs =
    opts.sendKeystrokeDelayMs ?? DEFAULT_SEND_KEYSTROKE_DELAY_MS;
  const onError = opts.onError ?? (() => {});
  const log = opts.log ?? (() => {});
  const reaperDelayMs = opts.reaperDelayMs ?? DEFAULT_REAPER_DELAY_MS;

  // Reaper timers per (paneId, sid, requestId) tuple.
  const reaperTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // PaneRegistry adapter over termAdapter.listPanes — converts
  // TermPaneInfo[] (paneId, title, cwd) to SessionInfo[] (router shape).
  const paneRegistry: PaneRegistry = {
    async listPanes(): Promise<readonly SessionInfo[]> {
      const panes = await opts.termAdapter.listPanes();
      return panes.map(paneInfoToSessionInfo);
    },
  };

  // ============================================================================
  // Inbound: wechat → router → term sendText (two-step send)
  // ============================================================================

  async function dispatchOne(
    d: RouterDispatch,
    msg: IncomingMessage,
  ): Promise<string | null> {
    // Per DD #61: no isPaneAlive gate. Trust user-side `/start` listing.
    // If cc died after user /start, sendText goes to zsh — user notices
    // via missing IM round-trip.

    // Write <paneId>.IMOrigin with the typed replyCtx (B2 — newest wins).
    try {
      await writeIMOriginFile({
        stateDir: opts.stateDir,
        paneId: d.session.paneId as unknown as number,
        replyCtx: msg.replyCtx as IMReplyContext,
      });
    } catch (err) {
      onError(err, {
        phase: 'writeIMOrigin',
        paneId: d.session.paneId as unknown as number,
      });
      return `❌ ${displayName(d.session)} writeIMOrigin failed`;
    }

    try {
      await opts.termAdapter.sendText(d.session.paneId, d.content);
      await sleep(sendKeystrokeDelayMs);
      await opts.termAdapter.sendKeystroke(d.session.paneId, '\r');
      return null;
    } catch (err) {
      onError(err, {
        phase: 'sendText',
        paneId: d.session.paneId as unknown as number,
      });
      const msg2 = err instanceof Error ? err.message : String(err);
      return `❌ ${displayName(d.session)} send failed: ${msg2}`;
    }
  }

  async function handleInbound(msg: IncomingMessage): Promise<void> {
    const imWorkOn = await existsIMWorkFile(opts.stateDir).catch((err) => {
      onError(err, { phase: 'existsIMWorkFile' });
      return false;
    });

    const result = await route(msg, {
      registry: paneRegistry,
      state: opts.state,
      imWorkOn,
    });

    // IMWork toggle from /start /stop
    if (result.imWorkAction === 'enable') {
      try {
        await writeIMWorkFile(opts.stateDir);
        log('[IMWork] enabled by /start');
      } catch (err) {
        onError(err, { phase: 'writeIMWork' });
      }
    } else if (result.imWorkAction === 'disable') {
      try {
        await deleteIMWorkFile(opts.stateDir);
        log('[IMWork] disabled by /stop');
      } catch (err) {
        onError(err, { phase: 'deleteIMWork' });
      }
    }

    // Permission response: @<tab> /1 /2
    if (result.permissionResponse) {
      await handlePermissionResponseFromIM(
        result.permissionResponse.session.paneId as unknown as number,
        result.permissionResponse.decision,
        msg.replyCtx as IMReplyContext,
      );
    }

    // Empty result (image-only / no text)
    if (result.echo === '' && result.dispatches.length === 0) return;

    if (result.dispatches.length > 0) {
      const targets = result.dispatches.map((d) => displayName(d.session)).join(', ');
      log(`[wechat → ${targets}] ${truncate(result.dispatches[0]!.content, 80)}`);
    } else if (result.echo.length > 0) {
      log(`[wechat] router returned echo only: ${truncate(result.echo, 80)}`);
    }

    // Run dispatches in parallel (each pane independent).
    const dispatchErrors: string[] = (
      await Promise.all(result.dispatches.map((d) => dispatchOne(d, msg)))
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
  // Outbound: cc Stop → IM send via stored replyCtx
  // ============================================================================

  async function handleStop(
    p: StopPayload & { paneId: number },
  ): Promise<HookDecision | void> {
    const { paneId } = p;

    // IMWork is the master switch.
    if (!(await existsIMWorkFile(opts.stateDir))) {
      log(`[Stop pane=${paneId}] IMWork off, skip forward`);
      return;
    }

    // Read IMOrigin (per-pane ctx, zod-validated discriminated union).
    let replyCtx: IMReplyContext | null;
    try {
      replyCtx = await readIMOriginFile({ stateDir: opts.stateDir, paneId });
    } catch (err) {
      onError(err, { phase: 'readIMOrigin', paneId });
      return;
    }
    if (replyCtx === null) {
      log(`[Stop pane=${paneId}] no IMOrigin, skip forward`);
      return;
    }

    // ONE-SHOT: delete IMOrigin immediately.
    try {
      await deleteIMOriginFile({ stateDir: opts.stateDir, paneId });
    } catch (err) {
      onError(err, { phase: 'deleteIMOrigin', paneId });
    }

    if (p.last_assistant_message.length === 0) {
      log(`[Stop pane=${paneId}] empty assistant message, skip forward`);
      return;
    }

    // Resolve current tab title for prefix.
    let prefix = `(pane ${paneId})`;
    try {
      const panes = await opts.termAdapter.listPanes();
      const me = panes.find((pi) => (pi.paneId as unknown as number) === paneId);
      if (me && me.title.length > 0) prefix = me.title;
    } catch (err) {
      onError(err, { phase: 'forwardStopListPanes', paneId });
    }

    log(
      `[cc → wechat] ${prefix} reply='${truncate(p.last_assistant_message, 80)}'`,
    );
    const body = `[${prefix}]\n${p.last_assistant_message}`;
    try {
      await opts.imAdapter.send(body, replyCtx);
    } catch (err) {
      onError(err, { phase: 'forwardStop', paneId });
    }
  }

  // ============================================================================
  // Permission response: IM user replied `@<tab> /1` (allow) or `/2` (deny)
  // ============================================================================

  async function handlePermissionResponseFromIM(
    paneId: number,
    decision: 'allow' | 'deny',
    replyCtx: IMReplyContext,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(opts.stateDir);
    } catch (err) {
      onError(err, { phase: 'permissionResponseListDir', paneId });
      return;
    }

    // Find pending PermissionRequest for this paneId. cc serializes hooks
    // so we expect 0 or 1 in flight.
    const pending = entries
      .map((name) => parsePermissionFilename(name))
      .filter(
        (
          x,
        ): x is NonNullable<ReturnType<typeof parsePermissionFilename>> =>
          x !== null && x.paneId === paneId && x.kind === 'request',
      );

    if (pending.length === 0) {
      log(`[PermissionResponse pane=${paneId}] no pending request — IM reply ignored`);
      try {
        await opts.imAdapter.send(
          `❌ pane ${paneId} 当前没在等审批的工具，回复无效。`,
          replyCtx,
        );
      } catch (err) {
        onError(err, { phase: 'permissionResponseEcho', paneId });
      }
      return;
    }

    for (const p of pending) {
      log(
        `[PermissionResponse pane=${paneId} sid=${p.sessionId.slice(0, 8)}] ${decision} request ${p.requestId}`,
      );
      try {
        await writePermissionResponseFile({
          stateDir: opts.stateDir,
          paneId: p.paneId,
          sessionId: p.sessionId,
          requestId: p.requestId,
          decision,
          reason: `IM user replied /${decision === 'allow' ? '1' : '2'}`,
        });
      } catch (err) {
        onError(err, {
          phase: 'permissionResponseWrite',
          paneId,
          sessionId: p.sessionId,
        });
      }
    }
  }

  // ============================================================================
  // PreToolUse: cc wants to call a tool, ask IM
  // ============================================================================

  async function handlePreToolUse(
    p: PreToolUsePayload & { requestId: string; paneId: number },
  ): Promise<void> {
    const { paneId } = p;

    // Schedule reaper FIRST regardless of forward outcome.
    scheduleReaper({
      paneId,
      sessionId: p.session_id,
      requestId: p.requestId,
    });

    // Read IMOrigin (per-pane ctx). hook E3 should have short-circuited;
    // defensive null-handling for race / corruption.
    let replyCtx: IMReplyContext | null;
    try {
      replyCtx = await readIMOriginFile({ stateDir: opts.stateDir, paneId });
    } catch (err) {
      onError(err, { phase: 'readIMOrigin', paneId });
      return;
    }
    if (replyCtx === null) {
      log(`[PreToolUse pane=${paneId}] no IMOrigin (race?) — skip forward`);
      return;
    }

    // Resolve friendly name.
    let tabName = `(pane ${paneId})`;
    try {
      const panes = await opts.termAdapter.listPanes();
      const me = panes.find((pi) => (pi.paneId as unknown as number) === paneId);
      if (me && me.title.length > 0) tabName = me.title;
    } catch (err) {
      onError(err, { phase: 'preToolUseListPanes', paneId });
    }

    const summary = summarizeToolInput(p.tool_name, p.tool_input);
    const body =
      `[${tabName}] 准备跑工具:\n  ${p.tool_name}(${summary})\n\n` +
      `⏳ 10 秒内回复，否则默认放行:\n` +
      `  @${tabName} /1   = 允许\n` +
      `  @${tabName} /2   = 拒绝`;

    log(`[PreToolUse pane=${paneId}] ask IM: ${p.tool_name}(${truncate(summary, 40)})`);
    try {
      await opts.imAdapter.send(body, replyCtx);
    } catch (err) {
      onError(err, { phase: 'preToolUseAsk', paneId });
    }
  }

  // ============================================================================
  // Reaper: backstop unlink for orphan PermissionRequest/Response files
  // ============================================================================

  function scheduleReaper(o: {
    paneId: number;
    sessionId: string;
    requestId: string;
  }): void {
    const key = `${o.paneId}:${o.sessionId}:${o.requestId}`;
    const prev = reaperTimers.get(key);
    if (prev !== undefined) clearTimeout(prev);

    const timer = setTimeout(async () => {
      reaperTimers.delete(key);
      const reqPath = permissionRequestPath({
        stateDir: opts.stateDir,
        paneId: o.paneId,
        sessionId: o.sessionId,
        requestId: o.requestId,
      });
      const respPath = permissionResponsePath({
        stateDir: opts.stateDir,
        paneId: o.paneId,
        sessionId: o.sessionId,
        requestId: o.requestId,
      });
      try {
        await deletePermissionFileByPath(reqPath);
        await deletePermissionFileByPath(respPath);
      } catch (err) {
        onError(err, {
          phase: 'reaper',
          paneId: o.paneId,
          sessionId: o.sessionId,
        });
      }
    }, reaperDelayMs);
    reaperTimers.set(key, timer);
  }

  const cliHandler: CLIHandler = {
    async onPreToolUse(p): Promise<void> {
      return handlePreToolUse(p);
    },
    async onStop(p): Promise<HookDecision | void> {
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
      for (const t of reaperTimers.values()) clearTimeout(t);
      reaperTimers.clear();

      // Cleanup IM-mode lock + daemon lock so hooks immediately see
      // "daemon not running" + "local mode" after Ctrl+C.
      await deleteIMWorkFile(opts.stateDir).catch((err) => {
        onError(err, { phase: 'stop:deleteIMWork' });
      });
      await deleteDaemonPidFile(opts.stateDir).catch((err) => {
        onError(err, { phase: 'stop:deleteDaemonPid' });
      });
    },
  };
}

function paneInfoToSessionInfo(p: TermPaneInfo): SessionInfo {
  return {
    paneId: p.paneId,
    tabTitle: p.title,
    cwd: p.cwd,
  };
}

function displayName(s: SessionInfo): string {
  if (s.tabTitle.length > 0) return s.tabTitle;
  return `(pane ${s.paneId})`;
}

/**
 * Summarize a cc tool_input for human-readable display in the IM
 * permission prompt. Bash gets the command line; Read/Edit/Write get
 * file_path; WebFetch gets url; everything else falls back to JSON.
 */
function summarizeToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return truncate(toolInput.command, 120);
  }
  if (
    (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') &&
    typeof toolInput.file_path === 'string'
  ) {
    return toolInput.file_path;
  }
  if (toolName === 'WebFetch' && typeof toolInput.url === 'string') {
    return toolInput.url;
  }
  return truncate(JSON.stringify(toolInput), 120);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Type re-export so callers can pull bridge orchestrator's view of paneId.
export type { PaneId };
