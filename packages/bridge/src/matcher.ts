import type { PaneId } from '@multi-cc-im/shared';

/**
 * Reserved tab name that always refers to the bridge daemon itself rather
 * than any cc session. `@multi-cc-im /list` etc. are bridge commands. Users
 * cannot legitimately /rename a cc to this string (router rejects it on
 * matcher entry).
 */
export const RESERVED_BRIDGE_NAME = 'multi-cc-im';

/**
 * Per-pane info needed for routing decisions. Bridge orchestrator builds
 * this directly from `TermListPanes.listPanes()` (wezterm cli list) — no
 * file-system join with SessionStart files.
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 * daemon doesn't track cc sessionId. The cc-stable session uuid lives in
 * cc-fired hook files (`<paneId>_<sid>.<event>`); daemon parses sid out
 * of those filenames when needed but never holds it as routing state.
 */
export interface SessionInfo {
  paneId: PaneId;
  /**
   * Tab title set via cc's `/rename <name>` slash command, observed via
   * `wezterm cli list --format json`. Empty string means the user has not
   * named this cc — IM cannot route to it; user is told to `/rename` first.
   */
  tabTitle: string;
  /** Working dir of the foreground process in the pane (URI form from wezterm). */
  cwd: string;
}

export type MatchResult =
  | { type: 'unique'; session: SessionInfo }
  | { type: 'ambiguous'; candidates: SessionInfo[] }
  | { type: 'none' };

/**
 * Resolve a `@<query>` token to a SessionInfo via tmux-style 4-level
 * fallback over the user-set tab title (cc `/rename`):
 *
 * 1. **`=<exact>`** — strict exact tabTitle match
 * 2. **exact** — tabTitle === query
 * 3. **prefix** — tabTitle.startsWith(query)
 * 4. **glob** — fnmatch (`*` and `?`) over tabTitle
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 * the legacy `$<sid-prefix>` (level 0) was removed because daemon no longer
 * tracks sessionId. Users without `/rename` simply can't route from IM
 * (the `/start` echo + `/list` flag this with a "未 /rename" hint).
 *
 * At each level: 0 candidates → next level / `none` / 1 → unique /
 * 2+ → `ambiguous` (do **not** fall through). Caller (router) reports
 * candidates verbatim back to user as a numbered list so they can fix
 * the duplicate names.
 *
 * Reserved name `multi-cc-im` is filtered out before matching — even if a
 * user manages to /rename a cc to that string, it's never resolvable to a
 * session (router treats `@multi-cc-im` as a bridge command target).
 */
export function matchSession(
  query: string,
  sessions: readonly SessionInfo[],
): MatchResult {
  if (query.length === 0) return { type: 'none' };
  if (query === RESERVED_BRIDGE_NAME) return { type: 'none' };

  // Level 1: =<exact> — strict exact tabTitle
  if (query.startsWith('=')) {
    const exactQuery = query.slice(1);
    const matches = sessions.filter((s) => s.tabTitle === exactQuery);
    return finalize(matches);
  }

  // Level 2: exact tabTitle
  const exactMatches = sessions.filter((s) => s.tabTitle === query);
  if (exactMatches.length > 0) return finalize(exactMatches);

  // Level 3: prefix tabTitle
  const prefixMatches = sessions.filter(
    (s) => s.tabTitle.length > 0 && s.tabTitle.startsWith(query),
  );
  if (prefixMatches.length > 0) return finalize(prefixMatches);

  // Level 4: glob tabTitle (* and ?)
  const globMatches = sessions.filter(
    (s) => s.tabTitle.length > 0 && globMatch(query, s.tabTitle),
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
 * No bracket expressions, no character classes.
 */
function globMatch(pattern: string, target: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  );
  return regex.test(target);
}
