import type { IncomingMessage, SessionId } from '@multi-cc-im/shared';
import { matchSession, type MatchResult, type SessionInfo } from './matcher.js';
import { parse, type ParsedMessage } from './parser.js';

/**
 * Lookup interface for currently-alive cc sessions. Bridge orchestrator
 * implements this by joining cli-cc state files (alive sessions) with the
 * latest wezterm pane titles (cc `/rename`). Router stays IO-free /
 * pure-function-ish — orchestrator must call `listAlive()` after refreshing
 * tab titles so each `SessionInfo.tabTitle` reflects the user's current
 * naming.
 */
export interface SessionRegistry {
  listAlive(): Promise<readonly SessionInfo[]>;
}

/**
 * Persistent-ish state for last-explicit-mention sticky default. Bridge
 * orchestrator backs this with an in-memory ref + optional persistence (see
 * follow-up wiring PR). Router treats it as a tiny mutable holder.
 */
export interface RouterState {
  getCurrent(): SessionId | null;
  setCurrent(id: SessionId | null): void;
}

export interface RouterOpts {
  registry: SessionRegistry;
  state: RouterState;
  /**
   * Whether `<stateDir>/IMWork` exists at the moment of routing. Per
   * [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md):
   *   - `false` (default if omitted) → "talk to cc" messages (mention / plain /
   *     broadcast) are rejected with "IMWork off — please /start" hint
   *   - `true` → normal dispatch
   *
   * Bridge commands (`@multi-cc-im /...`) and permission responses
   * (`@<tab> /1` `/2`) always work regardless of IMWork state.
   */
  imWorkOn?: boolean;
}

export interface RouterDispatch {
  session: SessionInfo;
  /** Body to forward (post-mention parsing). */
  content: string;
}

/**
 * Permission response derived from `@<tabname> /1` (allow) or `/2` (deny)
 * IM messages. Per [DD: permission forward](../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md).
 * Orchestrator picks this up after `route()`, locates the session's pending
 * PermissionRequest file, and writes a matching PermissionResponse.
 */
export interface RouterPermissionResponse {
  session: SessionInfo;
  decision: 'allow' | 'deny';
}

export interface RouterResult {
  /** Visible feedback to send back to the IM (per CLAUDE.md "routing visible echo required"). */
  echo: string;
  /** Sessions to forward `content` to. Empty for control commands / errors. */
  dispatches: RouterDispatch[];
  /** Set when the IM message was a `@<tabname> /1` or `/2` permission response. */
  permissionResponse?: RouterPermissionResponse;
  /**
   * Set when the IM user invoked `@multi-cc-im /start` or `/stop`. Orchestrator
   * acts on it after `route()` returns: writes / deletes `<stateDir>/IMWork`.
   * Per [DD: IMWork+IMOrigin](../../../docs/superpowers/specs/2026-05-08-imwork-imorigin-dd.md).
   */
  imWorkAction?: 'enable' | 'disable';
}

/**
 * Route a wechat IncomingMessage per [DD: routing-syntax G'](../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md).
 *
 * High-level pipeline:
 *   1. parse text → ParsedMessage (parser.ts)
 *   2. handle control commands (@list / @help / @current) — no dispatch
 *   3. handle broadcast (@all) — fan out to all alive
 *   4. handle mention(s) — match each via 4-level fallback (matcher.ts)
 *   5. handle plain — dispatch to current_session (sticky); auto-set current
 *      when only 1 session alive
 *   6. assemble visible echo + dispatch list
 *
 * State invariants:
 *   - **Single-mention with body** updates `current_session` (last-explicit)
 *   - **Multi-mention / @all / control / plain** does NOT update current
 *   - When `current_session` is dead at routing time, auto-unset + error
 */
export async function route(
  incoming: IncomingMessage,
  opts: RouterOpts,
): Promise<RouterResult> {
  const sessions = await opts.registry.listAlive();
  const text = incoming.text;
  // Image-/attachment-only messages have no text — router has nothing to do
  // (orchestrator handles attachment forwarding separately based on its own
  // policy). Return empty result so caller can no-op text routing.
  if (text === null || text.trim().length === 0) {
    return { echo: '', dispatches: [] };
  }
  const parsed = parse(text);
  const imWorkOn = opts.imWorkOn ?? false;

  // IMWork gate: "talk to cc" message types require IMWork on. Bridge
  // commands (`@multi-cc-im /...`) + permission responses (`@<tab> /1` `/2`)
  // + parse errors always pass through. Per [DD: IMWork+IMOrigin].
  if (
    !imWorkOn &&
    (parsed.type === 'mention' ||
      parsed.type === 'plain' ||
      parsed.type === 'broadcast')
  ) {
    return {
      echo:
        '❌ IMWork off — 请先发 `@multi-cc-im /start` 开启 IM 模式',
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
      );

    case 'broadcast':
      return handleBroadcast(parsed.body, sessions, opts.state);

    case 'mention':
      return handleMention(parsed.mentions, parsed.body, sessions, opts.state);

    case 'plain':
      return handlePlain(parsed.body, sessions, opts.state);

    case 'permission_response':
      return handlePermissionResponse(parsed.tabName, parsed.decision, sessions);
  }
}

// ============================================================================
// Permission response: @<tabname> /1 (allow) / @<tabname> /2 (deny)
// ============================================================================

function handlePermissionResponse(
  tabName: string,
  decision: 'allow' | 'deny',
  sessions: readonly SessionInfo[],
): RouterResult {
  const result = matchSession(tabName, sessions);
  if (result.type === 'none') {
    return {
      echo: `❌ \`@${tabName}\` not found — no active session by that name`,
      dispatches: [],
    };
  }
  if (result.type === 'ambiguous') {
    return {
      echo: `❌ \`@${tabName}\` is ambiguous — matches: ${result.candidates
        .map(displayName)
        .join(', ')}. Use a longer prefix or \`$<sid8>\`.`,
      dispatches: [],
    };
  }
  // Unique match. Orchestrator will check whether the session has a pending
  // PermissionRequest file and either write the Response or echo "no pending".
  const verb = decision === 'allow' ? '允许' : '拒绝';
  return {
    echo: `→ ${displayName(result.session)} permission ${verb}`,
    dispatches: [],
    permissionResponse: { session: result.session, decision },
  };
}

// ============================================================================
// Plain (no @<name>): dispatch to current_session
// ============================================================================

function handlePlain(
  body: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
): RouterResult {
  if (sessions.length === 0) {
    return {
      echo: '❌ no active sessions — start a cc in any wezterm tab first',
      dispatches: [],
    };
  }

  const currentId = state.getCurrent();

  // If user previously picked a target, that decision is sticky — even when
  // it died (don't silently re-route to whoever's still alive). Stale current
  // → unset + error so user re-picks intentionally.
  if (currentId !== null) {
    const current = sessions.find((s) => s.sessionId === currentId);
    if (!current) {
      state.setCurrent(null);
      return {
        echo: `⚠️ previous current session disconnected, current cleared. Use \`@<name>\` to pick a target.`,
        dispatches: [],
      };
    }
    return {
      echo: `→ ${displayName(current)}`,
      dispatches: [{ session: current, content: body }],
    };
  }

  // No current set: pleasant single-cc UX — auto-current to the only alive
  // session. With multiple alive, force user to pick explicitly.
  if (sessions.length === 1) {
    const only = sessions[0]!;
    state.setCurrent(only.sessionId);
    return {
      echo: `→ ${displayName(only)}`,
      dispatches: [{ session: only, content: body }],
    };
  }

  return {
    echo: `❌ no current session — send \`@<name>\` first or \`@list\` to see all`,
    dispatches: [],
  };
}

// ============================================================================
// @<name> mention(s)
// ============================================================================

function handleMention(
  mentions: readonly string[],
  body: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
): RouterResult {
  // Resolve each mention; collect failures up-front so the whole message is
  // rejected atomically (per DD: "any one @ ambiguous/unmatched → entire
  // message rejected").
  const resolved: SessionInfo[] = [];
  const errors: string[] = [];

  for (const m of mentions) {
    const result = matchSession(m, sessions);
    if (result.type === 'unique') {
      resolved.push(result.session);
    } else if (result.type === 'ambiguous') {
      errors.push(
        `❌ \`@${m}\` is ambiguous — matches: ${result.candidates
          .map(displayName)
          .join(', ')}`,
      );
    } else {
      errors.push(
        sessions.length === 0
          ? `❌ \`@${m}\` not found — no active sessions`
          : `❌ \`@${m}\` not found — alive: ${sessions.map(displayName).join(', ')}`,
      );
    }
  }

  if (errors.length > 0) {
    return { echo: errors.join('\n'), dispatches: [] };
  }

  // Empty body: still set current on single mention (so user can follow with
  // a body in the next message). No dispatch.
  if (body.length === 0) {
    if (resolved.length === 1) {
      state.setCurrent(resolved[0]!.sessionId);
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

  // Single mention with body → set current (last-explicit-mention sticky)
  if (resolved.length === 1) {
    state.setCurrent(resolved[0]!.sessionId);
    return {
      echo: `📌 current = ${displayName(resolved[0]!)}`,
      dispatches: [{ session: resolved[0]!, content: body }],
    };
  }

  // Multi-mention with body → dispatch to all, do NOT change current
  return {
    echo: `→ ${resolved.map(displayName).join(', ')}`,
    dispatches: resolved.map((session) => ({ session, content: body })),
  };
}

// ============================================================================
// @all broadcast
// ============================================================================

function handleBroadcast(
  body: string,
  sessions: readonly SessionInfo[],
  _state: RouterState,
): RouterResult {
  if (sessions.length === 0) {
    return {
      echo: '❌ no active sessions',
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
    echo: `📢 broadcast to ${sessions.length} session${sessions.length === 1 ? '' : 's'}: ${sessions.map(displayName).join(', ')}`,
    dispatches: sessions.map((session) => ({ session, content: body })),
  };
}

// ============================================================================
// Bridge commands: @multi-cc-im /<command> [args]
// ============================================================================

/**
 * Handle bridge slash commands. Supports `/list`, `/help`, `/current`,
 * `/start`, `/stop`. Unknown commands return an error echo so users learn
 * the right form (and can extend by adding cases here).
 */
function handleBridgeCommand(
  command: string,
  _args: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
  imWorkOn: boolean,
): RouterResult {
  switch (command) {
    case 'list':
      if (sessions.length === 0) {
        return { echo: 'no active sessions', dispatches: [] };
      }
      return {
        echo: sessions
          .map((s, i) => `${i + 1}. ${displayName(s)} (pane ${s.paneId})`)
          .join('\n'),
        dispatches: [],
      };

    case 'help':
      return {
        echo: [
          'Routing:',
          '  @<name> body          → 1 session (sets current)',
          '  @<a> @<b> body        → multiple sessions',
          '  @all body             → all alive sessions',
          '  body (no @)           → current session',
          'Matching: $<sid-prefix> → =strict → exact → prefix → glob (*?)',
          'Bridge commands: /list | /help | /current | /start | /stop',
          'Permission: @<tab> /1 (allow) | @<tab> /2 (deny) — 10s default allow',
          'Tip: /rename inside cc TUI sets the @<name> identifier (real-time).',
        ].join('\n'),
        dispatches: [],
      };

    case 'current': {
      const id = state.getCurrent();
      const imWorkLine = `IMWork = ${imWorkOn ? 'ON' : 'OFF'}`;
      if (id === null) {
        return {
          echo: `current = none\n${imWorkLine}`,
          dispatches: [],
        };
      }
      const session = sessions.find((s) => s.sessionId === id);
      if (!session) {
        // Stale current — clear it and report
        state.setCurrent(null);
        return {
          echo: `current = none (previous session disconnected)\n${imWorkLine}`,
          dispatches: [],
        };
      }
      return {
        echo: `current = ${displayName(session)}\n${imWorkLine}`,
        dispatches: [],
      };
    }

    case 'start':
      // /start: enable IM mode. Idempotent — re-running when already on
      // refreshes the cc-list echo (lets user re-check cc inventory).
      if (imWorkOn) {
        return {
          echo: [
            'ℹ️ IMWork already ON',
            '',
            ...formatSessionInventory(sessions),
          ].join('\n'),
          dispatches: [],
        };
      }
      return {
        echo: [
          '✓ IMWork ON',
          '',
          ...formatSessionInventory(sessions),
          '',
          '⚠️ 规则：',
          '  - 只处理从 IM 发出的消息',
          '  - cc 调工具时 IM 收到提示，10 秒内回复 /1 (允许) 或 /2 (拒绝)',
          '  - 超过 10 秒默认放行',
          '  - 终端 cc TUI 直接打字的对话不会 forward 到 IM',
        ].join('\n'),
        dispatches: [],
        imWorkAction: 'enable',
      };

    case 'stop':
      // /stop: disable IM mode. Idempotent.
      if (!imWorkOn) {
        return { echo: 'ℹ️ IMWork already OFF', dispatches: [] };
      }
      return {
        echo: '✓ IMWork OFF — cc 工具问题在终端 TUI 处理',
        dispatches: [],
        imWorkAction: 'disable',
      };

    default:
      return {
        echo: `❌ unknown bridge command: /${command}\n  Try @multi-cc-im /help`,
        dispatches: [],
      };
  }
}

/** Render the cc-list block shown by `/start` echo (numbered, with pane id and rename hint). */
function formatSessionInventory(sessions: readonly SessionInfo[]): string[] {
  if (sessions.length === 0) {
    return ['当前可用 cc sessions: (无 — 请先在 wezterm tab 启动 cc)'];
  }
  const lines = ['当前可用 cc sessions:'];
  sessions.forEach((s, i) => {
    const renameHint =
      s.tabTitle && s.tabTitle.length > 0 ? '' : ', 未 /rename';
    lines.push(
      `  ${i + 1}. ${displayName(s)} (pane ${s.paneId}${renameHint})`,
    );
  });
  return lines;
}

// ============================================================================
// Helpers
// ============================================================================

function displayName(s: SessionInfo): string {
  if (s.tabTitle && s.tabTitle.length > 0) return s.tabTitle;
  // Fall back to short session-id hash so user always has SOMETHING to address.
  // SessionStart hook also pushes a one-time IM hint pointing the user at
  // `/rename` when this fallback path triggers — see orchestrator.
  return `$${s.sessionId.slice(0, 8)}`;
}
