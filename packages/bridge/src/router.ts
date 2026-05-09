import type { IncomingMessage, PaneId } from '@multi-cc-im/shared';
import { matchSession, type SessionInfo } from './matcher.js';
import { parse } from './parser.js';

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
   * Bridge commands (`@multi-cc-im /...`) and permission responses
   * (`@<tab> /1` `/2`) always work regardless of IMWork state.
   */
  imWorkOn?: boolean;
  /**
   * Current `IMWork.auto` value when `imWorkOn=true`. Used only by `/current`
   * echo to display the active mode (`auto-approve: ON | OFF`). Per
   * [DD: PreToolUse auto-approve](../../../docs/superpowers/specs/2026-05-08-pretooluse-auto-approve-dd.md).
   * Ignored when `imWorkOn=false`.
   */
  imWorkAuto?: boolean;
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
   * Set when the IM user invoked `@multi-cc-im /start [auto]` or `/stop`.
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
}

/**
 * Route an IncomingMessage. High-level pipeline:
 *   1. parse text → ParsedMessage (parser.ts)
 *   2. handle bridge commands (@multi-cc-im /list / /help / /current / /start / /stop) — always pass IMWork gate
 *   3. handle permission_response (@<tab> /1 /2) — always pass IMWork gate
 *   4. IMWork gate: mention / plain / broadcast require IMWork on
 *   5. handle broadcast (@all) — fan out to all alive
 *   6. handle mention(s) — match each via 4-level fallback (matcher.ts)
 *   7. handle plain — dispatch to current_pane (sticky); auto-set when only 1 pane
 *
 * State invariants:
 *   - **Single-mention with body** updates `current_pane` (last-explicit)
 *   - **Multi-mention / @all / control / plain** does NOT update current
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
  // commands (`@multi-cc-im /...`) + permission responses (`@<tab> /1` `/2`)
  // + parse errors always pass through.
  if (
    !imWorkOn &&
    (parsed.type === 'mention' ||
      parsed.type === 'plain' ||
      parsed.type === 'broadcast')
  ) {
    return {
      echo: '❌ IMWork off — 请先发 `@multi-cc-im /start` 开启 IM 模式',
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
      );

    case 'broadcast':
      return handleBroadcast(parsed.body, sessions);

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
        .join(', ')}. /rename one of them.`,
      dispatches: [],
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
// Plain (no @<name>): dispatch to current_pane
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
        echo: '⚠️ previous current pane disconnected, current cleared. Use `@<name>` to pick a target.',
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
    echo: '❌ no current session — send `@<name>` first or `@multi-cc-im /list`',
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
      const named = sessions.filter((s) => s.tabTitle.length > 0);
      errors.push(
        named.length === 0
          ? `❌ \`@${m}\` not found — no /rename'd cc panes`
          : `❌ \`@${m}\` not found — alive: ${named.map(displayName).join(', ')}`,
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
// @all broadcast
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
// Bridge commands: @multi-cc-im /<command> [args]
// ============================================================================

function handleBridgeCommand(
  command: string,
  args: string,
  sessions: readonly SessionInfo[],
  state: RouterState,
  imWorkOn: boolean,
  imWorkAuto: boolean,
): RouterResult {
  switch (command) {
    case 'list':
      return {
        echo: formatSessionInventory(sessions).join('\n'),
        dispatches: [],
      };

    case 'help':
      return {
        echo: [
          '路由示例：',
          '  hello                      → current cc (last-explicit-mention 粘性；只一个 cc 时自动 = 那一个)',
          '  @frontend hello            → tab title=frontend 的 cc，并设为 current',
          '  @fr hello                  → 短前缀（4 级 fallback：=strict → exact → prefix → glob；歧义列候选拒绝）',
          '  @frontend @api sync        → 多目标分发；不改 current',
          '  @frontend /clear           → 转发 /clear 进 cc TUI（cc 自己当 slash 命令处理）',
          '  @all stop everything       → 广播给所有 /rename\'d cc',
          '  @frontend /1   /  /2       → 权限允许 / 拒绝（仅当有 pending PreToolUse）',
          '',
          'Bridge 命令（@multi-cc-im /...）：',
          '  /list                      → 列当前 wezterm tabs（含可寻址状态）',
          '  /help                      → 本帮助',
          '  /current                   → 显示 current_session + IMWork 状态',
          '  /start                     → 开启 IM 模式（cc 回复 + 工具审批转发到微信）',
          '  /stop                      → 关闭 IM 模式（cc 回复留 cc TUI，工具审批走 cc 原生菜单）',
          '',
          'Tip: 进 cc TUI 跑 /rename <name> 设 @<name> 寻址（real-time，cc /resume 也带）；',
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
          '',
          ...formatSessionInventory(sessions),
          ...formatNumericTabWarning(sessions),
          ...formatDuplicateTabWarning(sessions),
          '',
          '⚠️ 规则：',
          '  - IM 路由只用 tab title (cc /rename 设的)',
          '  - 没 /rename 的 cc 只能在 cc TUI 里用，IM 寻址不到',
          '  - 建议 tab title 用字母/单词，**不要用纯数字** (易混淆)',
          '  - cc 回复转发到 IM (Stop hook)',
          autoTipLine,
          '  - 终端 cc TUI 直接打字不会 forward 到 IM',
          '',
          '完整命令说明：发 @multi-cc-im /help',
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
        echo: `❌ unknown bridge command: /${command}\n  Try @multi-cc-im /help`,
        dispatches: [],
      };
  }
}

/**
 * Render the wezterm-tabs inventory block for `/start` + `/list` echoes.
 *
 * Lists **all** wezterm panes (zsh / cc / vim / 任何东西) — daemon 不知道每个
 * pane 里跑啥，只知道 tab title 是不是被 /rename 过。每行显示寻址状态：
 *   - 有 /rename → `[可寻址 @<name>]`
 *   - 没 /rename → `[未 /rename — 进 cc TUI 跑 /rename <name>]`
 */
function formatSessionInventory(sessions: readonly SessionInfo[]): string[] {
  if (sessions.length === 0) {
    return ['当前 wezterm tabs: (无 — 请先开 wezterm tab 启动 cc 并 /rename)'];
  }
  const lines = ['当前 wezterm tabs:'];
  sessions.forEach((s, i) => {
    const status =
      s.tabTitle.length > 0
        ? `[可寻址 @${s.tabTitle}]`
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
