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
  deleteIMWorkFile,
  deleteIMOriginFile,
  readIMWorkFile,
  deletePermissionFileByPath,
  existsIMWorkFile,
  listPendingPermissionRequests,
  permissionRequestPath,
  permissionResponsePath,
  readIMOriginFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionResponseFile,
  parsePermissionFilename,
} from '@multi-cc-im/cli-cc';
import { readdir } from 'node:fs/promises';
import type { AIRoutingOpts, AIRoutingResult } from './ai-router.js';
import { routeViaAI } from './ai-router.js';
import type { SessionInfo } from './matcher.js';
import { route, type RouterDispatch, type RouterState, type PaneRegistry } from './router.js';
import { truncate } from './text.js';

/**
 * DD-locked Step 1 → Step 2 paste-render delay (ms). [hook+wezterm DD W1](../../../docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
 * Command template uses `sleep 0.3` to give cc TUI time to render the paste.
 */
const DEFAULT_SEND_KEYSTROKE_DELAY_MS = 300;

/** Reaper window — should match hook subprocess timeout (10s). */
const DEFAULT_REAPER_DELAY_MS = 10_000;

export interface CreateOrchestratorOpts {
  /** Lark (or future tg / etc.) IM adapter. */
  imAdapter: IMAdapter;
  /**
   * WezTerm (or future tmux) Term adapter — must satisfy `TermListPanes` so
   * the orchestrator can resolve `#<tabname>` to paneId via `listPanes()`.
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
  /**
   * AI routing callback for plain (no-mention) IM messages. Per
   * [DD: AI-routed IM dispatch](../../../docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md):
   * default = the real `routeViaAI` (spawns `claude --print`). CLI passes a
   * wrapper that bakes in `claudeBinary` / `model` / `timeoutMs`. Tests pass
   * a deterministic stub. Pass `null` to disable AI routing entirely (router
   * falls back to legacy sticky-current logic — useful for tests and as a
   * degraded-mode fallback).
   */
  aiRouter?: ((opts: AIRoutingOpts) => Promise<AIRoutingResult>) | null;
}

export interface BridgeOrchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Wire `IMAdapter` (lark) ↔ `TermAdapter` (wezterm) ↔ `CLIAdapter` (cc) into
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
 *   `<stateDir>/IMWork` 0-byte tombstone. User toggles via bare `/start`
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
  // null → AI routing explicitly disabled. undefined → use real routeViaAI.
  // Function → use the provided wrapper (CLI flags / test stub).
  const aiRouter: ((o: AIRoutingOpts) => Promise<AIRoutingResult>) | undefined =
    opts.aiRouter === null
      ? undefined
      : (opts.aiRouter ?? routeViaAI);

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
  // Inbound: IM → router → term sendText (two-step send)
  // ============================================================================

  async function dispatchOne(
    d: RouterDispatch,
    _msg: IncomingMessage,
  ): Promise<string | null> {
    // Per DD #61: no isPaneAlive gate. Trust user-side `/start` listing.
    // If cc died after user /start, sendText goes to zsh — user notices
    // via missing IM round-trip.
    //
    // IMOrigin is written by handleInbound() at the entry to this hop
    // (DD: IMOrigin global) — we do not re-write here per-dispatch.

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
    // Capture latest IMReplyContext into global state/IMOrigin BEFORE any
    // router / dispatch work. Per [DD: IMOrigin global](../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md):
    // every inbound (bridge cmd / permission response / dispatch / etc.)
    // overwrites IMOrigin so async outbound paths (cc PreToolUse / Stop
    // forward) read the same fresh `context_token` as the synchronous echo
    // path uses via `msg.replyCtx`. Fixes the stale-token bug where
    // dispatch-only writes left old tokens cached in per-pane files.
    try {
      await writeIMOriginFile(opts.stateDir, msg.replyCtx as IMReplyContext);
    } catch (err) {
      onError(err, { phase: 'writeIMOrigin' });
    }

    // Read IMWork once — derives both `imWorkOn` (file exists?) and
    // `imWorkAuto` (`{auto:true}`?). Per [DD: PreToolUse auto-approve](../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md).
    const imWork = await readIMWorkFile(opts.stateDir).catch((err) => {
      onError(err, { phase: 'readIMWorkFile' });
      return null;
    });
    const imWorkOn = imWork !== null;
    const imWorkAuto = imWork?.auto ?? false;

    const result = await route(msg, {
      registry: paneRegistry,
      state: opts.state,
      imWorkOn,
      imWorkAuto,
      aiRouter,
      // Bound to this orchestrator's stateDir so the router can enumerate
      // pending PreToolUse approvals when deciding whether to treat the
      // IM message as a natural-language permission reply. Per DD §9.1 P4
      // (2026-05-11). Always wired — router still gates per-message on
      // whether AI is actually consulted (plain no-mention messages only).
      //
      // Brand bridging: cli-cc's `PendingPermissionRequest.paneId` is
      // `number` (cli-cc has no @multi-cc-im/shared dep so it can't
      // reference the branded `PaneId`). Cast at this IPC boundary so
      // the router's branded `RouterPendingRequest` flows downstream
      // type-safely.
      listPendingPermissionRequests: async () => {
        const raw = await listPendingPermissionRequests(opts.stateDir);
        return raw.map((p) => ({
          ...p,
          paneId: p.paneId as unknown as PaneId,
        }));
      },
    });

    // IMWork toggle from /start [auto] /stop
    if (result.imWorkAction?.kind === 'enable') {
      try {
        await writeIMWorkFile(opts.stateDir, { auto: result.imWorkAction.auto });
        log(
          `[IMWork] enabled by /start${result.imWorkAction.auto ? ' auto' : ''}`,
        );
      } catch (err) {
        onError(err, { phase: 'writeIMWork' });
      }
    } else if (result.imWorkAction?.kind === 'disable') {
      try {
        await deleteIMWorkFile(opts.stateDir);
        log('[IMWork] disabled by /stop');
      } catch (err) {
        onError(err, { phase: 'deleteIMWork' });
      }
    }

    // Permission response: either rigid syntax `#<tab> /1`/`/2` OR an
    // AI-matched natural-language reply (DD §9.1 P4, 2026-05-11). Same
    // helper handles both — AI path provides a verbatim `reason`; rigid
    // syntax leaves it undefined so the helper falls back to the default
    // "IM user replied /1|/2" string.
    if (result.permissionResponse) {
      await handlePermissionResponseFromIM(
        result.permissionResponse.session.paneId as unknown as number,
        result.permissionResponse.decision,
        msg.replyCtx as IMReplyContext,
        result.permissionResponse.reason,
      );
    }

    // Empty result (image-only / no text)
    if (result.echo === '' && result.dispatches.length === 0) return;

    // Log the AI router's decision (when consulted) so the user can
    // iterate on the routing prompt without rebuilding the daemon.
    // Per user smoke 2026-05-11: "需要把 CC 分诊错误打出来,理论上分诊
    // 不应该失败" — surfacing the reason exposes prompt-coverage gaps
    // and confirms when the substring fallback paper'd over an AI
    // miss vs when the AI actually got it right.
    if (result.aiTrace) {
      const t = result.aiTrace;
      const fallbackTag = t.fallback ? ` fallback=${t.fallback}` : '';
      log(
        `[AI router] target=${t.target ?? 'none'} intent="${truncate(t.intent ?? '', 60)}" reason="${truncate(t.reason ?? '', 60)}"${fallbackTag}`,
      );
      // D5-5 (always log) per DD §8.3 — emit a separate audit trail line
      // when the AI matched the IM message to a pending PreToolUse. The
      // user / operator sees both what the AI decided AND its paraphrase
      // of the user's reply, so they can confirm the decision was sane.
      if (t.permissionResponse) {
        const p = t.permissionResponse;
        log(
          `[AI permission] target=${p.target} decision=${p.decision} reason="${truncate(p.reason, 60)}"`,
        );
      }
    }

    if (result.dispatches.length > 0) {
      const targets = result.dispatches.map((d) => displayName(d.session)).join(', ');
      log(`[IM → ${targets}] ${truncate(result.dispatches[0]!.content, 80)}`);
    } else if (result.echo.length > 0) {
      // Multi-line echoes (failure echo with `可用：` tab list, plain-route
      // success echo with `target:` / `content:` lines) are unfolded so
      // daemon stderr matches what the IM user sees. Single-line echoes
      // collapse to one log line as before. Per user smoke 2026-05-11.
      const echoLines = result.echo.split('\n');
      log(`[IM] router returned echo only:`);
      for (const line of echoLines) log(`  ${line}`);
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

    // Read global IMOrigin (latest server-side ctx — zod-validated). Per
    // [DD: IMOrigin global](../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md)
    // it's overwritten by every inbound, so the token here is the latest
    // one issued by the server. NOT deleted here — DD #57's per-reply
    // one-shot semantic was dropped (multi-cc cc#2 reply was being lost
    // when cc#1 reply ran first). Anti-misforward is now gated entirely
    // by IMWork above.
    let replyCtx: IMReplyContext | null;
    try {
      replyCtx = await readIMOriginFile(opts.stateDir);
    } catch (err) {
      onError(err, { phase: 'readIMOrigin', paneId });
      return;
    }
    if (replyCtx === null) {
      log(`[Stop pane=${paneId}] no IMOrigin, skip forward`);
      return;
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
      `[cc → IM] ${prefix} reply='${truncate(p.last_assistant_message, 80)}'`,
    );
    const body = `[${prefix}]\n${p.last_assistant_message}`;
    try {
      await opts.imAdapter.send(body, replyCtx);
    } catch (err) {
      onError(err, { phase: 'forwardStop', paneId });
    }
  }

  // ============================================================================
  // Permission response: IM user replied `#<tab> /1` (allow) or `/2` (deny)
  // ============================================================================

  async function handlePermissionResponseFromIM(
    paneId: number,
    decision: 'allow' | 'deny',
    replyCtx: IMReplyContext,
    /**
     * Optional per-call reason override. AI-matched natural-language
     * replies (DD §9.1 P4) pass the AI's paraphrase of the user's
     * intent verbatim so it flows into cc's transcript via
     * `permissionDecisionReason`. Rigid-syntax `#<tab> /1|/2` callers
     * omit it and we fall back to the historical default string.
     */
    reason?: string,
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
          reason:
            reason ??
            `IM user replied /${decision === 'allow' ? '1' : '2'}`,
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

    // Read global IMOrigin. hook E3 should have short-circuited; defensive
    // null-handling for race / corruption.
    let replyCtx: IMReplyContext | null;
    try {
      replyCtx = await readIMOriginFile(opts.stateDir);
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
      `  #${tabName} /1   = 允许\n` +
      `  #${tabName} /2   = 拒绝`;

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
      // "daemon not running" + "local mode" after Ctrl+C. Per
      // [DD: IMOrigin global](../../docs/superpowers/specs/2026-05-08-imorigin-global-dd.md),
      // also wipe IMOrigin so the next daemon start (or interim direct
      // hook fire) doesn't see a stale `context_token`.
      await deleteIMWorkFile(opts.stateDir).catch((err) => {
        onError(err, { phase: 'stop:deleteIMWork' });
      });
      await deleteIMOriginFile(opts.stateDir).catch((err) => {
        onError(err, { phase: 'stop:deleteIMOrigin' });
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

// Type re-export so callers can pull bridge orchestrator's view of paneId.
export type { PaneId };
