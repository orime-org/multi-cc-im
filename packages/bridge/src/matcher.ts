import type { CwdAbs, PaneId, SessionId } from '@multi-cc-im/shared';

/**
 * Reserved tab name that always refers to the bridge daemon itself rather
 * than any cc session. `@multi-cc-im /list` etc. are bridge commands. Users
 * cannot legitimately /rename a cc to this string (router rejects it on
 * matcher entry).
 */
export const RESERVED_BRIDGE_NAME = 'multi-cc-im';

/**
 * Per-session info needed for routing decisions. Bridge orchestrator builds
 * this from cli-cc state files (cc-pid + WEZTERM_PANE captured at
 * SessionStart) and refreshes `tabTitle` on every IM-touching event by
 * polling `wezterm cli list --format json` — see [DD: routing-syntax G']
 * (../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md).
 */
export interface SessionInfo {
  sessionId: SessionId;
  paneId: PaneId;
  /**
   * Tab title set via cc's `/rename <name>` slash command, observed via
   * `wezterm cli list --format json`. `undefined` means the user has not
   * named this cc yet — display falls back to `$<sid8>` and the bridge
   * sends a one-time hint to IM at SessionStart.
   */
  tabTitle: string | undefined;
  cwd: CwdAbs;
}

export type MatchResult =
  | { type: 'unique'; session: SessionInfo }
  | { type: 'ambiguous'; candidates: SessionInfo[] }
  | { type: 'none' };

/**
 * Resolve a `@<query>` token to a SessionInfo via tmux-style 5-level fallback
 * over the user-set tab title (cc `/rename`):
 *
 * 1. **`$<id-prefix>`** — strict, match by SessionId short hash
 * 2. **`=<exact>`** — strict exact tabTitle match
 * 3. **exact** — tabTitle === query
 * 4. **prefix** — tabTitle.startsWith(query)
 * 5. **glob** — fnmatch (`*` and `?`) over tabTitle
 *
 * At each level: 0 candidates → next level / `none` / 1 → unique /
 * 2+ → `ambiguous` (do **not** fall through). Caller (router) reports
 * candidates verbatim back to user as a numbered list with `$sid8` so they
 * can disambiguate via `$<id-prefix>`.
 *
 * Reserved name `multi-cc-im` is filtered out before matching — even if a
 * user manages to /rename a cc to that string, it's never resolvable to a
 * session (the router treats `@multi-cc-im` as a bridge command target).
 */
export function matchSession(
  query: string,
  sessions: readonly SessionInfo[],
): MatchResult {
  if (query.length === 0) return { type: 'none' };
  if (query === RESERVED_BRIDGE_NAME) return { type: 'none' };

  // Level 1: $<id-prefix> — strict id-only
  if (query.startsWith('$')) {
    const idQuery = query.slice(1);
    const idMatches = sessions.filter((s) => s.sessionId.startsWith(idQuery));
    return finalize(idMatches);
  }

  // Level 2: =<exact> — strict exact tabTitle
  if (query.startsWith('=')) {
    const exactQuery = query.slice(1);
    const matches = sessions.filter((s) => s.tabTitle === exactQuery);
    return finalize(matches);
  }

  // Level 3: exact tabTitle
  const exactMatches = sessions.filter((s) => s.tabTitle === query);
  if (exactMatches.length > 0) return finalize(exactMatches);

  // Level 4: prefix tabTitle
  const prefixMatches = sessions.filter(
    (s) => s.tabTitle !== undefined && s.tabTitle.startsWith(query),
  );
  if (prefixMatches.length > 0) return finalize(prefixMatches);

  // Level 5: glob tabTitle (* and ?)
  const globMatches = sessions.filter(
    (s) => s.tabTitle !== undefined && globMatch(query, s.tabTitle),
  );
  return finalize(globMatches);
}

function finalize(candidates: SessionInfo[]): MatchResult {
  if (candidates.length === 0) return { type: 'none' };
  if (candidates.length === 1) return { type: 'unique', session: candidates[0]! };
  return { type: 'ambiguous', candidates };
}

/**
 * fnmatch-style glob: `*` matches any run of chars, `?` matches single char.
 * No bracket expressions, no character classes — keeps the surface minimal
 * matching what users expect from typical IM searches.
 */
function globMatch(pattern: string, target: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return regex.test(target);
}
