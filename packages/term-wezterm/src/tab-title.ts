import { runWezTermCli } from './cli.js';

/**
 * Strips cc status-prefix glyphs (e.g. `✳ `, `⠐ `, `⠂ `) plus surrounding
 * whitespace from a wezterm pane title. cc emits these as the pane "running /
 * busy" indicator via OSC sequences; for routing / display we want only the
 * user-given name.
 *
 * Char classes covered:
 * - `\p{Emoji_Presentation}` / `\p{Extended_Pictographic}` — broad emoji set
 *   (forward-compatible with future cc state glyphs)
 * - `✀-➿` (U+2700–U+27BF, "Dingbats") — covers `✳` (U+2733) which is NOT in
 *   `Emoji_Presentation` by default
 * - `⠀-⣿` (U+2800–U+28FF, "Braille Patterns") — covers `⠐` and the rest of
 *   cc's spinner sequence
 *
 * Anchored at start with `^`; at most one prefix run is stripped (cc only
 * ever emits one). Trailing `\s+` consumes the separator space cc inserts.
 */
const STATUS_PREFIX_RE = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}✀-➿⠀-⣿]+\s+/u;

/**
 * Default tab titles cc itself sets when the user has not run `/rename`.
 * Treat any of these (after status-prefix stripping) as **unnamed** so the
 * IM-side rename hint kicks in (no `$<sid>` fallback — DD pane-keyed-state
 * removed sid-prefix matching).
 *
 * Without this guard, multiple un-renamed cc sessions would all show up as
 * "Claude Code" in `/list` output and `#<query>` matching, defeating the
 * point of having a friendly identifier at all.
 *
 * Variants observed in real wezterm output:
 * - `Claude Code` — fresh cc on a model the title doesn't annotate
 * - `Claude Code [1m]` — cc on a 1M-context model (e.g. opus-4-7[1m])
 *
 * Match is exact-equals (with the `[…]` suffix optional + arbitrary inner
 * text), case-sensitive — anything the user actually `/rename`'d to "Claude
 * Code" or similar would only collide if they typed it letter-perfectly,
 * which we accept as a quirk (the user can /rename anything else).
 */
const DEFAULT_CC_TITLE_RE = /^Claude Code(\s*\[[^\]]*\])?$/;

export interface TabInfo {
  paneId: number;
  /**
   * Cleaned title — `✳`/`⠐`/etc. status-prefix emoji and surrounding
   * whitespace stripped. Empty string if user has not /rename'd.
   */
  title: string;
  /** Raw value from wezterm cli (e.g. `"file:///private/tmp/cc-smoke"`). */
  cwd: string;
}

interface RawPaneEntry {
  pane_id?: unknown;
  title?: unknown;
  cwd?: unknown;
}

/**
 * Run `wezterm cli list --format json` once, parse all panes, return a Map
 * from paneId → {@link TabInfo}. Used by the bridge to refresh tab names on
 * every IM dispatch / cc → IM forward (no caching — wezterm cli is fast
 * enough; pane titles change as users issue `/rename`).
 *
 * Title normalisation:
 * - `null` / missing / non-string → `""`
 * - leading status emoji + whitespace stripped (see {@link STATUS_PREFIX_RE})
 * - resulting string `.trim()`'d
 * - if the cleaned title equals cc's default ("Claude Code" or "Claude
 *   Code [1m]" etc., see {@link DEFAULT_CC_TITLE_RE}), it's collapsed to
 *   `""` so the router treats this session as un-renamed
 *
 * Entries with missing or non-numeric `pane_id` are silently skipped — those
 * cannot be addressed by send-text anyway, and surfacing them as errors would
 * make this helper brittle against schema drift in future wezterm releases.
 *
 * @param opts.wezterm Pre-resolved absolute path to the wezterm binary.
 * @returns Map keyed by `pane_id` with normalised `TabInfo` values.
 * @throws If `wezterm cli` fails to spawn / run, or returns non-JSON or a
 *   non-array payload.
 *
 * @example
 * const tabs = await listAllTabs({ wezterm: '/opt/homebrew/bin/wezterm' });
 * tabs.get(15)?.title; // "frontend"
 */
export async function listAllTabs(opts: {
  wezterm: string;
}): Promise<Map<number, TabInfo>> {
  const stdout = await runWezTermCli({
    wezterm: opts.wezterm,
    args: ['cli', 'list', '--format', 'json'],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`wezterm cli list: failed to parse JSON output — ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `wezterm cli list: expected JSON array, got ${parsed === null ? 'null' : typeof parsed}`,
    );
  }

  const result = new Map<number, TabInfo>();
  for (const raw of parsed as RawPaneEntry[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const paneId = raw.pane_id;
    if (typeof paneId !== 'number' || !Number.isFinite(paneId)) continue;

    const rawTitle = typeof raw.title === 'string' ? raw.title : '';
    const cleanedTitle = rawTitle.replace(STATUS_PREFIX_RE, '').trim();
    const finalTitle = DEFAULT_CC_TITLE_RE.test(cleanedTitle) ? '' : cleanedTitle;

    const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';

    result.set(paneId, {
      paneId,
      title: finalTitle,
      cwd,
    });
  }

  return result;
}

/**
 * Convenience wrapper: fetch only one pane's title. Returns `undefined` if
 * the pane is not in the listing. Implemented by calling {@link listAllTabs}
 * and looking up — caller pays the cost of fetching all panes (which is what
 * we'd do anyway for refreshing the registry).
 *
 * @param paneId Pane id to look up.
 * @param opts.wezterm Pre-resolved absolute path to the wezterm binary.
 * @returns Cleaned title for the pane, or `undefined` if not found.
 * @throws Same as {@link listAllTabs} (propagates parse / spawn failures).
 */
export async function getTabTitleByPaneId(
  paneId: number,
  opts: { wezterm: string },
): Promise<string | undefined> {
  const tabs = await listAllTabs(opts);
  return tabs.get(paneId)?.title;
}
