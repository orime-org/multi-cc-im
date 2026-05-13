/**
 * Title cleanup for iTerm2 sessions. Mirror of
 * `packages/term-wezterm/src/tab-title.ts` — same regexes, same semantics,
 * just consumes iterm2-helper's `listSessions` rows instead of
 * `wezterm cli list` rows. Keeps the cleanup logic per-adapter so each
 * terminal can evolve its own raw-input quirks independently.
 *
 * The two rules:
 *   1. cc emits OSC-set status-prefix glyphs (`✳`, `⠐` braille spinner,
 *      etc.) in the tab title to indicate "running / busy". Strip them
 *      so routing and `/list` show the user's intended name.
 *   2. Default cc-set titles (`Claude Code`, `Claude Code [1m]`, etc.)
 *      coalesce to empty string so they don't shadow user-renamed
 *      sessions — multi-cc-im's `/rename` flow expects an empty title
 *      to mean "un-named, not addressable from IM".
 */

const STATUS_PREFIX_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}✀-➿⠀-⣿]+\s+/u;
const DEFAULT_CC_TITLE_RE = /^Claude Code(\s*\[[^\]]*\])?$/;

/**
 * Apply cc emoji-prefix strip + default-title coalesce. Pure function;
 * empty input stays empty.
 */
export function cleanTitle(raw: string): string {
  const stripped = raw.replace(STATUS_PREFIX_RE, '').trim();
  if (DEFAULT_CC_TITLE_RE.test(stripped)) return '';
  return stripped;
}

/**
 * Normalize iTerm2's `session.path` variable — the raw value is a plain
 * absolute path. We return it as-is (no `file://` URI prefix like
 * wezterm uses) so the consumer (bridge router) can treat it uniformly
 * with the wezterm-cleaned form. Returns empty string for empty input.
 */
export function cleanCwd(raw: string): string {
  return raw.trim();
}
