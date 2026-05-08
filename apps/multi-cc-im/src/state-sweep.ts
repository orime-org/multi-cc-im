import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DAEMON_PID_FILE_NAME,
  IM_WORK_FILE_NAME,
  daemonPidPath,
  extractPaneIdFromFilename,
  isDaemonAlive,
} from '@multi-cc-im/cli-cc';

/**
 * Daemon startup / `multi-cc-im cleanup` state-directory sweep.
 *
 * Per [DD: pane-keyed state files](../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * (DD #61): state files are pane-keyed (`<paneId>_<sid>.<event>` and
 * `<paneId>.IMOrigin`). The wezterm `cli list` paneId set is the ground
 * truth — files for paneIds **not in the live set** are stale and get
 * cleaned.
 *
 * Cleanup classes:
 *
 * 1. **Pane-keyed orphans** — any `<paneId>...` file whose paneId is not in
 *    the current wezterm paneId set. These came from cc sessions that have
 *    since exited (the wezterm pane closed too) or pre-DD-#61 schema
 *    artifacts (sid-keyed files don't extract a paneId, so they're treated
 *    as orphans automatically).
 *
 * 2. **Stale `daemon.pid`** — file exists but `isDaemonAlive` returns false
 *    (PID dead OR lstart mismatch from PID reuse). Per
 *    [DD: daemon liveness](../../docs/superpowers/specs/2026-05-09-daemon-liveness-dd.md).
 *    A live daemon's lock file is **kept**, so `multi-cc-im cleanup` is safe
 *    to run while the daemon is up.
 *
 * 3. **Legacy state files from pre-DD-#61 installs** — `<sid>.SessionStart`,
 *    `<sid>.SessionEnd`, sid-keyed Stop/Permission/IMOrigin, and even
 *    older legacy (`<sid>.cc-pid`, `current-session`, `<sid>.events.jsonl`,
 *    etc.). These don't have a paneId we can extract → swept regardless.
 *
 * Top-level files NEVER swept here:
 * - `IMWork` (managed by daemon start/stop + IM `/start /stop`)
 * - `wechat-cursor` (iLink protocol state, must persist across restart)
 *
 * The sweep MUST run before chokidar starts watching at daemon start
 * (otherwise the unlinks would fire spurious chokidar events).
 */

export interface SweepStaleStateFilesResult {
  /** Files removed because their paneId no longer exists in wezterm. */
  orphanPaneFilesCleaned: number;
  /**
   * Files removed because they don't match any current naming convention
   * (legacy `<sid>.SessionStart` etc. from pre-DD-#61 schema). Distinct
   * from orphanPaneFilesCleaned: legacy files don't have a paneId in their
   * name at all.
   */
  legacyCleaned: number;
  /**
   * 1 if `daemon.pid` was stale (PID dead / lstart mismatch) and got
   * cleaned, 0 otherwise (file absent OR daemon alive — kept).
   */
  staleDaemonPidCleaned: number;
}

export interface SweepStaleStateFilesOpts {
  /**
   * Preview only — count what would be deleted without actually deleting.
   * Used by `multi-cc-im cleanup --dry-run`. Default false (real delete).
   */
  dryRun?: boolean;
  /**
   * Source of truth for "currently alive" wezterm panes. If omitted, the
   * sweep treats EVERY pane-keyed file as orphan (= "no panes alive
   * anywhere", scorched-earth daemon-start mode). Caller (daemon start)
   * passes a real `() => listPanes()` so live cc files survive.
   *
   * Returning [] (no panes) is fine — interpreted as "wezterm not running
   * or empty, all files are orphans".
   *
   * Returning a function that **throws** is treated as "cannot determine
   * truth → keep all pane-keyed files" (defensive fail-safe; better to
   * leak a few orphan files than wipe a live cc's state).
   */
  livePaneIds?: () => Promise<readonly number[]>;
}

const LEGACY_BASE_NAMES_TOP_LEVEL = new Set([
  // pre-DD-#61 top-level legacy
  'current-session',
]);

const LEGACY_SUFFIXES = [
  // pre-DD-#61 sid-keyed schema (everything that wasn't paneId-prefixed)
  '.SessionStart',
  '.SessionEnd',
  '.cc-pid',
  '.events.jsonl',
  '.ended',
  '.last-hook-at',
];

/**
 * Sweep `<stateDir>` per the rules above. Returns a summary the caller can
 * log; throws on unexpected fs errors (ENOENT on stateDir itself is
 * treated as no-op, not an error).
 */
export async function sweepStaleStateFiles(
  stateDir: string,
  sweepOpts: SweepStaleStateFilesOpts = {},
): Promise<SweepStaleStateFilesResult> {
  const dryRun = sweepOpts.dryRun ?? false;
  const remove = async (filePath: string): Promise<void> => {
    if (dryRun) return;
    await unlinkSafely(filePath);
  };

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        orphanPaneFilesCleaned: 0,
        legacyCleaned: 0,
        staleDaemonPidCleaned: 0,
      };
    }
    throw err;
  }

  // Resolve live paneId set (defensive — if caller's listPanes throws,
  // keep all pane-keyed files).
  let liveSet: Set<number> | null = null;
  if (sweepOpts.livePaneIds) {
    try {
      const ids = await sweepOpts.livePaneIds();
      liveSet = new Set(ids);
    } catch {
      // Defensive: cannot determine truth → assume "all alive" so we
      // don't accidentally wipe live cc state.
      liveSet = null;
    }
  } else {
    liveSet = new Set();
  }

  let orphanPaneFilesCleaned = 0;
  let legacyCleaned = 0;
  let staleDaemonPidCleaned = 0;

  for (const name of entries) {
    // Top-level files we never touch:
    if (name === IM_WORK_FILE_NAME) continue;
    if (name === 'wechat-cursor') continue;

    // daemon.pid — check liveness; keep if alive.
    if (name === DAEMON_PID_FILE_NAME) {
      const alive = await isDaemonAlive(stateDir).catch(() => false);
      if (!alive) {
        await remove(daemonPidPath(stateDir));
        staleDaemonPidCleaned = 1;
      }
      continue;
    }

    // Top-level legacy file from pre-DD-#61 era.
    if (LEGACY_BASE_NAMES_TOP_LEVEL.has(name)) {
      await remove(join(stateDir, name));
      legacyCleaned++;
      continue;
    }

    // Per-pane file (paneId-keyed): extract paneId, check live set.
    const paneId = extractPaneIdFromFilename(name);
    if (paneId !== null) {
      if (liveSet === null) continue; // defensive — keep, can't verify
      if (!liveSet.has(paneId)) {
        await remove(join(stateDir, name));
        orphanPaneFilesCleaned++;
      }
      continue;
    }

    // Legacy sid-keyed file (no paneId in name) — pre-DD-#61 schema artifact.
    if (LEGACY_SUFFIXES.some((suf) => name.endsWith(suf))) {
      await remove(join(stateDir, name));
      legacyCleaned++;
      continue;
    }

    // Unknown file with sid-prefix shape (pre-DD-#61 IMOrigin / Stop /
    // Permission* before paneId got prefixed). Match common sid-prefixed
    // patterns and treat as legacy.
    const SID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./;
    if (SID_RE.test(name)) {
      await remove(join(stateDir, name));
      legacyCleaned++;
      continue;
    }

    // Anything else — leave alone (logs / config spillover / user files).
  }

  return {
    orphanPaneFilesCleaned,
    legacyCleaned,
    staleDaemonPidCleaned,
  };
}

async function unlinkSafely(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
