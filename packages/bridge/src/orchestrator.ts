import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type {
  CLIAdapter,
  CLIHandler,
  HookDecision,
  IMAdapter,
  IMAUQQuestion,
  IMAUQRequest,
  IMAUQSender,
  IMCardActionEvent,
  IMCardActionResponse,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
  PaneId,
  PermissionRequestPayload,
  PreToolUsePayload,
  StopPayload,
  TermAdapter,
  TerminalId,
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
  listPendingPermissionDialogs,
  listPendingPermissionRequests,
  permissionDialogRequestPath,
  permissionDialogResponsePath,
  permissionRequestPath,
  permissionResponsePath,
  readIMOriginFile,
  readPermissionDialogRequestFile,
  writeIMOriginFile,
  writeIMWorkFile,
  writePermissionDialogResponseFile,
  writePermissionResponseFile,
  parsePermissionFilename,
  parsePermissionDialogFilename,
} from '@multi-cc-im/cli-cc';
import { readdir } from 'node:fs/promises';
import type {
  AIAskUserQuestionResult,
  AIPermissionDialogResult,
  AIRoutingOpts,
  AIRoutingResult,
  AskUserQuestionViaAIOpts,
  PermissionRequestViaAIOpts,
} from './ai-router.js';
import {
  routeAskUserQuestionViaAI,
  routePermissionRequestViaAI,
  routeViaAI,
} from './ai-router.js';
import type { SessionInfo } from './matcher.js';
import { route, type RouterDispatch, type RouterState, type PaneRegistry } from './router.js';
import { truncate } from './text.js';

/**
 * DD-locked Step 1 → Step 2 paste-render delay (ms). [hook+wezterm DD W1](../../../docs/superpowers/specs/2026-04-27-cc-hook-wezterm-probe.md)
 * Command template uses `sleep 0.3` to give cc TUI time to render the paste.
 */
const DEFAULT_SEND_KEYSTROKE_DELAY_MS = 300;

/**
 * Reaper window for regular tools (Bash / Edit / WebFetch / etc).
 *
 * Must exceed the cc-side hook timeout (`apps/setup-hooks.ts`
 * EVENT_MATCHER_SPECS.PreToolUse[<regular>] = 20s) so the hook subprocess
 * has time to run its own try/finally cleanup after cc SIGKILLs it on
 * timeout. 30s = 20s cc-side + 10s margin.
 *
 * Bumped from 10s 2026-05-12 — at 10s the reaper races with the hook's
 * internal poll deadline (10s) + the user's natural-language reply
 * window. For v1.7 Bash deny via natural language, user reading +
 * thinking + typing >10s would let reaper unlink the live Request file
 * before the IM reply lands, breaking force-permission mode.
 */
const DEFAULT_REAPER_DELAY_MS = 30_000;

/**
 * Reaper window for AskUserQuestion. Must exceed the AskUserQuestion-
 * specific cc-side hook timeout (310s per `apps/setup-hooks.ts`
 * EVENT_MATCHER_SPECS.PreToolUse[<AskUserQuestion>]). 320s = 310s
 * cc-side + 10s margin.
 *
 * Per real-account smoke 2026-05-12 root cause: with the regular 10s
 * reaper, AskUserQuestion's Request file got unlinked while the hook
 * was still polling for the user's IM reply (user takes 15-60s to
 * read the options + answer). Daemon then saw an empty pending list
 * when the reply arrived → routed the answer as a new task → cc
 * never received it in the AskUserQuestion's tool result.
 *
 * 2026-05-15 sub-revision: bumped from 130_000 → 320_000 alongside the
 * cc-side hook timeout bump (120s → 310s). Real-mobile usage showed
 * the §9.5-era 2-min budget runs out of phone notification + app
 * switch + thumb-typing time; 5-min user budget covers it.
 *
 * Reaper's defensive purpose (cleanup of SIGKILL'd hook orphans) is
 * unaffected — orphans get reaped 5min later instead of 10s later,
 * which is fine for the rare SIGKILL case.
 */
const ASK_USER_QUESTION_REAPER_DELAY_MS = 320_000;

const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/**
 * PermissionDialog reaper window (ms). Mirror AUQ — hook polls Response
 * for 110s + 10s cc-side / network margin. Reaping earlier would race
 * the live Request file like the v1.11 root-cause incident. Per
 * [DD: PermissionRequest hook IM bridge §3 D8](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md).
 */
const PERMISSION_DIALOG_REAPER_DELAY_MS = 130_000;

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
   * after chokidar surfaces a new Request. Default `30_000` (cc-side hook
   * timeout 20s + 10s margin). Applies to regular tools (Bash / Edit /
   * etc); AskUserQuestion uses `askUserQuestionReaperDelayMs` instead.
   * Tests inject a small value.
   */
  reaperDelayMs?: number;
  /**
   * Reaper window (ms) specifically for AskUserQuestion's PermissionRequest
   * files. Default `320_000` (cc-side AskUserQuestion hook timeout 310s
   * + 10s margin per DD §10 sub-revision 2026-05-15). Required because
   * AskUserQuestion holds the hook for up to 300s waiting for IM reply —
   * reaping at the regular 30s would unlink the live Request file
   * mid-flow. Tests inject a small value.
   */
  askUserQuestionReaperDelayMs?: number;
  /**
   * Reaper window (ms) specifically for PermissionDialog Request/Response
   * files (cc PermissionRequest hook event — daemon-side IPC for sensitive-
   * path dialogs). Default `130_000` (cc-side timeout 120s + 10s margin
   * per DD 2026-05-13 §3 D8). Required because the hook polls for up to
   * 110s waiting for IM reply / daemon decision — reaping earlier would
   * race the live Request file.
   */
  permissionDialogReaperDelayMs?: number;
  /** Non-fatal error sink. */
  onError?: (
    err: unknown,
    context: { phase: string; paneId?: PaneId; sessionId?: string },
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
  /**
   * AskUserQuestion AI router callback (DD §9.6 R7). Invoked when any
   * pending PreToolUse has `toolName === 'AskUserQuestion'`. Default =
   * the real `routeAskUserQuestionViaAI` (spawns `claude --print` with
   * the AUQ-specific prompt). Tests pass a deterministic stub. Pass
   * `null` to disable — router's AUQ branch falls back to writing
   * empty-answers `updatedInput` so cc doesn't stall.
   */
  aiAskUserQuestionRouter?:
    | ((opts: AskUserQuestionViaAIOpts) => Promise<AIAskUserQuestionResult | null>)
    | null;
  /**
   * PermissionRequest AI router callback (DD 2026-05-13 §6 P7). Invoked
   * when any pending PermissionDialog is waiting for an IM reply.
   * Default = real `routePermissionRequestViaAI`. Pass `null` to disable
   * — router's PermissionDialog branch falls back to deny so cc doesn't
   * stall.
   */
  aiPermissionRequestRouter?:
    | ((opts: PermissionRequestViaAIOpts) => Promise<AIPermissionDialogResult | null>)
    | null;
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
  /**
   * Which terminal the daemon was started for. Computed once from the
   * termAdapter the caller wired in (start.ts picks via wizard). Used
   * to (a) select which `IM<TermType>` file `/start auto`/`/stop`
   * writes/deletes, (b) select which file the inbound IM handler
   * reads to derive `imWorkOn` / `imWorkAuto`. Per issue 378 root
   * cause: the daemon serves one terminal at a time, so the file
   * scheme is per-terminal-and-only-the-active-one to block cc-hook
   * leakage from the other terminal.
   */
  const activeTerminalId: TerminalId =
    opts.termAdapter.name === 'iterm2' ? 'iterm2' : 'wezterm';
  const reaperDelayMs = opts.reaperDelayMs ?? DEFAULT_REAPER_DELAY_MS;
  const askUserQuestionReaperDelayMs =
    opts.askUserQuestionReaperDelayMs ?? ASK_USER_QUESTION_REAPER_DELAY_MS;
  const permissionDialogReaperDelayMs =
    opts.permissionDialogReaperDelayMs ?? PERMISSION_DIALOG_REAPER_DELAY_MS;
  // null → AI routing explicitly disabled. undefined → use real routeViaAI.
  // Function → use the provided wrapper (CLI flags / test stub).
  const aiRouter: ((o: AIRoutingOpts) => Promise<AIRoutingResult>) | undefined =
    opts.aiRouter === null
      ? undefined
      : (opts.aiRouter ?? routeViaAI);
  const aiAskUserQuestionRouter:
    | ((o: AskUserQuestionViaAIOpts) => Promise<AIAskUserQuestionResult | null>)
    | undefined =
    opts.aiAskUserQuestionRouter === null
      ? undefined
      : (opts.aiAskUserQuestionRouter ?? routeAskUserQuestionViaAI);
  const aiPermissionRequestRouter:
    | ((o: PermissionRequestViaAIOpts) => Promise<AIPermissionDialogResult | null>)
    | undefined =
    opts.aiPermissionRequestRouter === null
      ? undefined
      : (opts.aiPermissionRequestRouter ?? routePermissionRequestViaAI);

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
        paneId: d.session.paneId,
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

    // Read IMWork (per-terminal — issue 378) once — derives both
    // `imWorkOn` (file exists?) and `imWorkAuto` (`{auto:true}`?). Per
    // [DD: PreToolUse auto-approve](../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md).
    const imWork = await readIMWorkFile(opts.stateDir, activeTerminalId).catch(
      (err) => {
        onError(err, { phase: 'readIMWorkFile' });
        return null;
      },
    );
    const imWorkOn = imWork !== null;
    const imWorkAuto = imWork?.auto ?? false;

    // Pre-ack for plain messages (v1.10, 2026-05-12): plain msgs trigger
    // an AI subprocess (cc cold-start ~2-5 s + Haiku inference ~1-2 s),
    // total 3-7 s wait. Without a visible signal users assume the IM
    // message was dropped. Fire a one-line "AI 处理中: <excerpt>" before
    // route() so the user sees daemon is working. Bridge commands
    // (`/...`) and mentions (`#...`) get fast echoes and don't need the
    // pre-ack. Fire-and-forget: pre-ack send failure must NOT block the
    // real route() — log and continue. Only gated on IMWork on (off
    // means no IM dispatch at all, pre-ack would be misleading).
    if (imWorkOn) {
      const trimmed = (msg.text ?? '').trim();
      if (
        trimmed.length > 0 &&
        !trimmed.startsWith('/') &&
        !trimmed.startsWith('#')
      ) {
        const excerpt = truncate(trimmed, 30);
        log(`[AI router pre-ack] msg="${excerpt}"`);
        try {
          await opts.imAdapter.send(
            `🔍 AI 分诊中: "${excerpt}"`,
            msg.replyCtx as IMReplyContext,
          );
        } catch (err) {
          onError(err, { phase: 'preAck' });
          // intentionally continue — route() must still run
        }
      }
    }

    const result = await route(msg, {
      registry: paneRegistry,
      state: opts.state,
      imWorkOn,
      imWorkAuto,
      // Surface the active terminal adapter name in `/start` echoes so IM
      // users can verify the daemon picked the right one. Per
      // [DD: iTerm2 adapter P4](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md).
      terminalId: opts.termAdapter.name === 'iterm2' ? 'iterm2' : 'wezterm',
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
      listPendingPermissionDialogs: async () => {
        const raw = await listPendingPermissionDialogs(opts.stateDir);
        return raw.map((p) => ({
          ...p,
          paneId: p.paneId as unknown as PaneId,
        }));
      },
      aiAskUserQuestionRouter,
      aiPermissionRequestRouter,
    });

    // Per-terminal IM<TermType> toggle from /start [auto] /stop. Only
    // the daemon's active terminal gets a file — the other terminal's
    // file staying absent is what blocks cross-terminal cc-hook
    // leakage (issue 378). `activeTerminalId` is hoisted at the top
    // of createOrchestrator so the same value is used here, in
    // `handleInbound`'s IMWork read, in the shutdown delete, etc.
    if (result.imWorkAction?.kind === 'enable') {
      try {
        await writeIMWorkFile(opts.stateDir, activeTerminalId, {
          auto: result.imWorkAction.auto,
        });
        log(
          `[IMWork] enabled by /start${result.imWorkAction.auto ? ' auto' : ''} for ${activeTerminalId}`,
        );
      } catch (err) {
        onError(err, { phase: 'writeIMWork' });
      }
    } else if (result.imWorkAction?.kind === 'disable') {
      try {
        await deleteIMWorkFile(opts.stateDir, activeTerminalId);
        log(`[IMWork] disabled by /stop for ${activeTerminalId}`);
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
        result.permissionResponse.session.paneId,
        result.permissionResponse.decision,
        msg.replyCtx as IMReplyContext,
        result.permissionResponse.reason,
        result.permissionResponse.updatedInput,
      );
    }

    if (result.permissionDialogResponse) {
      await handlePermissionDialogResponseFromIM(
        result.permissionDialogResponse.session.paneId,
        result.permissionDialogResponse.answer,
        msg.replyCtx as IMReplyContext,
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

  /**
   * Pending AskUserQuestion state — set when the adapter renders a
   * button card, looked up when the user clicks a button. Per
   * [DD γ P5 2026-05-19](../../docs/superpowers/specs/2026-05-19-auq-pretooluse-card-buttons-dd.md).
   *
   * Cleanup paths:
   *   - successful button click → deleted in `handleCardAction`
   *   - timeout → cc hook eventually times out 310s after; the
   *     existing AUQ reaper unlinks the request file. The pending
   *     entry here is dropped when the next click arrives as `stale`.
   *
   * Multi-cc-pane scenarios share one map keyed on cc-issued
   * `toolUseId` (server-unique), so no collision.
   */
  const pendingAUQ = new Map<
    string,
    {
      paneId: PaneId;
      replyCtx: IMReplyContext;
      questions: IMAUQQuestion[];
      tabName: string;
    }
  >();

  /**
   * Dispatches a `card.action.trigger` click back to the originating
   * workflow. P5 routes `kind:'auq'` clicks through the same
   * `handlePermissionResponseFromIM` path used by AI-matched natural
   * language replies (DD §9 D5-D `updatedInput.answers`), so the cc
   * hook output stays identical regardless of click vs typed reply.
   *
   * `kind:'permission'` is wired in P4 (next branch).
   */
  async function handleCardAction(
    event: IMCardActionEvent,
  ): Promise<IMCardActionResponse | void> {
    const value = event.action.value;
    if (value.kind === 'auq') {
      const entry = pendingAUQ.get(value.toolUseId);
      if (!entry) {
        log(
          `[card.action auq] stale click toolUseId=${value.toolUseId} questionIdx=${value.questionIdx}`,
        );
        return {
          toast: { type: 'warning', content: '该问题已超时或已回答' },
        };
      }
      if (value.optionIdx === undefined) {
        // Free-text branch is not surfaced as a button in P5; reaching
        // here means a custom Lark client sent the callback shape. Drop
        // the entry (treat as deny) so cc doesn't stall waiting.
        log(
          `[card.action auq] customText branch (no button source); ignoring + leaving pending`,
        );
        return {
          toast: { type: 'info', content: '请直接回复消息作自由文本回答' },
        };
      }
      const q = entry.questions[value.questionIdx];
      const opt = q?.options[value.optionIdx];
      if (!q || !opt) {
        log(
          `[card.action auq] invalid q/opt idx q=${value.questionIdx} o=${value.optionIdx} toolUseId=${value.toolUseId}`,
        );
        return { toast: { type: 'error', content: '选项无效' } };
      }
      const answers: Record<string, string> = { [q.text]: opt.label };
      const questionsPayload = entry.questions.map((qq) => ({
        question: qq.text,
        ...(qq.header !== undefined ? { header: qq.header } : {}),
        multiSelect: qq.multiSelect ?? false,
        options: qq.options.map((o) => ({
          label: o.label,
          ...(o.description !== undefined ? { description: o.description } : {}),
        })),
      }));
      pendingAUQ.delete(value.toolUseId);
      try {
        await handlePermissionResponseFromIM(
          entry.paneId,
          'allow',
          entry.replyCtx,
          `IM button click: ${opt.label}`,
          { questions: questionsPayload, answers },
        );
      } catch (err) {
        onError(err, { phase: 'cardActionAUQDeliver', paneId: entry.paneId });
        return { toast: { type: 'error', content: '回答投递失败' } };
      }
      return { toast: { type: 'success', content: `已回答: ${opt.label}` } };
    }
    // `kind:'permission'` lands in P4 — log + acknowledge for now.
    log(`[card.action] kind=${value.kind} not yet wired (P4 work)`);
    return {};
  }

  const imHandler: IMHandler = {
    onMessage: handleInbound,
    onCardAction: handleCardAction,
    async onError(err) {
      onError(err, { phase: 'imAdapter' });
    },
  };

  // ============================================================================
  // Outbound: cc Stop → IM send via stored replyCtx
  // ============================================================================

  async function handleStop(
    p: StopPayload & { paneId: PaneId; termId?: TerminalId },
  ): Promise<HookDecision | void> {
    const { paneId } = p;

    // Per-terminal IMWork gate (issue 378). Stop files written by hook
    // subprocess carry `termId` so we don't have to re-derive it from
    // `typeof paneId` (would be brittle for any future detector with
    // colliding id format). The `termId` field is optional only for
    // back-compat with pre-378 Stop files left on disk during upgrade;
    // missing = skip (the corresponding `IM<TermType>` file definitely
    // doesn't exist either, so the effect is identical).
    if (p.termId === undefined) {
      log(`[Stop pane=${paneId}] legacy Stop file missing termId, skip forward`);
      return;
    }
    if (!(await existsIMWorkFile(opts.stateDir, p.termId))) {
      // Log surface keeps "IMWork off" substring for back-compat with
      // log-grep dashboards + tests; appends the per-terminal filename
      // suffix for issue-378 traceability.
      log(
        `[Stop pane=${paneId}] IMWork off (IM${p.termId[0]!.toUpperCase()}${p.termId.slice(1)}), skip forward`,
      );
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
      const me = panes.find((pi) => (pi.paneId) === paneId);
      if (me && me.title.length > 0) prefix = me.title;
    } catch (err) {
      onError(err, { phase: 'forwardStopListPanes', paneId });
    }

    log(
      `[cc → IM] ${prefix} reply='${truncate(p.last_assistant_message, 80)}'`,
    );
    // Source-tag carried as metadata, not baked into content: when the
    // adapter splits the reply across multiple IM messages (Lark
    // FEISHU_CARD_TABLE_LIMIT) the tag must appear on every chunk —
    // a single baked `[${prefix}]\n` only survived chunk[0]. Per
    // [project_future_im_adapters] + reference_feishu_cardkit_limits.
    try {
      await opts.imAdapter.send(p.last_assistant_message, replyCtx, {
        sourceTag: prefix,
      });
    } catch (err) {
      onError(err, { phase: 'forwardStop', paneId });
    }
  }

  // ============================================================================
  // Permission response: IM user replied `#<tab> /1` (allow) or `/2` (deny)
  // ============================================================================

  async function handlePermissionResponseFromIM(
    paneId: PaneId,
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
    /**
     * Optional `{questions, answers}` payload for the AskUserQuestion
     * answer-inject channel (DD §9.3 R7). Only present on the AUQ AI
     * path; forwarded verbatim to `writePermissionResponseFile` so cc's
     * PreToolUse hook output carries `updatedInput`.
     */
    updatedInput?: Record<string, unknown>,
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
      // Dead-drop case (DD §9.5): hook has already exited (timeout at
      // 110s + reaper cleaned the Request file). User's IM reply arrived
      // after cc gave up waiting. Tell the user explicitly so they don't
      // assume the answer landed; the previous "❌ no pending tool" was
      // ambiguous between "you never had a pending" and "cc timed out".
      log(`[PermissionResponse pane=${paneId}] dead-drop — hook already exited`);
      try {
        await opts.imAdapter.send(
          '⏱ cc 已超时，本轮不再等待你的回复（默认空答案已发给 cc）。',
          replyCtx,
        );
      } catch (err) {
        onError(err, { phase: 'permissionResponseEcho', paneId });
      }
      return;
    }

    for (const p of pending) {
      log(
        `[PermissionResponse pane=${paneId} sid=${p.sessionId.slice(0, 8)}] ${decision} request ${p.requestId}${updatedInput !== undefined ? ' +updatedInput' : ''}`,
      );
      try {
        if (decision === 'allow') {
          await writePermissionResponseFile({
            stateDir: opts.stateDir,
            paneId: p.paneId,
            sessionId: p.sessionId,
            requestId: p.requestId,
            decision: 'allow',
            ...(updatedInput !== undefined ? { updatedInput } : {}),
            ...(reason !== undefined ? { reason } : { reason: 'IM user replied /1' }),
          });
        } else {
          await writePermissionResponseFile({
            stateDir: opts.stateDir,
            paneId: p.paneId,
            sessionId: p.sessionId,
            requestId: p.requestId,
            decision: 'deny',
            reason: reason ?? 'IM user replied /2',
          });
        }
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
  // PermissionDialog response: AI-matched reply to cc PermissionRequest hook
  // (sensitive-path dialog) — daemon resolves appliedSuggestionIndex into
  // the pending Request's permission_suggestions[index-1] and writes the
  // Response. Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
  // ============================================================================

  async function handlePermissionDialogResponseFromIM(
    paneId: PaneId,
    answer: import('@multi-cc-im/shared').PermissionDialogAnswer,
    replyCtx: IMReplyContext,
  ): Promise<void> {
    // Find pending PermissionDialog Request for this paneId. cc serializes
    // its hooks so we expect 0 or 1 pending.
    let entries: string[];
    try {
      entries = await readdir(opts.stateDir);
    } catch (err) {
      onError(err, { phase: 'permissionDialogResponseListDir', paneId });
      return;
    }
    const pending = entries
      .map((name) => parsePermissionDialogFilename(name))
      .filter(
        (
          x,
        ): x is NonNullable<ReturnType<typeof parsePermissionDialogFilename>> =>
          x !== null && x.paneId === paneId && x.kind === 'request',
      );

    if (pending.length === 0) {
      // Dead-drop: hook already exited (110s timeout reached + reaper).
      // User's IM reply arrived too late. Notify so they don't assume
      // the answer landed; mirror v1.9 AUQ dead-drop pattern.
      log(
        `[PermissionDialogResponse pane=${paneId}] dead-drop — hook already exited`,
      );
      try {
        await opts.imAdapter.send(
          '⏱ cc 已超时，本轮不再等待你的 PermissionDialog 回复（hook 已默认放行，cc 可能弹了 TUI dialog）。',
          replyCtx,
        );
      } catch (err) {
        onError(err, { phase: 'permissionDialogResponseDeadDropEcho', paneId });
      }
      return;
    }

    for (const p of pending) {
      // Load the Request to resolve appliedSuggestionIndex (1-based) into
      // the actual cc PermissionUpdate object the AI router picked from
      // the suggestions list.
      let updatedPermissions: unknown[] | undefined;
      let message: string | undefined;
      if (answer.behavior === 'allow') {
        if (answer.appliedSuggestionIndex !== undefined) {
          const reqPath = permissionDialogRequestPath({
            stateDir: opts.stateDir,
            paneId: p.paneId,
            sessionId: p.sessionId,
            requestId: p.requestId,
          });
          const reqBody = await readPermissionDialogRequestFile(reqPath);
          if (reqBody) {
            const idx = answer.appliedSuggestionIndex;
            const suggestion = reqBody.permissionSuggestions[idx - 1];
            if (suggestion !== undefined) {
              updatedPermissions = [suggestion];
            } else {
              // Index out of range despite router clamp — defensive log,
              // proceed as single-yes (no updatedPermissions written).
              log(
                `[PermissionDialogResponse pane=${paneId} reqId=${p.requestId}] appliedSuggestionIndex=${idx} out of range (${reqBody.permissionSuggestions.length} suggestions); degrading to single-yes`,
              );
            }
          }
        }
      } else {
        message = answer.message;
      }

      log(
        `[PermissionDialogResponse pane=${paneId} sid=${p.sessionId.slice(0, 8)}] ${answer.behavior}${updatedPermissions ? ' +updatedPermissions' : ''}${message ? ` message="${truncate(message, 40)}"` : ''}`,
      );

      try {
        if (answer.behavior === 'allow') {
          await writePermissionDialogResponseFile({
            stateDir: opts.stateDir,
            paneId: p.paneId,
            sessionId: p.sessionId,
            requestId: p.requestId,
            decision: {
              behavior: 'allow',
              ...(updatedPermissions !== undefined
                ? { updatedPermissions }
                : {}),
            },
          });
        } else {
          await writePermissionDialogResponseFile({
            stateDir: opts.stateDir,
            paneId: p.paneId,
            sessionId: p.sessionId,
            requestId: p.requestId,
            decision: {
              behavior: 'deny',
              ...(message !== undefined ? { message } : {}),
            },
          });
        }
      } catch (err) {
        onError(err, {
          phase: 'permissionDialogResponseWrite',
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
    p: PreToolUsePayload & { requestId: string; paneId: PaneId },
  ): Promise<void> {
    const { paneId } = p;

    // Schedule reaper FIRST regardless of forward outcome. Per-tool delay
    // (2026-05-12 root-cause fix): AskUserQuestion holds the hook for up
    // to 290s; if the reaper fires at the regular 30s it unlinks the
    // live Request file while the hook is still polling for IM reply,
    // and force-permission mode then misroutes the answer as a new task.
    scheduleReaper({
      paneId,
      sessionId: p.session_id,
      requestId: p.requestId,
      toolName: p.tool_name,
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
      const me = panes.find((pi) => (pi.paneId) === paneId);
      if (me && me.title.length > 0) tabName = me.title;
    } catch (err) {
      onError(err, { phase: 'preToolUseListPanes', paneId });
    }

    // AskUserQuestion is special-cased per DD AskUserQuestion §6 P3:
    // numbered-options format instead of allow/deny semantics (the
    // /1 = 允许 /2 = 拒绝 vocabulary doesn't fit "pick option N"). The
    // hook-receiver side (P2) makes sure we get here even in auto mode.
    if (p.tool_name === 'AskUserQuestion') {
      // Try the button-card path when the adapter supports it (lark
      // implements `sendAUQ`, future tg/wechat may not). Fall back to
      // the legacy text path (numbered list + user types `/1` etc.)
      // when capability absent. Per DD γ P5 2026-05-19.
      // **toolUseId source** (2026-05-19 fix): cc fires PreToolUse hook
      // BEFORE allocating the real `tool_use_id` for AskUserQuestion calls
      // — `p.tool_use_id` was observed empty-string in real account smoke
      // (raw `card.action.trigger` evidence:
      //  `"value":{"kind":"auq","optionIdx":0,"questionIdx":0,"toolUseId":""}`).
      // The empty string propagated into the Lark card button value and
      // back through the click event → tripped our
      // `CardActionValueSchema.toolUseId: z.string().min(1)` invariant
      // (`too_small / String must contain at least 1 character(s)`).
      //
      // We mint a daemon-side nonce instead. `pendingAUQ` keys on it,
      // the card carries it as the click-back identifier, click handling
      // resolves (paneId, replyCtx, questions) from the map. Cc's empty
      // `tool_use_id` is no longer load-bearing.
      const auqNonce = randomUUID();
      const auqReq = buildAUQRequest({
        toolUseId: auqNonce,
        tabName,
        toolInput: p.tool_input,
      });
      const supportsAUQButton =
        'sendAUQ' in opts.imAdapter &&
        typeof (opts.imAdapter as unknown as IMAUQSender).sendAUQ === 'function';
      log(
        `[AskUserQuestion forward pane=${paneId} tab=${tabName}] questions=${auqReq.questions.length} path=${supportsAUQButton ? 'button' : 'text'}`,
      );
      try {
        if (supportsAUQButton && auqReq.questions.length > 0) {
          // Register pending entry BEFORE send so a click that races
          // back ahead of the local promise resolution still resolves.
          pendingAUQ.set(auqReq.toolUseId, {
            paneId,
            replyCtx,
            questions: auqReq.questions,
            tabName,
          });
          try {
            await (opts.imAdapter as unknown as IMAUQSender).sendAUQ(
              auqReq,
              replyCtx,
              { sourceTag: tabName },
            );
          } catch (sendErr) {
            pendingAUQ.delete(auqReq.toolUseId);
            throw sendErr;
          }
        } else {
          const { body } = formatAskUserQuestionPrompt({
            tabName,
            toolInput: p.tool_input,
          });
          await opts.imAdapter.send(body, replyCtx, { sourceTag: tabName });
        }
      } catch (err) {
        onError(err, { phase: 'preToolUseAskQuestionForward', paneId });
      }
      return;
    }

    const summary = summarizeToolInput(p.tool_name, p.tool_input);
    const body =
      `准备跑工具:\n  ${p.tool_name}(${summary})\n\n` +
      `⏳ 10 秒内回复，否则默认放行:\n` +
      `  #${tabName} /1   = 允许\n` +
      `  #${tabName} /2   = 拒绝`;

    log(`[PreToolUse pane=${paneId}] ask IM: ${p.tool_name}(${truncate(summary, 40)})`);
    try {
      await opts.imAdapter.send(body, replyCtx, { sourceTag: tabName });
    } catch (err) {
      onError(err, { phase: 'preToolUseAsk', paneId });
    }
  }

  /**
   * Format a cc AskUserQuestion `tool_input` into a numbered-options IM
   * prompt per DD AskUserQuestion §6 P3 D3. Schema: `tool_input.questions`
   * is an array of `{question, header?, multiSelect?, options: [{label,
   * description?}]}`. We render the first question's options only — multi-
   * question is rare and a clean numbered list per question would
   * complicate IM reply parsing. Multi-question payloads emit a note
   * pointing the user to cc TUI for the rest.
   *
   * Defensive: any shape mismatch (no `questions` array, empty array,
   * missing `options`, etc.) returns a one-liner pointing to cc TUI. Throw-
   * free; preserves the daemon's "no exception in event handler" contract.
   */
  /**
   * Parse cc's `AskUserQuestion` `tool_input` into the typed
   * `IMAUQRequest` the button-card path needs. Mirrors the defensive
   * parsing of `formatAskUserQuestionPrompt` — any shape mismatch
   * yields an empty `questions: []` so the caller falls back to the
   * text path (which also tolerates malformed input).
   *
   * Per DD γ P5 2026-05-19.
   */
  function buildAUQRequest(o: {
    toolUseId: string;
    tabName: string;
    toolInput: Record<string, unknown>;
  }): IMAUQRequest {
    const raw = o.toolInput.questions;
    if (!Array.isArray(raw)) {
      return { toolUseId: o.toolUseId, tabName: o.tabName, questions: [] };
    }
    const questions: IMAUQQuestion[] = [];
    raw.forEach((q, questionIdx) => {
      const qq = q as {
        question?: unknown;
        header?: unknown;
        multiSelect?: unknown;
        options?: unknown;
      };
      const text = typeof qq.question === 'string' ? qq.question : '';
      if (text.length === 0) return;
      const optionsRaw = Array.isArray(qq.options) ? qq.options : [];
      const options = optionsRaw
        .map((opt) => {
          const oo = opt as { label?: unknown; description?: unknown };
          const label = typeof oo.label === 'string' ? oo.label : '';
          if (label.length === 0) return null;
          return typeof oo.description === 'string' && oo.description.length > 0
            ? { label, description: oo.description }
            : { label };
        })
        .filter((x): x is { label: string; description?: string } => x !== null);
      if (options.length === 0) return;
      const question: IMAUQQuestion = {
        questionIdx,
        text,
        multiSelect: qq.multiSelect === true,
        options,
      };
      if (typeof qq.header === 'string' && qq.header.length > 0) {
        question.header = qq.header;
      }
      questions.push(question);
    });
    return { toolUseId: o.toolUseId, tabName: o.tabName, questions };
  }

  function formatAskUserQuestionPrompt(opts: {
    tabName: string;
    toolInput: Record<string, unknown>;
  }): { body: string; optionCount: number; questionCount: number } {
    const questionsRaw = opts.toolInput.questions;
    if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) {
      return {
        body: `cc 想问你一个问题，但消息格式异常 — 请到 cc TUI 里直接回答。`,
        optionCount: 0,
        questionCount: 0,
      };
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

    const lines: string[] = [
      `cc 想问你:`,
      '',
      questionText,
      '',
    ];
    options.forEach((opt, i) => {
      const o = opt as { label?: unknown; description?: unknown };
      const label = typeof o.label === 'string' ? o.label : `option ${i + 1}`;
      lines.push(`  ${i + 1}. ${label}`);
      if (typeof o.description === 'string' && o.description.length > 0) {
        lines.push(`     ${o.description}`);
      }
    });
    // Free-text fallback option (D6 — any natural text accepted).
    lines.push(`  ${options.length + 1}. 你的考虑（自由文本）`);
    lines.push('');
    lines.push('请回复你的选择（编号或自然语言都行）');

    if (questionsRaw.length > 1) {
      lines.push('');
      lines.push(
        `（cc 共问了 ${questionsRaw.length} 个问题，IM 只显示第 1 个；要全部回答请在 cc TUI 操作）`,
      );
    }

    return {
      body: lines.join('\n'),
      optionCount: options.length,
      questionCount: questionsRaw.length,
    };
  }

  // ============================================================================
  // Reaper: backstop unlink for orphan PermissionRequest/Response files
  // ============================================================================

  function scheduleReaper(o: {
    paneId: PaneId;
    sessionId: string;
    requestId: string;
    toolName: string;
    /**
     * Which IPC file pair this reaper protects. 'permission' for PreToolUse
     * (`<paneId>_<sid>.PermissionRequest/Response.*`); 'permission-dialog'
     * for PermissionRequest (`<paneId>_<sid>.PermissionDialogRequest/Response.*`,
     * per DD 2026-05-13). Default 'permission' (backward-compat with existing
     * callsite).
     */
    kind?: 'permission' | 'permission-dialog';
  }): void {
    const kind = o.kind ?? 'permission';
    const key = `${kind}:${o.paneId}:${o.sessionId}:${o.requestId}`;
    const prev = reaperTimers.get(key);
    if (prev !== undefined) clearTimeout(prev);

    // Per-tool / per-kind reaper delay.
    // - PermissionDialog (any tool) → 130s (mirror AUQ; hook holds 110s)
    // - PreToolUse AskUserQuestion → 130s (special-cased, holds 110s)
    // - PreToolUse other tools → 30s (regular IM permission gate)
    const delay =
      kind === 'permission-dialog'
        ? permissionDialogReaperDelayMs
        : o.toolName === ASK_USER_QUESTION_TOOL_NAME
          ? askUserQuestionReaperDelayMs
          : reaperDelayMs;

    const timer = setTimeout(async () => {
      reaperTimers.delete(key);
      // Diagnostic log — without this, the previous silent unlink made
      // the v1.10 force-permission breakage (real-account smoke
      // 2026-05-12) opaque. Now `[reaper] unlink ...` appearing BEFORE
      // a user's IM reply is the smoking gun for "reaper delay too
      // short for this tool".
      log(
        `[reaper] unlink kind=${kind} pane=${o.paneId} sid=${o.sessionId.slice(0, 8)} reqId=${o.requestId} tool=${o.toolName} delay=${delay}ms`,
      );
      const ioOpts = {
        stateDir: opts.stateDir,
        paneId: o.paneId,
        sessionId: o.sessionId,
        requestId: o.requestId,
      };
      const reqPath =
        kind === 'permission-dialog'
          ? permissionDialogRequestPath(ioOpts)
          : permissionRequestPath(ioOpts);
      const respPath =
        kind === 'permission-dialog'
          ? permissionDialogResponsePath(ioOpts)
          : permissionResponsePath(ioOpts);
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
    }, delay);
    reaperTimers.set(key, timer);
  }

  // ============================================================================
  // PermissionRequest (cc sensitive-path dialog hook event)
  // ============================================================================

  /**
   * Handle cc's PermissionRequest hook event (fires when cc's internal
   * gates decided to render a TUI permission dialog — e.g. `.claude/*`
   * sensitive-path edits). Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md):
   *
   * - `/start auto` (IMWork.auto=true) → silent emit single-yes allow
   *   `{decision: {behavior: 'allow'}}` (no `updatedPermissions` — D2-A
   *   protects per-call visibility) + fire IM audit notification per D5-B.
   * - `/start off` (IMWork.auto=false) → forward to IM with cc's
   *   `permission_suggestions` rendered as numbered options. **P5 scope
   *   currently leaves this path silent** (hook will timeout-allow at
   *   110s → cc falls back to TUI dialog as baseline). P6+P7 will wire
   *   ai-router prompt + router branch + RouterPermissionDialogResponse
   *   to complete the off-mode flow.
   * - IMWork off entirely (file absent) → silent skip (hook should have
   *   silent-exited too; race-condition defensive only).
   */
  async function handlePermissionDialog(
    p: PermissionRequestPayload & { requestId: string; paneId: PaneId },
  ): Promise<void> {
    const { paneId } = p;

    // Schedule reaper FIRST (mirror PreToolUse).
    scheduleReaper({
      paneId,
      sessionId: p.session_id,
      requestId: p.requestId,
      toolName: p.tool_name,
      kind: 'permission-dialog',
    });

    // Read IMOrigin (race defensive — hook E2 should have short-circuited).
    let replyCtx: IMReplyContext | null;
    try {
      replyCtx = await readIMOriginFile(opts.stateDir);
    } catch (err) {
      onError(err, { phase: 'permissionDialogReadIMOrigin', paneId });
      return;
    }
    if (replyCtx === null) {
      log(`[PermissionDialog pane=${paneId}] no IMOrigin (race) — skip forward`);
      return;
    }

    // Read IMWork (race defensive — hook E1 should have short-circuited).
    const imWork = await readIMWorkFile(opts.stateDir, activeTerminalId).catch(
      (err) => {
        onError(err, { phase: 'permissionDialogReadIMWork', paneId });
        return null;
      },
    );
    if (imWork === null) {
      log(
        `[PermissionDialog pane=${paneId}] IMWork off (race) — skip; hook will timeout-allow`,
      );
      return;
    }

    // Resolve friendly tab name (for audit log + future IM forward).
    let tabName = `(pane ${paneId})`;
    try {
      const panes = await opts.termAdapter.listPanes();
      const me = panes.find(
        (pi) => (pi.paneId) === paneId,
      );
      if (me && me.title.length > 0) tabName = me.title;
    } catch (err) {
      onError(err, { phase: 'permissionDialogListPanes', paneId });
    }

    const pathSummary = inferSensitivePathFromToolInput(p.tool_input);
    log(
      `[PermissionDialog forward pane=${paneId} tab=${tabName} path=${truncate(pathSummary, 60)}] auto=${imWork.auto}`,
    );

    if (imWork.auto) {
      // D2-A: silent emit single-yes allow — no updatedPermissions so
      // cc's sensitive gate still gates subsequent same-session edits
      // (protects per-call visibility, no silent session-wide grant).
      try {
        await writePermissionDialogResponseFile({
          stateDir: opts.stateDir,
          paneId,
          sessionId: p.session_id,
          requestId: p.requestId,
          decision: { behavior: 'allow' },
        });
      } catch (err) {
        onError(err, {
          phase: 'permissionDialogWriteAutoAllow',
          paneId,
          sessionId: p.session_id,
        });
        return;
      }
      // D5-B: IM audit log notification (no user action required).
      try {
        await opts.imAdapter.send(
          `🛡️ daemon auto-allowed cc 编辑敏感路径\n  ${tabName}: ${truncate(pathSummary, 80)}`,
          replyCtx,
        );
      } catch (err) {
        onError(err, { phase: 'permissionDialogIMAudit', paneId });
      }
      return;
    }

    // IMWork.auto=false → /start off mode (DD 2026-05-13 P7). Format
    // numbered options from cc's permission_suggestions verbatim per D4
    // + forward to IM. User's plain reply triggers handlePlainWithAI →
    // PermissionDialog branch → ai-router → handlePermissionDialogResponseFromIM
    // which resolves the chosen suggestion + writes the Response file.
    const body = formatPermissionDialogPrompt({
      tabName,
      toolName: p.tool_name,
      toolInputSummary: pathSummary,
      permissionSuggestions: p.permission_suggestions ?? [],
    });
    try {
      await opts.imAdapter.send(body, replyCtx, { sourceTag: tabName });
    } catch (err) {
      onError(err, { phase: 'permissionDialogForward', paneId });
    }
  }

  /**
   * Format the IM message shown to the user when cc fires a sensitive-
   * path PermissionRequest dialog in /start off mode. Mirrors v1.9 AUQ
   * P3 D3 numbered-options style; uses cc's `permission_suggestions`
   * verbatim (option labels = cc's own `rules[0].ruleContent`).
   */
  function formatPermissionDialogPrompt(o: {
    tabName: string;
    toolName: string;
    toolInputSummary: string;
    permissionSuggestions: readonly unknown[];
  }): string {
    const lines: string[] = [
      `cc 想编辑敏感路径:`,
      `  ${o.toolName}: ${truncate(o.toolInputSummary, 80)}`,
      '',
      '  1. 同意一次（仅本次调用）',
    ];
    // Indices 2..N+1 are "always allow <suggestion>" entries.
    o.permissionSuggestions.forEach((s, i) => {
      const label = inferSuggestionLabel(s);
      lines.push(`  ${i + 2}. 始终允许: ${truncate(label, 80)}`);
    });
    if (o.permissionSuggestions.length === 0) {
      lines.push('  （cc 没给 always-allow 建议；只能回 1 或 N 拒绝）');
    }
    lines.push(`  ${o.permissionSuggestions.length + 2}. 拒绝`);
    lines.push('');
    lines.push('回复方式（任选其一）:');
    lines.push(`  #${o.tabName} /1   = 同意一次`);
    lines.push(`  #${o.tabName} /2   = 拒绝`);
    lines.push('  或直接发数字 / 自然语言（"1" / "好" / "选 2" / "拒绝"）');
    return lines.join('\n');
  }

  /**
   * Extract a human-readable label from one cc `permission_suggestions`
   * entry (PermissionUpdate). Mirrors `summarizePermissionSuggestion`
   * in ai-router (kept in two places so router + orchestrator stay
   * independent — both are small).
   */
  function inferSuggestionLabel(s: unknown): string {
    if (typeof s !== 'object' || s === null) return '<unknown>';
    const sug = s as Record<string, unknown>;
    if (Array.isArray(sug.rules) && sug.rules.length > 0) {
      const first = sug.rules[0];
      if (typeof first === 'object' && first !== null) {
        const rule = first as Record<string, unknown>;
        if (
          typeof rule.ruleContent === 'string' &&
          rule.ruleContent.length > 0
        ) {
          return rule.ruleContent;
        }
      }
    }
    const t = typeof sug.type === 'string' ? sug.type : '?';
    const d = typeof sug.destination === 'string' ? sug.destination : '?';
    return `${t}/${d}`;
  }

  /**
   * Best-effort extract of the sensitive path from cc's tool_input.
   * Different tools put the path under different keys:
   *   - Edit / Write / Read → `file_path`
   *   - Bash → `command` (path is somewhere inside the command string)
   *   - other → fall back to JSON-stringified summary
   * Used in audit log + IM notification. Truncated by caller.
   */
  function inferSensitivePathFromToolInput(
    input: Record<string, unknown>,
  ): string {
    const filePath = input.file_path;
    if (typeof filePath === 'string' && filePath.length > 0) return filePath;
    const path = input.path;
    if (typeof path === 'string' && path.length > 0) return path;
    const command = input.command;
    if (typeof command === 'string' && command.length > 0) return command;
    return '<unknown path>';
  }

  const cliHandler: CLIHandler = {
    async onPreToolUse(p): Promise<void> {
      return handlePreToolUse(p);
    },
    async onPermissionDialog(p): Promise<void> {
      return handlePermissionDialog(p);
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
      await deleteIMWorkFile(opts.stateDir, activeTerminalId).catch((err) => {
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
