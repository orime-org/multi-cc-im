import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Daemon startup state-directory sweep.
 *
 * Cleans up two categories of stale files:
 *
 * 1. **Paired `<sid>.SessionStart` + `<sid>.SessionEnd`**: cc died (gracefully
 *    or while daemon was down). Delete the pair plus any leftover
 *    `<sid>.Stop.*` files for that sid.
 *
 * 2. **Lone `<sid>.SessionStart` with leftover `<sid>.Stop.*`** (no
 *    SessionEnd): cc is probably still alive but the daemon was down when
 *    the cc replied. The wechat replyCtx is in-memory only and was lost on
 *    daemon restart, so we have nowhere to forward those replies — delete
 *    the Stop files so they don't replay endlessly.
 *
 * 3. **Legacy state files from pre-redesign installs**: `<sid>.cc-pid`,
 *    `<sid>.events.jsonl`, `<sid>.ended`, `<sid>.last-hook-at`, and the
 *    top-level `current-session` pointer. These have no consumers in the
 *    new design; delete on sight to keep `state/` clean.
 *
 * The sweep MUST run before chokidar starts watching (otherwise the
 * unlinks would fire spurious chokidar events).
 */

interface SidGroup {
  sid: string;
  hasStart: boolean;
  hasEnd: boolean;
  stopFiles: string[];
  legacyFiles: string[];
  permissionFiles: string[];
  imOriginFile: string | null;
}

const LEGACY_SUFFIXES = [
  '.cc-pid',
  '.events.jsonl',
  '.ended',
  '.last-hook-at',
];

export interface SweepStaleStateFilesResult {
  /** Number of fully-completed (SessionStart+SessionEnd) sessions cleaned up. */
  pairedCleaned: number;
  /** Number of orphan Stop files deleted (daemon-down accumulation). */
  orphanStopsCleaned: number;
  /** Number of legacy pre-redesign state files deleted. */
  legacyCleaned: number;
  /**
   * Number of orphan PermissionRequest/Response files deleted. Hook subprocess
   * normally cleans up both files itself; orphans only appear when the
   * subprocess crashed or the daemon died mid-flow.
   */
  orphanPermissionCleaned: number;
  /**
   * Number of `<sid>.IMOrigin` files deleted. Per [DD: IMWork+IMOrigin] —
   * sweep runs at daemon start (always cleans) and from `multi-cc-im cleanup`
   * (cleans only IMOrigin for sids that already have SessionEnd, i.e. cc
   * already dead — running cleanup with a live cc must NOT clobber its
   * pending reply ctx). IMWork file itself is **NOT** swept here (A scheme):
   * cleanup leaves user's manual IM-mode toggle intact; only `daemon start`
   * separately deletes IMWork.
   */
  orphanIMOriginCleaned: number;
}

export interface SweepStaleStateFilesOpts {
  /**
   * Preview only — count what would be deleted without actually deleting.
   * Used by `multi-cc-im cleanup --dry-run`. Default false (real delete).
   */
  dryRun?: boolean;
}

/**
 * Sweep `<stateDir>` per the rules in the module header. Returns a summary
 * the caller can log; throws on unexpected fs errors (ENOENT on stateDir
 * itself is treated as no-op, not an error).
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
        pairedCleaned: 0,
        orphanStopsCleaned: 0,
        legacyCleaned: 0,
        orphanPermissionCleaned: 0,
        orphanIMOriginCleaned: 0,
      };
    }
    throw err;
  }

  const groups = new Map<string, SidGroup>();
  let topLevelLegacyCount = 0;

  for (const name of entries) {
    if (name === 'current-session') {
      // Top-level legacy file from PR-B1 era — delete unconditionally.
      await remove(join(stateDir, name));
      topLevelLegacyCount++;
      continue;
    }

    const sid = extractSid(name);
    if (!sid) continue;
    const rest = name.slice(sid.length);
    let group = groups.get(sid);
    if (!group) {
      group = {
        sid,
        hasStart: false,
        hasEnd: false,
        stopFiles: [],
        legacyFiles: [],
        permissionFiles: [],
        imOriginFile: null,
      };
      groups.set(sid, group);
    }

    if (rest === '.SessionStart') group.hasStart = true;
    else if (rest === '.SessionEnd') group.hasEnd = true;
    else if (rest.startsWith('.Stop.')) {
      group.stopFiles.push(join(stateDir, name));
    } else if (
      rest.startsWith('.PermissionRequest.') ||
      rest.startsWith('.PermissionResponse.')
    ) {
      // Hook subprocess + daemon both clean these up in the happy path.
      // Sweep on startup is the safety net for crash-mid-flow orphans —
      // they're meaningless on a fresh daemon (the polling subprocess is
      // gone) so always drop.
      group.permissionFiles.push(join(stateDir, name));
    } else if (rest === '.IMOrigin') {
      group.imOriginFile = join(stateDir, name);
    } else if (LEGACY_SUFFIXES.some((suf) => rest === suf)) {
      group.legacyFiles.push(join(stateDir, name));
    }
  }

  let pairedCleaned = 0;
  let orphanStopsCleaned = 0;
  let legacyCleaned = topLevelLegacyCount;
  let orphanPermissionCleaned = 0;
  let orphanIMOriginCleaned = 0;

  for (const group of groups.values()) {
    // Always cleanup legacy files regardless of paired/lone state.
    for (const f of group.legacyFiles) {
      await remove(f);
      legacyCleaned++;
    }

    // Permission Request/Response files are always orphans on daemon
    // startup — the polling hook subprocess they refer to is gone.
    for (const f of group.permissionFiles) {
      await remove(f);
      orphanPermissionCleaned++;
    }

    if (group.hasStart && group.hasEnd) {
      // Completed session — delete the 3-set (start + end + leftover stops)
      // PLUS any IMOrigin (cc dead → no further forwards needed).
      await remove(join(stateDir, `${group.sid}.SessionStart`));
      await remove(join(stateDir, `${group.sid}.SessionEnd`));
      for (const f of group.stopFiles) await remove(f);
      if (group.imOriginFile !== null) {
        await remove(group.imOriginFile);
        orphanIMOriginCleaned++;
      }
      pairedCleaned++;
      orphanStopsCleaned += group.stopFiles.length;
    } else if (group.hasStart && !group.hasEnd) {
      // cc still alive (probably) but daemon-down accumulated Stop files
      // can't be forwarded — replyCtx is in-memory and was lost. Delete
      // Stop files so they don't replay forever. IMOrigin is **kept** —
      // cc is alive, so the next IM dispatch may reuse it. (For daemon
      // start sweep, callers explicitly clean ALL IMOrigin via separate
      // step in start.ts; cleanup command must NOT clobber a live cc's
      // pending IM ctx, so the kept-here logic protects that case.)
      for (const f of group.stopFiles) await remove(f);
      orphanStopsCleaned += group.stopFiles.length;
    } else if (!group.hasStart && group.hasEnd) {
      // Orphan SessionEnd (shouldn't happen — defensive cleanup).
      await remove(join(stateDir, `${group.sid}.SessionEnd`));
      if (group.imOriginFile !== null) {
        await remove(group.imOriginFile);
        orphanIMOriginCleaned++;
      }
    } else {
      // No SessionStart, no SessionEnd, possibly some Stop files from a
      // very stale daemon-down state. Drop them. IMOrigin without any
      // SessionStart marker → the cc that owned it is gone; clean it.
      for (const f of group.stopFiles) await remove(f);
      orphanStopsCleaned += group.stopFiles.length;
      if (group.imOriginFile !== null) {
        await remove(group.imOriginFile);
        orphanIMOriginCleaned++;
      }
    }
  }

  return {
    pairedCleaned,
    orphanStopsCleaned,
    legacyCleaned,
    orphanPermissionCleaned,
    orphanIMOriginCleaned,
  };
}

/** UUID v4 prefix matcher for our state-file naming convention. */
const SID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function extractSid(name: string): string | null {
  const m = SID_PATTERN.exec(name);
  return m ? m[1]! : null;
}

async function unlinkSafely(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
