import { readdir } from 'node:fs/promises';
import type {
  CwdAbs,
  PaneId,
  PaneToSessionMap,
  SessionId,
} from '@multi-cc-im/shared';
import {
  SESSION_START_SUFFIX,
  existsSessionEndFile,
  readSessionStartFile,
} from '@multi-cc-im/cli-cc';
import {
  defaultPidProbe,
  type PidProbe,
  type TabInfo,
} from '@multi-cc-im/term-wezterm';
import type { SessionInfo } from './matcher.js';
import type { SessionRegistry } from './router.js';

export interface CreateSessionRegistryOpts {
  /** Where cli-cc state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /**
   * Callback to fetch the latest wezterm pane → tab-title mapping. Invoked
   * once per `listAlive()` call. The orchestrator wires this to
   * `listAllTabs({ wezterm })` so every IM-touching event (inbound dispatch
   * + outbound forward) sees the user's most recent `/rename`. Returning
   * `undefined` is allowed — used in tests to skip wezterm entirely.
   */
  getTabTitles?: () => Promise<Map<number, TabInfo>>;
  /** Test seam — defaults to `defaultPidProbe` from `@multi-cc-im/term-wezterm`. */
  pidProbe?: PidProbe;
}

/**
 * Joins SessionRegistry (bridge router consumer) + PaneToSessionMap (term-wezterm
 * PaneAlive consumer) into one object backed by a single state-dir scan. Caller
 * must call `listAlive()` to refresh the map cache; the synchronous `get(paneId)`
 * lookup uses the latest snapshot.
 */
export interface SessionRegistryAndMap extends SessionRegistry, PaneToSessionMap {}

/**
 * Build a session registry from cli-cc state files + (optionally) a wezterm
 * tab-title fetcher.
 *
 * `listAlive()` work:
 *   1. Scan `<stateDir>/*.SessionStart` files to get all sessions cc has
 *      started.
 *   2. For each: skip if `<sid>.SessionEnd` exists (cc died gracefully).
 *      Read `<sid>.SessionStart` for pid + startedAt + paneId + cwd. Run
 *      PID liveness check (`kill -0` + `ps -o lstart=` exact-match for PID
 *      reuse defense — same logic as term-wezterm PaneAlive, duplicated
 *      here to avoid circular dep on PaneAlive which itself consumes this
 *      registry).
 *   3. Drop sessions without `paneId` (cc ran outside wezterm — not
 *      routable from bridge).
 *   4. If `getTabTitles` is provided, call it once and attach `tabTitle`
 *      to each alive `SessionInfo` from the returned `paneId → TabInfo`
 *      map (caller-provided `cc /rename` source). Empty / missing title
 *      becomes `undefined` so router fallback kicks in (`$<sid8>` + rename
 *      hint).
 *   5. Refresh internal `paneId → sessionId` cache for subsequent `get()`.
 *
 * `get(paneId)` is synchronous (matches `PaneToSessionMap` contract) and
 * lookup-only — caller must `listAlive()` first to populate the cache.
 * Empty cache → returns `null` (term-wezterm PaneAlive treats `null` as
 * "unknown pane → conservative dead" per its decision lattice).
 */
export function createSessionRegistry(
  opts: CreateSessionRegistryOpts,
): SessionRegistryAndMap {
  const stateDir = opts.stateDir;
  const pidProbe = opts.pidProbe ?? defaultPidProbe;

  let paneCache = new Map<number, SessionId>();

  return {
    async listAlive(): Promise<readonly SessionInfo[]> {
      const sessionIds = await scanSessionIds(stateDir);

      // Fetch tab titles once per call. If the fetch throws (wezterm cli
      // unavailable etc.), fall back to "no titles" — sessions still resolve
      // by `$sid8`, just without friendly names this turn.
      let tabTitleByPaneId: Map<number, TabInfo> | null = null;
      if (opts.getTabTitles) {
        try {
          tabTitleByPaneId = await opts.getTabTitles();
        } catch {
          tabTitleByPaneId = null;
        }
      }

      const alive: SessionInfo[] = [];
      const newCache = new Map<number, SessionId>();

      for (const sessionId of sessionIds) {
        if (await existsSessionEndFile({ stateDir, sessionId })) continue;

        const startFile = await readSessionStartFile({ stateDir, sessionId });
        if (!startFile) continue;

        // PID reuse defense: kill -0 PID alive AND ps lstart matches what
        // we captured at SessionStart. Either fails → cc died.
        if (!pidProbe.isAlive(startFile.pid)) continue;
        let lstart: string;
        try {
          lstart = await pidProbe.getLstart(startFile.pid);
        } catch {
          continue;
        }
        if (lstart !== startFile.startedAt) continue;

        // Bridge needs paneId+cwd to route — drop sessions without paneId
        // (cc ran outside wezterm — not routable from bridge).
        if (startFile.paneId === undefined) continue;

        const tab = tabTitleByPaneId?.get(startFile.paneId);
        const tabTitle =
          tab && tab.title.length > 0 ? tab.title : undefined;

        alive.push({
          sessionId: sessionId as SessionId,
          paneId: startFile.paneId as PaneId,
          tabTitle,
          cwd: startFile.cwd as CwdAbs,
        });
        newCache.set(startFile.paneId, sessionId as SessionId);
      }

      paneCache = newCache;
      return alive;
    },

    get(paneId: PaneId): SessionId | null {
      return paneCache.get(paneId as unknown as number) ?? null;
    },
  };
}

/** Scan stateDir for `<sessionId>.SessionStart` files and return sessionIds. */
async function scanSessionIds(stateDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(SESSION_START_SUFFIX))
    .map((name) => name.slice(0, -SESSION_START_SUFFIX.length));
}
