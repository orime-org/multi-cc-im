import type { CwdAbs, FriendlyName, PaneId, SessionId } from '@multi-cc-im/shared';

/**
 * Per-session info needed for routing decisions. Bridge orchestrator builds
 * this from cli-cc state files (cc-pid + WEZTERM_PANE captured at SessionStart)
 * + ConfigStore `[friendly_names]` lookup.
 */
export interface SessionInfo {
  sessionId: SessionId;
  paneId: PaneId;
  /** User-configured short name (`[friendly_names]` in config.toml). */
  friendlyName: FriendlyName | undefined;
  cwd: CwdAbs;
}

export type MatchResult =
  | { type: 'unique'; session: SessionInfo }
  | { type: 'ambiguous'; candidates: SessionInfo[] }
  | { type: 'none' };

/**
 * Resolve a `@<query>` token to a SessionInfo per [DD: 路由语法 G' tmux 4 级
 * fallback](../../../docs/superpowers/specs/2026-05-04-routing-syntax-dd.md):
 *
 * 1. **`$<id-prefix>`** — strict, match by SessionId short hash (no fallback)
 * 2. **`=<exact>`** — strict, exact friendly_name match (no prefix / glob)
 * 3. **exact** — friendly_name === query
 * 4. **prefix** — friendly_name.startsWith(query)
 * 5. **glob** — fnmatch (`*` and `?`) over friendly_name
 *
 * At each level: 0 candidates → next level / `none` / 1 → unique / 2+ →
 * `ambiguous` (do **not** fall through). Caller (router) reports candidates
 * verbatim back to user as a list.
 */
export function matchSession(
  query: string,
  sessions: readonly SessionInfo[],
): MatchResult {
  if (query.length === 0) return { type: 'none' };

  // Level 1: $<id-prefix> — strict id-only
  if (query.startsWith('$')) {
    const idQuery = query.slice(1);
    const idMatches = sessions.filter((s) => s.sessionId.startsWith(idQuery));
    return finalize(idMatches);
  }

  // Level 2: =<exact> — strict exact friendly_name
  if (query.startsWith('=')) {
    const exactQuery = query.slice(1);
    const matches = sessions.filter((s) => s.friendlyName === exactQuery);
    return finalize(matches);
  }

  // Level 3: exact friendly_name
  const exactMatches = sessions.filter((s) => s.friendlyName === query);
  if (exactMatches.length > 0) return finalize(exactMatches);

  // Level 4: prefix friendly_name
  const prefixMatches = sessions.filter(
    (s) => s.friendlyName !== undefined && s.friendlyName.startsWith(query),
  );
  if (prefixMatches.length > 0) return finalize(prefixMatches);

  // Level 5: glob friendly_name (* and ?)
  const globMatches = sessions.filter(
    (s) => s.friendlyName !== undefined && globMatch(query, s.friendlyName),
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
