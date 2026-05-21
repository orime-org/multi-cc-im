import type {
  AskUserQuestionToolInput,
  IncomingMessage,
  PaneId,
  PermissionDialogAnswer,
} from '@multi-cc-im/shared';
import { AskUserQuestionToolInputSchema } from '@multi-cc-im/shared';
import type {
  AIAskUserQuestionResult,
  AIPermissionDialogResult,
  AIPermissionResponse,
  AIRoutingOpts,
  AIRoutingResult,
  AskUserQuestionViaAIOpts,
  PendingAskUserQuestion,
  PendingPermissionDialog,
  PendingRequestForPrompt,
  PermissionRequestViaAIOpts,
} from './ai-router.js';
import { matchSession, type SessionInfo } from './matcher.js';
import { parse } from './parser.js';
import { truncate } from './text.js';

/**
 * One pending PreToolUse approval as the router receives it from the daemon
 * via DI. Mirrors `@multi-cc-im/cli-cc`'s `PendingPermissionRequest` shape
 * (kept local so this package doesn't pin to the cli-cc type and tests
 * stay framework-free).
 *
 * Per [DD: natural-language permission reply](../../../docs/superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) §9.1 P3.
 */
export interface RouterPendingRequest {
  paneId: PaneId;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
}

/**
 * One pending PermissionDialog (cc PermissionRequest hook event) as the
 * router receives it. Mirrors cli-cc's `PendingPermissionDialog` shape;
 * kept local so router stays framework-free.
 *
 * Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
 */
export interface RouterPendingDialog {
  paneId: PaneId;
  sessionId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionSuggestions: readonly unknown[];
  createdAt: number;
}

/**
 * Maximum visible characters for IM message excerpts and AI-routed intent
 * previews shown in echo lines. Long enough to be recognizable, short
 * enough not to dominate the IM UI when the daemon replies.
 */
const ECHO_EXCERPT_MAX = 20;

/**
 * Lookup interface for currently visible panes. Bridge orchestrator
 * implements this by calling `TermListPanes.listPanes()` directly (wezterm
 * cli list snapshot). Router stays IO-free / pure-function-ish.
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 * the panes returned here include any wezterm pane (zsh / vim / cc / etc.)
 * — daemon doesn't filter for cc-only. The matcher routes by user-set tab
 * title (cc `/rename`); panes without titles aren't IM-addressable.
 */
export interface PaneRegistry {
  listPanes(): Promise<readonly SessionInfo[]>;
}

/**
 * Persistent-ish state for last-explicit-mention sticky default. Bridge
 * orchestrator backs this with an in-memory ref. Sticky key is `paneId`
 * (per DD #61 — daemon no longer tracks sessionId; if cc dies + new cc
 * starts in same pane, paneId stays = sticky to "whatever cc is in pane X").
 */
export interface RouterState {
  getCurrent(): PaneId | null;
  setCurrent(paneId: PaneId | null): void;
}

export interface RouterOpts {
  registry: PaneRegistry;
  state: RouterState;
  /**
   * Whether `<stateDir>/IMWork` exists at the moment of routing.
   *   - `false` (default if omitted) → "talk to cc" messages (mention / plain /
   *     broadcast) are rejected with "IMWork off — please /start" hint
   *   - `true` → normal dispatch
   *
   * Bridge commands (bare `/list` `/start` etc.) and permission responses
   * (`#<tab> /1` `/2`) always work regardless of IMWork state.
   */
  imWorkOn?: boolean;
  /**
   * Current `IMWork.auto` value when `imWorkOn=true`. Used only by `/current`
   * echo to display the active mode (`auto-approve: ON | OFF`). Per
   * [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md).
   * Ignored when `imWorkOn=false`.
   */
  imWorkAuto?: boolean;
  /**
   * Active terminal-adapter id (`'wezterm'` or `'iterm2'`) at the moment
   * of routing. Surfaced in the `/start` echo as `✓ terminal: <id>` so
   * IM users can verify which adapter the daemon picked at startup.
   *
   * Per [DD: iTerm2 adapter P4](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md):
   * user requested this confirmation line because the term selection
   * happens once at daemon start and is otherwise invisible from the
   * IM side. When omitted, the line is suppressed (backward compatible
   * with tests pre-dating the iterm2 adapter).
   */
  terminalId?: 'wezterm' | 'iterm2';
  /**
   * AI-routed dispatch callback for plain (no-mention) messages. Per
   * [DD: AI-routed IM dispatch](../../../docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md):
   * orchestrator wires this to spawn a `claude --print` subprocess that
   * triages the message → returns `{target, intent, reason}`. If the AI
   * picks a tab, router routes the cleaned `intent` to that cc + sets
   * sticky `current` to it.
   *
   * **When omitted**: router falls back to the legacy sticky-current logic
   * (route to last-explicit-mention pane, or single cc if there's only one,
   * or echo "no current" hint). Useful for tests that don't want to mock cc
   * spawn, and as a degraded-mode fallback if AI routing is broken.
   */
  aiRouter?: (opts: AIRoutingOpts) => Promise<AIRoutingResult>;
  /**
   * Pending PreToolUse approvals at the moment of routing. The router
   * forwards this list (after mapping `paneId` → tab title) to `aiRouter`
   * so the AI can decide whether the plain IM message is a natural-
   * language permission reply ("multi-cc-im 那个我同意") rather than a
   * routing request.
   *
   * Bridge orchestrator wires this to `listPendingPermissionRequests`
   * from `@multi-cc-im/cli-cc` (P1). Per
   * [DD: natural-language permission reply](../../../docs/superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) §9.1 P3.
   *
   * **When omitted**: router skips the lookup entirely and `aiRouter` is
   * called WITHOUT `pendingRequests` — i.e. the prompt's PENDING block
   * never renders and AI behaves as before P2. Backward-compatible for
   * existing tests that don't care about the permission flow.
   */
  listPendingPermissionRequests?: () => Promise<readonly RouterPendingRequest[]>;
  /**
   * Pending PermissionDialog (cc PermissionRequest hook event) approvals.
   * Same role as `listPendingPermissionRequests` but for the sensitive-
   * path dialog flow. Bridge orchestrator wires this to
   * `listPendingPermissionDialogs` from `@multi-cc-im/cli-cc`.
   *
   * Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
   */
  listPendingPermissionDialogs?: () => Promise<readonly RouterPendingDialog[]>;
  /**
   * AskUserQuestion-specific AI router callback. Invoked when at least one
   * pending PreToolUse has `toolName === 'AskUserQuestion'` — the regular
   * routing / force-permission prompts don't handle AUQ (D5-D answer-
   * inject channel uses a separate `{questions, answers}` schema).
   *
   * Bridge orchestrator wires this to `routeAskUserQuestionViaAI` from
   * the ai-router module. Per [DD §9.6 R7](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md#96-implementation-plan-single-pr-after-this-dd-revision-lands).
   *
   * **When omitted**: AUQ branch falls back to writing an empty-answers
   * PermissionResponse so cc doesn't stall (defensive — tests without an
   * AUQ router still cover the orchestrator's response-write path).
   */
  aiAskUserQuestionRouter?: (
    opts: import('./ai-router.js').AskUserQuestionViaAIOpts,
  ) => Promise<import('./ai-router.js').AIAskUserQuestionResult | null>;
  /**
   * PermissionRequest-specific AI router callback. Invoked when any
   * pending PermissionDialog exists at the moment of routing. Mirror
   * `aiAskUserQuestionRouter` pattern. Orchestrator wires this to
   * `routePermissionRequestViaAI` from ai-router module.
   *
   * Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
   *
   * **When omitted**: PermissionDialog branch falls back to safe-default
   * deny so cc doesn't stall waiting for an answer that never comes.
   */
  aiPermissionRequestRouter?: (
    opts: PermissionRequestViaAIOpts,
  ) => Promise<AIPermissionDialogResult | null>;
}

export interface RouterDispatch {
  session: SessionInfo;
  /** Body to forward (post-mention parsing). */
  content: string;
}

/**
 * Permission response derived from one of two IM paths:
 *   1. Rigid syntax `#<tabname> /1` (allow) / `/2` (deny)
 *      — per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md)
 *   2. AI-matched natural-language reply ("multi-cc-im 那个我同意")
 *      — per [DD: natural-language permission reply](../../../docs/superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) §9.1 P3
 *
 * Orchestrator picks this up after `route()`, locates the session's pending
 * PermissionRequest file, and writes a matching PermissionResponse.
 *
 * `reason` is populated only on the AI path (the AI's short paraphrase of
 * the user's reply, flows into cc as `permissionDecisionReason`). The
 * rigid-syntax path leaves it `undefined`; orchestrator uses a default
 * string.
 */
export interface RouterPermissionResponse {
  session: SessionInfo;
  decision: 'allow' | 'deny';
  reason?: string;
  /**
   * Optional `{questions, answers}` payload for the AskUserQuestion
   * answer-inject path (DD §9.3). Orchestrator passes through to
   * `writePermissionResponseFile` so cc's PreToolUse hook output
   * carries `updatedInput` and treats the tool as completed
   * successfully with the user's answers. Undefined for all other
   * paths (generic allow/deny, AI-routed allow with just a reason).
   */
  updatedInput?: Record<string, unknown>;
}

/**
 * PermissionDialog (cc PermissionRequest hook event) reply derived from
 * an IM user message + AI dispatch. Orchestrator picks this up after
 * `route()`, locates the matching pending `PermissionDialogRequest`
 * file for `session.paneId`, resolves `appliedSuggestionIndex` into the
 * actual cc PermissionUpdate from the Request's `permissionSuggestions`,
 * and writes a `PermissionDialogResponse` file.
 *
 * Per [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
 */
export interface RouterPermissionDialogResponse {
  session: SessionInfo;
  /** Structured answer from AI (allow / allow+appliedSuggestionIndex / deny+message). */
  answer: PermissionDialogAnswer;
}

export interface RouterResult {
  /** Visible feedback to send back to the IM (per CLAUDE.md "routing visible echo required"). */
  echo: string;
  /** Sessions to forward `content` to. Empty for control commands / errors. */
  dispatches: RouterDispatch[];
  /** Set when the IM message was a `#<tabname> /1` or `/2` permission response. */
  permissionResponse?: RouterPermissionResponse;
  /**
   * Set when the IM message was a reply to a cc PermissionRequest dialog
   * (sensitive-path edit / similar internal cc ask gate). Orchestrator
   * resolves `answer.appliedSuggestionIndex` into the pending Request's
   * `permissionSuggestions[index-1]` and writes the on-disk Response.
   */
  permissionDialogResponse?: RouterPermissionDialogResponse;
  /**
   * Set when the IM user invoked bare `/start [off]` or `/stop`.
   * Orchestrator acts on it after `route()` returns: writes / deletes
   * `<stateDir>/IMWork`.
   * - `{kind:'enable', auto:false}` ← `/start`
   * - `{kind:'enable', auto:true}`  ← `/start auto` (per DD #64)
   * - `{kind:'disable'}`            ← `/stop`
   *
   * Always emitted on `/start`/`/stop` (no idempotent skip on re-run) — keeps
   * router pure and lets the user toggle modes (`/start` ↔ `/start auto`)
   * without router needing to know prior state.
   */
  imWorkAction?:
    | { kind: 'enable'; auto: boolean }
    | { kind: 'disable' };
  /**
   * Trace of the AI router's decision for plain (no-mention) messages.
   * Populated whenever `handlePlainWithAI` consulted the AI router —
   * regardless of whether the AI picked a target, fell back to
   * substring match, or failed entirely. Orchestrator logs this so
   * the user can iterate on the prompt without rebuilding the daemon.
   *
   * Per user smoke 2026-05-11: "需要把 CC 分诊错误打出来，理论上分诊不
   * 应该失败" — surface the AI's reason text in stderr so prompt
   * regressions are visible.
   *
   * Undefined when the message didn't go through `handlePlainWithAI`
   * (e.g. it was a `#<tab>` mention, bridge command, etc.).
   */
  aiTrace?: {
    /** What the AI picked as the target tab title, or null if it bailed. */
    target: string | null;
    /** What the AI extracted as the cleaned task description, or null. */
    intent: string | null;
    /** The AI's <15-word debugging note for its decision. */
    reason: string | null;
    /**
     * Set when the daemon's substring fallback kicked in because the AI
     * returned null. Helpful for spotting prompt-coverage gaps the
     * fallback is papering over.
     */
    fallback?: 'substring' | null;
    /**
     * Set when the AI matched the IM message to a pending PreToolUse
     * (DD §9.1 P3). When populated, the router emitted a
     * `RouterPermissionResponse` instead of a routing dispatch.
     * Orchestrator logs this via `[AI permission]` (D5-5).
     */
    permissionResponse?: AIPermissionResponse;
  };
}

/**
 * Route an IncomingMessage. High-level pipeline:
 *   1. parse text → ParsedMessage (parser.ts)
 *   2. handle bridge commands (bare /list /help /current /start /stop) — always pass IMWork gate
 *   3. handle permission_response (#<tab> /1 /2) — always pass IMWork gate
 *   4. IMWork gate: mention / plain / broadcast require IMWork on
 *   5. handle broadcast (#all) — fan out to all alive
 *   6. handle mention(s) — match each via 4-level fallback (matcher.ts)
 *   7. handle plain — dispatch to current_pane (sticky); auto-set when only 1 pane
 *
 * State invariants:
 *   - **Single-mention with body** updates `current_pane` (last-explicit)
 *   - **Multi-mention / #all / control / plain** does NOT update current
 *   - When `current_pane` is dead at routing time, auto-unset + error
 */
export async function route(
  incoming: IncomingMessage,
  opts: RouterOpts,
): Promise<RouterResult> {
  const sessions = await opts.registry.listPanes();
  const text = incoming.text;
  // Image-/attachment-only messages have no text — router has nothing to do
  // (orchestrator handles attachment forwarding separately based on its own
  // policy). Return empty result so caller can no-op text routing.
  if (text === null || text.trim().length === 0) {
    return { echo: '', dispatches: [] };
  }
  const parsed = parse(text);
  const imWorkOn = opts.imWorkOn ?? false;
  const imWorkAuto = opts.imWorkAuto ?? false;

  // IMWork gate: "talk to cc" message types require IMWork on. Bridge
  // commands (bare `/...`) + permission responses (`#<tab> /1` `/2`)
  // + parse errors always pass through.
  if (
    !imWorkOn &&
    (parsed.type === 'mention' ||
      parsed.type === 'plain' ||
      parsed.type === 'broadcast')
  ) {
    return {
      echo: '❌ IMWork off — 请先发 `/start` 开启 IM 模式',
      dispatches: [],
    };
  }

  switch (parsed.type) {
    case 'error':
      return { echo: `❌ ${parsed.message}`, dispatches: [] };

    case 'bridge_command':
      return handleBridgeCommand(
        parsed.command,
        parsed.args,
        sessions,
        opts.state,
        imWorkOn,
        imWorkAuto,
        opts.terminalId,
      );

    case 'broadcast':
      return handleBroadcast(parsed.body, sessions);

    case 'mention':
      return handleMention(parsed.mentions, parsed.body, sessions, opts.state);

    case 'plain':
      // Per [DD: AI-routed IM dispatch](../../../docs/superpowers/specs/2026-05-09-ai-routed-im-dispatch-dd.md):
      // when an aiRouter callback is wired (production default), all plain
      // messages go through it. Without an aiRouter (tests / degraded
      // fallback), use the legacy sticky-current logic. The AUQ-specific
      // branch (DD §9 R7) + PermissionDialog branch (DD 2026-05-13 P7) are
      // reached via handlePlainWithAI as well, so we also route through it
      // whenever any of the three AI callbacks is set.
      return opts.aiRouter ||
        opts.aiAskUserQuestionRouter ||
        opts.aiPermissionRequestRouter
        ? handlePlainWithAI(
            parsed.body,
            sessions,
            opts.state,
            opts.aiRouter,
            opts.listPendingPermissionRequests,
            opts.aiAskUserQuestionRouter,
            opts.listPendingPermissionDialogs,
            opts.aiPermissionRequestRouter,
            incoming.quotedMessage,
          )
        : handlePlain(parsed.body, sessions, opts.state);

    case 'permission_response': {
      // `#<tab> /1` and `#<tab> /2` rigid syntax serves BOTH channels:
      //   - PreToolUse PermissionRequest (v1.7): allow/deny generic tool
      //   - PermissionRequest hook event PermissionDialog (v1.12 DD 2026-05-13):
      //     sensitive-path edit dialog (.claude/* / .git/* / etc.)
      //
      // handlePermissionResponse below checks PermissionDialog pending
      // FIRST — if found, routes to v1.12 channel; otherwise falls back
      // to v1.7 generic permission path. Same UX from user's POV: any
      // pending gets answered with `#<tab> /1` (allow) or `/2` (deny).
      const dialogPendings: readonly RouterPendingDialog[] =
        opts.listPendingPermissionDialogs
          ? await opts.listPendingPermissionDialogs()
          : [];
      return handlePermissionResponse(
        parsed.tabName,
        parsed.decision,
        sessions,
        dialogPendings,
      );
    }
  }
}

// ============================================================================
// Permission response: #<tabname> /1 (allow) / #<tabname> /2 (deny)
// ============================================================================

function handlePermissionResponse(
  tabName: string,
  decision: 'allow' | 'deny',
  sessions: readonly SessionInfo[],
  dialogPendings: readonly RouterPendingDialog[],
): RouterResult {
  const result = matchSession(tabName, sessions);
  if (result.type === 'none') {
    return {
      echo: `❌ \`#${tabName}\` not found — no active session by that name`,
      dispatches: [],
    };
  }
  if (result.type === 'ambiguous') {
    return {
      echo: `❌ \`#${tabName}\` is ambiguous — matches: ${result.candidates
        .map(displayName)
        .join(', ')}. /rename one of them.`,
      dispatches: [],
    };
  }

  // Priority: PermissionDialog pending takes precedence over the v1.7
  // PreToolUse path. If the matched tab has a pending PermissionDialog,
  // route the user's `/1` `/2` into the PermissionDialog channel —
  // daemon will write a `PermissionDialogResponse` file (single-yes
  // allow / deny) rather than a `PermissionResponse` file. Mirrors the
  // handlePlainWithAI priority (PermissionDialog beats AUQ beats
  // force-perm beats routing).
  const dialogForTab = dialogPendings.find(
    (p) => (p.paneId as unknown as number) ===
      (result.session.paneId as unknown as number),
  );
  if (dialogForTab) {
    const verb = decision === 'allow' ? '同意一次' : '拒绝';
    return {
      echo: `→ ${displayName(result.session)} PermissionDialog ${verb}`,
      dispatches: [],
      permissionDialogResponse: {
        session: result.session,
        answer:
          decision === 'allow'
            ? { behavior: 'allow' } // single-yes (D2-A no updatedPermissions)
            : { behavior: 'deny', message: 'IM user replied /2' },
      },
    };
  }

  const verb = decision === 'allow' ? '允许' : '拒绝';
  return {
    echo: `→ ${displayName(result.session)} permission ${verb}`,
    dispatches: [],
    permissionResponse: { session: result.session, decision },
  };
}

// ============================================================================
// Plain (no #<name>): dispatch to current_pane
// ============================================================================

function handlePlain(
  body: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
): RouterResult {
  const namedSessions = sessions.filter((s) => s.tabTitle.length > 0);
  if (namedSessions.length === 0) {
    return {
      echo:
        '❌ no addressable cc — start cc in a wezterm tab and run `/rename <name>` inside it first',
      dispatches: [],
    };
  }

  const currentPaneId = state.getCurrent();

  if (currentPaneId !== null) {
    const current = namedSessions.find((s) => s.paneId === currentPaneId);
    if (!current) {
      state.setCurrent(null);
      return {
        echo: '⚠️ previous current pane disconnected, current cleared. Use `#<name>` to pick a target.',
        dispatches: [],
      };
    }
    return {
      echo: `→ ${displayName(current)}`,
      dispatches: [{ session: current, content: body }],
    };
  }

  if (namedSessions.length === 1) {
    const only = namedSessions[0]!;
    state.setCurrent(only.paneId);
    return {
      echo: `→ ${displayName(only)}`,
      dispatches: [{ session: only, content: body }],
    };
  }

  return {
    echo: '❌ no current session — send `#<name>` first or `/list`',
    dispatches: [],
  };
}

// ============================================================================
// Plain (no #<name>) with AI routing
// ============================================================================

async function handlePlainWithAI(
  body: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
  aiRouter:
    | ((opts: AIRoutingOpts) => Promise<AIRoutingResult>)
    | undefined,
  listPendingPermissionRequests:
    | (() => Promise<readonly RouterPendingRequest[]>)
    | undefined,
  aiAskUserQuestionRouter:
    | ((opts: AskUserQuestionViaAIOpts) => Promise<AIAskUserQuestionResult | null>)
    | undefined,
  listPendingPermissionDialogs:
    | (() => Promise<readonly RouterPendingDialog[]>)
    | undefined,
  aiPermissionRequestRouter:
    | ((opts: PermissionRequestViaAIOpts) => Promise<AIPermissionDialogResult | null>)
    | undefined,
  quotedMessage?: IncomingMessage['quotedMessage'],
): Promise<RouterResult> {
  const namedSessions = sessions.filter((s) => s.tabTitle.length > 0);
  if (namedSessions.length === 0) {
    return {
      echo:
        '❌ no addressable cc — start cc in a wezterm tab and run `/rename <name>` inside it first',
      dispatches: [],
    };
  }

  const currentPaneId = state.getCurrent();
  const currentTab =
    currentPaneId !== null
      ? namedSessions.find((s) => s.paneId === currentPaneId)?.tabTitle ?? null
      : null;

  // PermissionDialog pendings have priority over all other branches —
  // cc's protocol layer is genuinely blocked at a TUI ask gate, so any
  // plain reply at this moment MUST be the dialog answer (not a routing
  // request / not an AUQ answer / not a generic permission reply). Per
  // [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md) §6 P7.
  const dialogPendings: readonly RouterPendingDialog[] =
    listPendingPermissionDialogs ? await listPendingPermissionDialogs() : [];
  if (dialogPendings.length > 0) {
    return handlePermissionDialogReply(
      body,
      dialogPendings,
      namedSessions,
      aiPermissionRequestRouter,
    );
  }

  // Map cli-cc pending records (paneId-keyed IPC shape) → prompt records
  // (tabName-keyed). Pendings for dead panes are silently dropped so the
  // AI never sees a tab it can't approve. If the lookup callback is
  // omitted entirely, we pass `undefined` — the prompt's PENDING block
  // is gated on this and won't render (P2 semantic: empty array still
  // renders an empty block; undefined skips it).
  const pendingForPrompt: readonly PendingRequestForPrompt[] | undefined =
    listPendingPermissionRequests
      ? mapPendingToPrompt(
          await listPendingPermissionRequests(),
          namedSessions,
        )
      : undefined;

  // Partition AUQ pendings out — they flow through a separate AI path
  // (`aiAskUserQuestionRouter`) with a structured per-question answer
  // schema. Per DD §9.6 R7: when an AUQ is pending, the user's plain
  // message MUST be an AUQ answer (cc's protocol doesn't accept new
  // task prompts while AUQ is in-flight); we never mix AUQ pendings
  // into the routing / force-permission prompt body.
  const auqPendings: readonly PendingAskUserQuestion[] = pendingForPrompt
    ? mapPendingToAskUserQuestion(pendingForPrompt)
    : [];
  const regularPendingForPrompt: readonly PendingRequestForPrompt[] | undefined =
    pendingForPrompt === undefined
      ? undefined
      : pendingForPrompt.filter((p) => p.toolName !== 'AskUserQuestion');

  if (auqPendings.length > 0) {
    return handleAskUserQuestionReply(
      body,
      auqPendings,
      namedSessions,
      aiAskUserQuestionRouter,
    );
  }

  // No AUQ pending → need the regular aiRouter to handle routing /
  // force-permission. If only the AUQ router was wired, fall back to
  // legacy sticky-current routing for non-AUQ pendings.
  if (!aiRouter) {
    return handlePlain(body, sessions, state);
  }

  // Force-permission mode (v1.10, 2026-05-12): when ANY regular tool
  // pending is on disk, cc's protocol won't accept a new task prompt —
  // routing is moot. Pass forcePermissionMode=true to ai-router so it
  // skips routing rules entirely; router below ignores top-level
  // target/intent in this mode (uses ONLY permissionResponse for
  // dispatch). AUQ pendings already partitioned above never reach here.
  const isForcePermissionMode =
    regularPendingForPrompt !== undefined &&
    regularPendingForPrompt.length > 0;

  const result = await aiRouter({
    userMsg: body,
    quotedMessage,
    tabs: namedSessions.map((s) => s.tabTitle),
    currentTab,
    pendingRequests: regularPendingForPrompt,
    forcePermissionMode: isForcePermissionMode,
  });

  // Capture AI decision for the orchestrator to log. Per user smoke
  // 2026-05-11 — "理论上分诊不应该失败"; surfacing the reason in stderr
  // lets the user iterate on the prompt without rebuilding.
  const baseTrace: NonNullable<RouterResult['aiTrace']> = result.permissionResponse
    ? {
        target: result.target,
        intent: result.intent,
        reason: result.reason,
        permissionResponse: result.permissionResponse,
      }
    : {
        target: result.target,
        intent: result.intent,
        reason: result.reason,
      };

  // Force-permission mode: AI MUST have emitted `permissionResponse`. If
  // not (AI bug / prompt mis-follow), echo a defensive error rather than
  // fall through to routing — routing during pending PreToolUse would
  // write user's msg as a NEW task while cc is waiting on its tool call,
  // out-of-protocol. Top-level target/intent are NEVER consulted in this
  // mode (v1.10, 2026-05-12 DD).
  if (isForcePermissionMode) {
    if (result.permissionResponse === null) {
      return {
        echo:
          `❌ AI 未正确识别回复 (force-permission mode 期望 permissionResponse 但未填)\n` +
          `   原话: 「${truncate(body, ECHO_EXCERPT_MAX)}」\n` +
          `   请再试一次，或用 #<tab> /1 /2 显式审批`,
        dispatches: [],
        aiTrace: baseTrace,
      };
    }
    return handleAIPermissionReply(
      body,
      result.permissionResponse,
      namedSessions,
      baseTrace,
    );
  }

  // Permission-reply path (DD §9.1 P3, non-force). Short-circuit before
  // routing — even if AI also set top-level target/intent, treat the
  // message as a permission reply since the prompt declares the two
  // outputs mutually exclusive (permissionResponse wins on protocol
  // mismatch).
  if (result.permissionResponse !== null) {
    return handleAIPermissionReply(
      body,
      result.permissionResponse,
      namedSessions,
      baseTrace,
    );
  }

  const availableTabs = namedSessions.map((s) => `#${s.tabTitle}`).join(', ');

  if (result.target === null || result.intent === null) {
    // Deterministic substring fallback — try matching the message text
    // against tab names with the same leniency the AI prompt promises
    // (case-insensitive, ignore hyphens / underscores / whitespace).
    // Per user smoke 2026-05-11: the AI sometimes bails on cases where
    // the tab name appears verbatim as a topic word (e.g. "multi-cc-im
    // 已经合并" when there IS a multi-cc-im tab). The fallback catches
    // these by direct string substring without consulting the LLM.
    //
    // If exactly one tab name is found in the message → route to it.
    // If zero or multiple → fall through to the error echo (user picks
    // explicitly via #<tab>).
    const fallback = findTabBySubstring(body, namedSessions);
    if (fallback !== null) {
      state.setCurrent(fallback.paneId);
      return {
        echo: `target: ${displayName(fallback)}\ncontent: ${truncate(body, ECHO_EXCERPT_MAX)}`,
        dispatches: [{ session: fallback, content: body }],
        aiTrace: { ...baseTrace, fallback: 'substring' },
      };
    }
    return {
      echo:
        `❌ 「${truncate(body, ECHO_EXCERPT_MAX)}」 无法识别目标\n` +
        `   可用：${availableTabs}\n` +
        `   或用 #<tab> 显式指定`,
      dispatches: [],
      aiTrace: { ...baseTrace, fallback: null },
    };
  }

  // Find the pane matching the AI-picked target tab title.
  const target = namedSessions.find((s) => s.tabTitle === result.target);
  if (!target) {
    return {
      echo:
        `❌ AI 路由到 \`${result.target}\` 但 tab 不存在\n` +
        `   可用：${availableTabs}\n` +
        `   或用 #<tab> 显式指定`,
      dispatches: [],
      aiTrace: { ...baseTrace, fallback: null },
    };
  }

  // Sticky current — same as explicit single-mention. User can verify intent
  // via the echo and override next message with `#<tab>` if AI mis-classified.
  state.setCurrent(target.paneId);
  return {
    echo: `target: ${displayName(target)}\ncontent: ${truncate(result.intent, ECHO_EXCERPT_MAX)}`,
    dispatches: [{ session: target, content: result.intent }],
    aiTrace: { ...baseTrace, fallback: null },
  };
}

/**
 * Map the cli-cc IPC representation of a pending PreToolUse
 * (`paneId`/`sessionId`/`requestId` keyed) into the AI router's prompt
 * representation (`tabName` keyed). Drops any pending whose `paneId` is
 * no longer in the live session set — the user can't reasonably approve
 * a request whose pane has died, and including dead-tab entries in the
 * prompt risks the AI matching a reply to a phantom target.
 */
function mapPendingToPrompt(
  pendings: readonly RouterPendingRequest[],
  namedSessions: readonly SessionInfo[],
): readonly PendingRequestForPrompt[] {
  const out: PendingRequestForPrompt[] = [];
  for (const p of pendings) {
    const session = namedSessions.find((s) => s.paneId === p.paneId);
    if (!session) continue;
    out.push({
      tabName: session.tabTitle,
      toolName: p.toolName,
      toolInput: p.toolInput,
    });
  }
  return out;
}

/**
 * Extract every AskUserQuestion pending and parse its `tool_input`
 * against the official schema. Malformed entries (missing/invalid
 * `questions[]`) are silently dropped — the AUQ path needs a valid
 * `questions[]` to build the `answers` map; malformed pendings fall
 * through to the daemon-side reaper.
 */
function mapPendingToAskUserQuestion(
  pendings: readonly PendingRequestForPrompt[],
): readonly PendingAskUserQuestion[] {
  const out: PendingAskUserQuestion[] = [];
  for (const p of pendings) {
    if (p.toolName !== 'AskUserQuestion') continue;
    const parsed = AskUserQuestionToolInputSchema.safeParse(p.toolInput);
    if (!parsed.success) continue;
    out.push({ tabName: p.tabName, questions: parsed.data.questions });
  }
  return out;
}

/**
 * AUQ branch of the plain-message path (DD §9 R7). Dispatches to the
 * AUQ-specific AI router (`aiAskUserQuestionRouter`), assembles the
 * `{questions, answers}` map (looking up `options[i-1].label` for
 * option-kind entries), emits a `RouterPermissionResponse` with
 * `decision:'allow'` + `updatedInput` so cc treats the tool as
 * completed successfully with the user's answers.
 *
 * Failure modes:
 *   - No AI router wired → fallback: emit empty-answers updatedInput
 *     for the first pending so cc doesn't stall (defensive — primarily
 *     for tests that exercise the orchestrator write path without a
 *     real AI subprocess).
 *   - AI returned null (timeout / parse error) → same fallback.
 *   - AI's matched `target` doesn't exist among live tabs → echo
 *     error, do NOT emit permissionResponse (let user retry).
 */
async function handleAskUserQuestionReply(
  body: string,
  pendings: readonly PendingAskUserQuestion[],
  namedSessions: readonly SessionInfo[],
  aiAskUserQuestionRouter:
    | ((opts: AskUserQuestionViaAIOpts) => Promise<AIAskUserQuestionResult | null>)
    | undefined,
): Promise<RouterResult> {
  // No AI wire OR AI returned null → fallback to empty answers on the
  // first pending so cc proceeds (model sees empty answers and decides).
  const fallback = (
    matched: PendingAskUserQuestion,
    reason: string,
  ): RouterResult => {
    const target = namedSessions.find((s) => s.tabTitle === matched.tabName);
    if (!target) {
      return {
        echo: `❌ AUQ tab \`${matched.tabName}\` 不存在；请用 cc TUI 回答`,
        dispatches: [],
      };
    }
    const answers: Record<string, string> = {};
    for (const q of matched.questions) answers[q.question] = '';
    return {
      echo:
        `target: ${displayName(target)}\n` +
        `你说: ${truncate(body, ECHO_EXCERPT_MAX)}\n` +
        `⚠️ AI 分诊失败（${reason}），已注入空答案让 cc 决定`,
      dispatches: [],
      permissionResponse: {
        session: target,
        decision: 'allow',
        updatedInput: { questions: matched.questions, answers },
      },
    };
  };

  if (!aiAskUserQuestionRouter) {
    return fallback(pendings[0]!, 'no AI router wired');
  }

  const aiResult = await aiAskUserQuestionRouter({ userMsg: body, pendings });
  if (aiResult === null) {
    return fallback(pendings[0]!, 'AI returned null');
  }

  // Match AI's `target` against the pending list. If mismatch, pick the
  // first listed pending (user can re-issue if wrong).
  const matched =
    pendings.find((p) => p.tabName === aiResult.target) ?? pendings[0]!;
  const target = namedSessions.find((s) => s.tabTitle === matched.tabName);
  if (!target) {
    return {
      echo: `❌ AUQ tab \`${matched.tabName}\` 不存在；请用 cc TUI 回答`,
      dispatches: [],
      aiTrace: { target: aiResult.target, intent: null, reason: aiResult.reason },
    };
  }

  const { answers, echoLines } = buildAnswersAndEcho(
    matched.questions,
    aiResult.answers,
  );

  return {
    echo:
      `target: ${displayName(target)}\n` +
      `你说: ${truncate(body, ECHO_EXCERPT_MAX)}\n` +
      `${echoLines.join('\n')}`,
    dispatches: [],
    permissionResponse: {
      session: target,
      decision: 'allow',
      updatedInput: { questions: matched.questions, answers },
    },
    aiTrace: { target: aiResult.target, intent: null, reason: aiResult.reason },
  };
}

/**
 * Resolve the AI's per-question `answers` entries into the
 * `{question.question → label/text}` map cc expects on
 * `updatedInput.answers`, and a parallel array of IM echo lines that
 * surface the user's answer in option-vs-text form.
 *
 * Option-kind entries are mapped through `options[optionIndex-1].label`
 * — daemon-side label lookup means the AI doesn't have to re-emit the
 * label string (less drift). Multi-select option arrays are joined with
 * `, ` for both the cc-side answer value and the IM echo line.
 *
 * Any question without a matching answer entry defaults to an empty
 * string so cc receives a complete `answers` map (one entry per
 * question) per the agent-sdk docs' contract.
 */
function buildAnswersAndEcho(
  questions: readonly AskUserQuestionToolInput['questions'][number][],
  aiAnswers: AIAskUserQuestionResult['answers'],
): {
  answers: Record<string, string>;
  echoLines: string[];
} {
  const answers: Record<string, string> = {};
  const echoLines: string[] = [];
  // Track which question indices have been answered so we can default
  // the unanswered ones to empty.
  const seen = new Set<number>();

  for (const a of aiAnswers) {
    const q = questions[a.questionIndex];
    if (!q) continue;
    seen.add(a.questionIndex);
    const numberedHeader = `Q${a.questionIndex + 1}`;
    if (a.kind === 'option') {
      const indices = Array.isArray(a.optionIndex) ? a.optionIndex : [a.optionIndex];
      const labels = indices
        .map((i) => q.options[i - 1]?.label)
        .filter((l): l is string => typeof l === 'string' && l.length > 0);
      const valueStr = labels.join(', ');
      answers[q.question] = valueStr;
      const numberedOptions = indices
        .map((i, k) => {
          const label = labels[k];
          return label !== undefined ? `${optionNumberGlyph(i)} ${label}` : '';
        })
        .filter((s) => s.length > 0)
        .join(' / ');
      echoLines.push(`${numberedHeader} 你答 ${numberedOptions}`);
    } else {
      answers[q.question] = a.text;
      echoLines.push(
        `${numberedHeader} 自由回答: ${truncate(a.text, ECHO_EXCERPT_MAX)}`,
      );
    }
  }

  // Fill missing questions with empty answers (cc requires one entry per
  // question per agent-sdk docs; missing key = malformed tool result).
  for (let i = 0; i < questions.length; i++) {
    if (seen.has(i)) continue;
    const q = questions[i]!;
    answers[q.question] = '';
    echoLines.push(`Q${i + 1} (no answer)`);
  }

  return { answers, echoLines };
}

/**
 * Decorate a small 1-based number with circled-digit glyph (①②③④...)
 * for the IM echo. Falls back to `[N]` notation for N > 10 (rare —
 * AUQ caps at 4 options per question per official docs).
 */
function optionNumberGlyph(n: number): string {
  const circled = [
    '',
    '①',
    '②',
    '③',
    '④',
    '⑤',
    '⑥',
    '⑦',
    '⑧',
    '⑨',
    '⑩',
  ];
  return n >= 1 && n < circled.length ? circled[n]! : `[${n}]`;
}

/**
 * PermissionDialog reply branch (DD 2026-05-13 §6 P7). When cc's
 * PermissionRequest hook event surfaces a sensitive-path ask gate, the
 * daemon forwards the dialog to IM with numbered options. The user's
 * plain reply lands here — AI extracts the structured answer per §3 D6
 * (single-yes / always-allow-suggestion-N / deny), the orchestrator
 * resolves `appliedSuggestionIndex` into the actual cc PermissionUpdate
 * from the pending Request's `permissionSuggestions[]` and writes the
 * Response file.
 *
 * Failure modes:
 *   - No AI router wired → fallback: deny + safe message (cc gets a
 *     clear deny so it doesn't proceed silently)
 *   - AI returned null (timeout / parse error) → same deny fallback
 *   - AI's `target` doesn't match any pending tab → echo error
 *
 * Sticky `current` is NOT updated (mirrors AUQ + rigid-syntax behavior).
 */
async function handlePermissionDialogReply(
  body: string,
  pendings: readonly RouterPendingDialog[],
  namedSessions: readonly SessionInfo[],
  aiPermissionRequestRouter:
    | ((opts: PermissionRequestViaAIOpts) => Promise<AIPermissionDialogResult | null>)
    | undefined,
): Promise<RouterResult> {
  const fallback = (
    matched: RouterPendingDialog,
    reason: string,
  ): RouterResult => {
    const target = namedSessions.find(
      (s) => (s.paneId as unknown as PaneId) === matched.paneId,
    );
    if (!target) {
      return {
        echo: `❌ PermissionDialog target pane=${matched.paneId} 不存在；请用 cc TUI 回答`,
        dispatches: [],
      };
    }
    return {
      echo:
        `target: ${displayName(target)}\n` +
        `你说: ${truncate(body, ECHO_EXCERPT_MAX)}\n` +
        `⚠️ AI 分诊失败（${reason}），默认拒绝；cc 会回 TUI dialog 让你重选`,
      dispatches: [],
      permissionDialogResponse: {
        session: target,
        answer: {
          behavior: 'deny',
          message: `AI dispatch failed: ${reason}`,
        },
      },
    };
  };

  if (!aiPermissionRequestRouter) {
    return fallback(pendings[0]!, 'no AI router wired');
  }

  // Convert RouterPendingDialog → PendingPermissionDialog (ai-router shape)
  const aiPendings: PendingPermissionDialog[] = pendings.map((p) => {
    const session = namedSessions.find(
      (s) => (s.paneId as unknown as PaneId) === p.paneId,
    );
    const tabName = session?.tabTitle ?? `(pane ${p.paneId as unknown as number})`;
    return {
      tabName,
      toolName: p.toolName,
      toolInputSummary: inferDialogToolInputSummary(p.toolInput),
      permissionSuggestions: p.permissionSuggestions,
    };
  });

  const aiResult = await aiPermissionRequestRouter({
    userMsg: body,
    pendings: aiPendings,
  });
  if (aiResult === null) {
    return fallback(pendings[0]!, 'AI returned null');
  }

  // Match by tab name
  const matchedDialog =
    pendings.find((p) => {
      const session = namedSessions.find(
        (s) => (s.paneId as unknown as PaneId) === p.paneId,
      );
      return session?.tabTitle === aiResult.target;
    }) ?? pendings[0]!;
  const target = namedSessions.find(
    (s) => (s.paneId as unknown as PaneId) === matchedDialog.paneId,
  );
  if (!target) {
    return {
      echo: `❌ AUQ tab \`${aiResult.target}\` 不存在；请用 cc TUI 回答`,
      dispatches: [],
      aiTrace: { target: aiResult.target, intent: null, reason: aiResult.reason },
    };
  }

  // Defensive: validate appliedSuggestionIndex stays in range. AI prompt
  // is told to obey but Haiku/Sonnet drift defense.
  const answer = applyDialogIndexClamp(aiResult.answer, matchedDialog);

  return {
    echo:
      `target: ${displayName(target)}\n` +
      `你说: ${truncate(body, ECHO_EXCERPT_MAX)}\n` +
      `${formatDialogAnswerEcho(answer, matchedDialog)}`,
    dispatches: [],
    permissionDialogResponse: {
      session: target,
      answer,
    },
    aiTrace: { target: aiResult.target, intent: null, reason: aiResult.reason },
  };
}

/**
 * Clamp `appliedSuggestionIndex` into valid range. If AI returns an
 * out-of-range index (e.g. AI saw N suggestions but emitted N+1), we
 * downgrade to single-yes (omit `appliedSuggestionIndex`) — safer than
 * synthesizing a wrong cc PermissionUpdate.
 */
function applyDialogIndexClamp(
  answer: PermissionDialogAnswer,
  matched: RouterPendingDialog,
): PermissionDialogAnswer {
  if (answer.behavior !== 'allow') return answer;
  if (answer.appliedSuggestionIndex === undefined) return answer;
  const i = answer.appliedSuggestionIndex;
  if (i < 1 || i > matched.permissionSuggestions.length) {
    // Strip the bad index — degrade to single-yes
    return { behavior: 'allow' };
  }
  return answer;
}

/**
 * IM echo line summarizing the AI-extracted answer for the user's
 * visual confirmation. Mirrors AUQ echo style.
 */
function formatDialogAnswerEcho(
  answer: PermissionDialogAnswer,
  matched: RouterPendingDialog,
): string {
  if (answer.behavior === 'deny') {
    return `选择: 拒绝${answer.message ? `（${truncate(answer.message, ECHO_EXCERPT_MAX)}）` : ''}`;
  }
  if (answer.appliedSuggestionIndex === undefined) {
    return '选择: 同意一次';
  }
  const idx = answer.appliedSuggestionIndex;
  const summary = summarizePermissionSuggestionLocal(
    matched.permissionSuggestions[idx - 1],
  );
  return `选择: ${optionNumberGlyph(idx + 1)} 始终允许 ${truncate(summary, ECHO_EXCERPT_MAX)}`;
}

/**
 * Local copy of `summarizePermissionSuggestion` (in ai-router) for echo
 * formatting only. Best-effort extraction of `rules[0].ruleContent`.
 */
function summarizePermissionSuggestionLocal(s: unknown): string {
  if (typeof s !== 'object' || s === null) return '<unknown>';
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
  return '<unknown>';
}

/**
 * Best-effort summary of cc's `tool_input` for prompt + IM echo.
 * Mirrors orchestrator's `inferSensitivePathFromToolInput`.
 */
function inferDialogToolInputSummary(input: Record<string, unknown>): string {
  const filePath = input.file_path;
  if (typeof filePath === 'string' && filePath.length > 0) return filePath;
  const path = input.path;
  if (typeof path === 'string' && path.length > 0) return path;
  const command = input.command;
  if (typeof command === 'string' && command.length > 0) return command;
  return '<unknown path>';
}

/**
 * Handle the AI-matched permission reply branch of `handlePlainWithAI`.
 * Per [DD: natural-language permission reply](../../../docs/superpowers/specs/2026-05-11-im-permission-natural-language-dd.md) §9.1 P3.
 *
 * The IM message did NOT route a new task; instead AI matched it to a
 * pending PreToolUse and decided allow / deny. Emit a
 * `RouterPermissionResponse` so orchestrator dispatches via the same
 * helper as the rigid-syntax `#<tab> /1` path — sticky `current` is
 * NOT updated (mirrors rigid-syntax behavior; permission replies are
 * orthogonal to routing default).
 *
 * Echo format mirrors the routing echo style so the user can confirm
 * which pending was matched + decision at a glance.
 */
function handleAIPermissionReply(
  body: string,
  permissionResponse: AIPermissionResponse,
  namedSessions: readonly SessionInfo[],
  baseTrace: NonNullable<RouterResult['aiTrace']>,
): RouterResult {
  const target = namedSessions.find(
    (s) => s.tabTitle === permissionResponse.target,
  );
  const availableTabs = namedSessions.map((s) => `#${s.tabTitle}`).join(', ');
  if (!target) {
    // AI picked a tab that's no longer live (race between
    // listPendingPermissionRequests + the AI call) or the AI hallucinated
    // a name. Echo the error so the user knows what happened; do NOT
    // emit a permissionResponse since there's nothing to dispatch.
    void body;
    return {
      echo:
        `❌ AI 把审批路由到 \`${permissionResponse.target}\` 但 tab 不存在\n` +
        `   可用：${availableTabs}\n` +
        `   或用 #<tab> /1 显式指定`,
      dispatches: [],
      aiTrace: baseTrace,
    };
  }
  // Echo format (v1.10, 2026-05-12 force-permission DD §3):
  //   target: <tab>
  //   你说: <user's raw IM msg, truncated>
  //   选择: <AI's extracted answer — option label / allow/deny paraphrase>
  // Unified label across regular tools + AskUserQuestion so the user can
  // visually confirm daemon understood correctly. The previous
  // "permission: 允许/拒绝 + reason: ..." format leaked an allow/deny
  // vocabulary that doesn't fit AskUserQuestion answer-extraction.
  return {
    echo:
      `target: ${displayName(target)}\n` +
      `你说: ${truncate(body, ECHO_EXCERPT_MAX)}\n` +
      `选择: ${truncate(permissionResponse.reason, ECHO_EXCERPT_MAX)}`,
    dispatches: [],
    permissionResponse: {
      session: target,
      decision: permissionResponse.decision,
      reason: permissionResponse.reason,
    },
    aiTrace: baseTrace,
  };
}

// ============================================================================
// #<name> mention(s)
// ============================================================================

function handleMention(
  mentions: readonly string[],
  body: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
): RouterResult {
  const resolved: SessionInfo[] = [];
  const errors: string[] = [];

  for (const m of mentions) {
    const result = matchSession(m, sessions);
    if (result.type === 'unique') {
      resolved.push(result.session);
    } else if (result.type === 'ambiguous') {
      errors.push(
        `❌ \`#${m}\` is ambiguous — matches: ${result.candidates
          .map(displayName)
          .join(', ')}`,
      );
    } else {
      const named = sessions.filter((s) => s.tabTitle.length > 0);
      errors.push(
        named.length === 0
          ? `❌ \`#${m}\` not found — no /rename'd cc panes`
          : `❌ \`#${m}\` not found — alive: ${named.map(displayName).join(', ')}`,
      );
    }
  }

  if (errors.length > 0) {
    return { echo: errors.join('\n'), dispatches: [] };
  }

  if (body.length === 0) {
    if (resolved.length === 1) {
      state.setCurrent(resolved[0]!.paneId);
      return {
        echo: `📌 current = ${displayName(resolved[0]!)} (empty body, nothing to send)`,
        dispatches: [],
      };
    }
    return {
      echo: '❌ empty body, nothing to send',
      dispatches: [],
    };
  }

  if (resolved.length === 1) {
    state.setCurrent(resolved[0]!.paneId);
    return {
      echo: `📌 current = ${displayName(resolved[0]!)}`,
      dispatches: [{ session: resolved[0]!, content: body }],
    };
  }

  return {
    echo: `→ ${resolved.map(displayName).join(', ')}`,
    dispatches: resolved.map((session) => ({ session, content: body })),
  };
}

// ============================================================================
// #all broadcast
// ============================================================================

function handleBroadcast(
  body: string,
  sessions: readonly SessionInfo[],
): RouterResult {
  const named = sessions.filter((s) => s.tabTitle.length > 0);
  if (named.length === 0) {
    return {
      echo: '❌ no /rename\'d cc panes',
      dispatches: [],
    };
  }
  if (body.length === 0) {
    return {
      echo: '❌ empty body, nothing to send',
      dispatches: [],
    };
  }
  return {
    echo: `📢 broadcast to ${named.length} session${named.length === 1 ? '' : 's'}: ${named.map(displayName).join(', ')}`,
    dispatches: named.map((session) => ({ session, content: body })),
  };
}

// ============================================================================
// Bridge commands: bare `/<command> [args]` (per DD #73 — replaced
// per DD #73 — replaces legacy v1.4 `@multi-cc-im /<command>` form)
// ============================================================================

function handleBridgeCommand(
  command: string,
  args: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
  imWorkOn: boolean,
  imWorkAuto: boolean,
  terminalId: 'wezterm' | 'iterm2' | undefined,
): RouterResult {
  switch (command) {
    case 'list':
      return {
        echo: formatSessionInventory(sessions, terminalId).join('\n'),
        dispatches: [],
      };

    case 'help':
      return {
        echo: [
          '路由示例：',
          '  hello                      → current cc (last-explicit-mention 粘性；只一个 cc 时自动 = 那一个)',
          '  #frontend hello            → tab title=frontend 的 cc，并设为 current',
          '  #fr hello                  → 短前缀（4 级 fallback：=strict → exact → prefix → glob；歧义列候选拒绝）',
          '  #frontend #api sync        → 多目标分发；不改 current',
          '  #frontend /clear           → 转发 /clear 进 cc TUI（cc 自己当 slash 命令处理）',
          '  #all stop everything       → 广播给所有 /rename\'d cc',
          '  #frontend /1   /  /2       → 权限允许 / 拒绝（仅当有 pending PreToolUse）',
          '',
          'Bridge 命令（直接 /<cmd>）：',
          '  /list                      → 列当前终端 tabs（含可寻址状态）',
          '  /help                      → 本帮助',
          '  /current                   → 显示 current_session + IMWork 状态',
          '  /start                     → 开启 IM 模式（默认 auto-approve；加 `off` 切 ask 模式）',
          '  /stop                      → 关闭 IM 模式（cc 回复留 cc TUI，工具审批走 cc 原生菜单）',
          '',
          'Tip: 进 cc TUI 跑 /rename <name> 设 #<name> 寻址（real-time，cc /resume 也带）；',
          '     tab title 不要用纯数字 — 易混淆 (paneId 显示也是数字)。',
        ].join('\n'),
        dispatches: [],
      };

    case 'current': {
      const paneId = state.getCurrent();
      const imWorkLine = imWorkOn
        ? `IMWork = ON${imWorkAuto ? ' (auto-approve)' : ''}`
        : 'IMWork = OFF';
      if (paneId === null) {
        return {
          echo: `current = none\n${imWorkLine}`,
          dispatches: [],
        };
      }
      const session = sessions.find((s) => s.paneId === paneId);
      if (!session) {
        state.setCurrent(null);
        return {
          echo: `current = none (previous pane disconnected)\n${imWorkLine}`,
          dispatches: [],
        };
      }
      return {
        echo: `current = ${displayName(session)}\n${imWorkLine}`,
        dispatches: [],
      };
    }

    case 'start': {
      // /start [off]: enable IM mode. Per [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md):
      // **default is auto-approve ON** (cc tools auto-pass, no IM round-trip).
      // `/start off` explicitly opts into ask mode (every PreToolUse forwards
      // to IM, user replies /1 /2). Inverts the v1 default after user
      // feedback that ask mode was wrist-pain-heavy in tool-dense workflows.
      // Always emits imWorkAction (no idempotent skip) so users can switch
      // modes (`/start` ↔ `/start off`) by re-issuing.
      const wantAuto = args.trim() !== 'off';
      const headerLine = wantAuto
        ? '✓ IMWork ON (auto-approve) — cc 工具调用直接放行'
        : '✓ IMWork ON (ask) — cc 工具调用通过 IM 审批';
      const autoTipLine = wantAuto
        ? '  - auto-approve ON：cc 调工具时**不**问 IM，直接放行（用 /start off 切回 ask）'
        : '  - cc 调工具时 IM 收到提示，10 秒内 /1 (允许) /2 (拒绝)，超时默认放行（用 /start 切回 auto）';
      return {
        echo: [
          headerLine,
          ...(terminalId ? [`✓ terminal: ${terminalId}`] : []),
          '',
          ...formatSessionInventory(sessions, terminalId),
          ...formatNumericTabWarning(sessions),
          ...formatDuplicateTabWarning(sessions),
          '',
          '⚠️ 规则：',
          '  - IM 路由只用 tab title (cc /rename 设的)',
          '  - 没 /rename 的 cc 只能在 cc TUI 里用，IM 寻址不到',
          '  - 建议 tab title 用字母/单词，**不要用纯数字** (易混淆)',
          '  - 直接输入想说的话告诉 daemon 想让哪个 cc 干活（不带 `#`），daemon 会自动分诊到最匹配的 tab；要精确点名才用 `#<tab>`',
          '  - cc 回复转发到 IM (Stop hook)',
          autoTipLine,
          '  - ask 模式下也能用自然语言回审批：「<tab> 同意」/「<tab> 拒绝」/「deny the bash one」之类（AI 找匹配的 pending）',
          '  - 终端 cc TUI 直接打字不会 forward 到 IM',
          '',
          '完整命令说明：发 /help',
        ].join('\n'),
        dispatches: [],
        imWorkAction: { kind: 'enable', auto: wantAuto },
      };
    }

    case 'stop':
      // Always emit imWorkAction (idempotent semantics — repeat /stop is safe;
      // orchestrator's deleteIMWorkFile already ignores ENOENT).
      return {
        echo: imWorkOn
          ? '✓ IMWork OFF — cc 回复留 cc TUI，工具审批走 cc 原生菜单'
          : 'ℹ️ IMWork already OFF',
        dispatches: [],
        imWorkAction: { kind: 'disable' },
      };

    default:
      return {
        echo: `❌ unknown bridge command: /${command}\n  Try /help`,
        dispatches: [],
      };
  }
}

/**
 * Render the terminal-tabs inventory block for `/start` + `/list` echoes.
 *
 * Lists **all** panes (zsh / cc / vim / 任何东西) of the active terminal —
 * daemon 不知道每个 pane 里跑啥，只知道 tab title 是不是被 /rename 过。每行
 * 显示寻址状态：
 *   - 有 /rename → `[可寻址 #<name>]`
 *   - 没 /rename → `[未 /rename — 进 cc TUI 跑 /rename <name>]`
 *
 * `termLabel` is the human-facing terminal name (`wezterm` / `iterm2`) —
 * heading reads `当前 <termLabel> tabs:`. Defaults to `wezterm` for callers
 * that don't pass it (back-compat).
 */
function formatSessionInventory(
  sessions: readonly SessionInfo[],
  termLabel: string = 'wezterm',
): string[] {
  if (sessions.length === 0) {
    return [
      `当前 ${termLabel} tabs: (无 — 请先开 ${termLabel} tab 启动 cc 并 /rename)`,
    ];
  }
  const lines = [`当前 ${termLabel} tabs:`];
  sessions.forEach((s, i) => {
    const status =
      s.tabTitle.length > 0
        ? `[可寻址 #${s.tabTitle}]`
        : `[未 /rename — 进 cc TUI 跑 /rename <name>]`;
    lines.push(`  ${i + 1}. ${displayName(s)} (pane ${s.paneId}) ${status}`);
  });
  return lines;
}

/** If any /renamed tab title is purely numeric → warn (looks like paneId). */
function formatNumericTabWarning(sessions: readonly SessionInfo[]): string[] {
  const numeric = sessions.filter((s) => /^\d+$/.test(s.tabTitle));
  if (numeric.length === 0) return [];
  return [
    '',
    `⚠️ 注意：${numeric.length} 个 cc 的 tab title 是纯数字 (${numeric
      .map((s) => `"${s.tabTitle}"`)
      .join(', ')})，建议改名 (在 cc TUI 跑 /rename <非数字名>)`,
  ];
}

/** If multiple panes share the same /renamed title → warn (matcher will reject). */
function formatDuplicateTabWarning(sessions: readonly SessionInfo[]): string[] {
  const counts = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    if (s.tabTitle.length === 0) continue;
    const arr = counts.get(s.tabTitle) ?? [];
    arr.push(s);
    counts.set(s.tabTitle, arr);
  }
  const dups = [...counts.entries()].filter(([, arr]) => arr.length > 1);
  if (dups.length === 0) return [];
  const lines = ['', '⚠️ 同名 cc 冲突，IM 寻址不到下列任一：'];
  for (const [title, arr] of dups) {
    lines.push(
      `  - tab "${title}" 在 ${arr.map((s) => `pane ${s.paneId}`).join(' + ')}`,
    );
  }
  lines.push('  请进 cc TUI 把其中一个 /rename 成别的名');
  return lines;
}

// ============================================================================
// Helpers
// ============================================================================

function displayName(s: SessionInfo): string {
  if (s.tabTitle.length > 0) return s.tabTitle;
  // No /rename — display by paneId. User can't IM-route to this pane until
  // they /rename, but we still want /list etc. to show it exists.
  return `(pane ${s.paneId})`;
}

/**
 * Minimum tab-name length (after normalization) for substring fallback
 * to consider a match. Tabs shorter than this are very likely to
 * produce false positives ("no" matches "node" / "go" / "stop"...).
 * Mostly defensive — real cc tab names are 3+ chars in practice.
 */
const SUBSTRING_FALLBACK_MIN_LEN = 3;

/**
 * Normalize a string for lenient substring comparison: lowercase + strip
 * hyphens / underscores / whitespace. Mirrors the leniency promised in
 * the AI router prompt so the deterministic fallback agrees with the
 * AI's intended matching semantics.
 */
function normalizeForSubstring(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, '');
}

/**
 * Deterministic substring match: returns the most-specific tab whose
 * (normalized) name appears in the (normalized) message text, or
 * `null` if zero or truly ambiguous (non-nested) multi-match.
 *
 * Used as a fallback when the AI router returns `target: null` —
 * recovers cases where the AI bailed on topic-word mentions
 * (e.g. message "multi-cc-im 合并了" + tab "multi-cc-im"). Per user
 * smoke 2026-05-11.
 *
 * **Nested multi-match tie-break** (2026-05-12 fix): when a short tab
 * name is itself a substring of a longer matching tab name (e.g.
 * `breatic` is nested in `breatic_frontend`, both appear in
 * normalized "你跟 breatic frontend 说..."), the longer / more-specific
 * tab wins. Without this tie-break, multi-match would bail to null
 * even when the user clearly addressed the more specific tab.
 *
 * Truly ambiguous multi-match (matches NOT in a nested-substring
 * relation — e.g. `frontend` + `backend` both literal) still returns
 * null so the user picks explicitly via `#<tab>`.
 */
function findTabBySubstring(
  message: string,
  sessions: readonly SessionInfo[],
): SessionInfo | null {
  const normMsg = normalizeForSubstring(message);
  const matches: SessionInfo[] = [];
  for (const session of sessions) {
    const normTab = normalizeForSubstring(session.tabTitle);
    if (normTab.length < SUBSTRING_FALLBACK_MIN_LEN) continue;
    if (normMsg.includes(normTab)) matches.push(session);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;

  // Multi-match — resolve via "longest contains all others (normalized)"
  // nested-substring rule. Sort by normalized length descending so the
  // longest is at index 0; then verify every other match's normalized
  // name is a substring of the longest's normalized name. If so, the
  // longest is unambiguously the most specific. Otherwise truly
  // ambiguous → return null.
  const sorted = [...matches].sort(
    (a, b) =>
      normalizeForSubstring(b.tabTitle).length -
      normalizeForSubstring(a.tabTitle).length,
  );
  const longest = sorted[0]!;
  const normLongest = normalizeForSubstring(longest.tabTitle);
  for (let i = 1; i < sorted.length; i++) {
    const normOther = normalizeForSubstring(sorted[i]!.tabTitle);
    if (!normLongest.includes(normOther)) return null;
  }
  return longest;
}
