import { readdir } from 'node:fs/promises';
import type {
  ConfigStore,
  CwdAbs,
  FriendlyName,
  PaneId,
  PaneToSessionMap,
  SessionId,
} from '@multi-cc-im/shared';
import {
  readCcPid,
  readEnded,
  readLastHookAt,
} from '@multi-cc-im/cli-cc';
import { defaultPidProbe, type PidProbe } from '@multi-cc-im/term-wezterm';
import type { SessionInfo } from './matcher.js';
import type { SessionRegistry } from './router.js';

const CC_PID_SUFFIX = '.cc-pid';
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface CreateSessionRegistryOpts {
  /** Where cli-cc state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /** ConfigStore to read user-configured `[friendly_names]` from `config.toml`. */
  configStore: ConfigStore;
  /** Test seam — defaults to `defaultPidProbe` from `@multi-cc-im/term-wezterm`. */
  pidProbe?: PidProbe;
  /** Idle-timeout fallback — propagated to per-session liveness check. */
  idleTimeoutMs?: number;
}

/**
 * Joins SessionRegistry (bridge router consumer) + PaneToSessionMap (term-wezterm
 * PaneAlive consumer) into one object backed by a single state-dir scan. Caller
 * must call `listAlive()` to refresh the map cache; the synchronous `get(paneId)`
 * lookup uses the latest snapshot.
 */
export interface SessionRegistryAndMap extends SessionRegistry, PaneToSessionMap {}

/**
 * Build a session registry from cli-cc state files + ConfigStore friendly_names.
 *
 * `listAlive()` work:
 *   1. Scan `<stateDir>/*.cc-pid` files to get all sessions cc has ever started
 *   2. For each, run the **same 4-signal liveness check** as term-wezterm
 *      PaneAlive (SessionEnd file → PID kill -0 → ps lstart → idle-timeout
 *      fallback) — duplicated here to avoid circular dep on term-wezterm
 *      PaneAlive (which itself consumes this registry as `paneToSession`)
 *   3. Drop sessions without `paneId` (cc ran outside wezterm — not routable
 *      from bridge)
 *   4. Attach friendlyName from ConfigStore `[friendly_names][sessionId]`
 *   5. Refresh internal `paneId → sessionId` cache for subsequent `get()`
 *
 * `get(paneId)` is synchronous (matches `PaneToSessionMap` contract) and
 * lookup-only — caller must `listAlive()` first to populate the cache. Empty
 * cache → returns `null` (term-wezterm PaneAlive treats `null` as "unknown
 * pane → conservative dead" per its 9-decision lattice).
 */
export function createSessionRegistry(
  opts: CreateSessionRegistryOpts,
): SessionRegistryAndMap {
  const stateDir = opts.stateDir;
  const pidProbe = opts.pidProbe ?? defaultPidProbe;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let paneCache = new Map<number, SessionId>();

  return {
    async listAlive(): Promise<readonly SessionInfo[]> {
      const sessionIds = await scanSessionIds(stateDir);
      const config = await opts.configStore.load();
      const friendlyByIdRaw = config.friendly_names as Record<string, string>;

      const alive: SessionInfo[] = [];
      const newCache = new Map<number, SessionId>();

      for (const sessionId of sessionIds) {
        const isAlive = await checkSessionAlive(sessionId, {
          stateDir,
          pidProbe,
          idleTimeoutMs,
        });
        if (!isAlive) continue;

        const ccPid = await readCcPid({ stateDir, sessionId });
        // Liveness via last-hook-at fallback may pass when ccPid is missing,
        // but bridge needs paneId+cwd to route — drop those silently.
        if (!ccPid || ccPid.paneId === undefined || ccPid.cwd === undefined) {
          continue;
        }

        const friendlyName = friendlyByIdRaw[sessionId];
        alive.push({
          sessionId: sessionId as SessionId,
          paneId: ccPid.paneId as PaneId,
          friendlyName: friendlyName as FriendlyName | undefined,
          cwd: ccPid.cwd as CwdAbs,
        });
        newCache.set(ccPid.paneId, sessionId as SessionId);
      }

      paneCache = newCache;
      return alive;
    },

    get(paneId: PaneId): SessionId | null {
      return paneCache.get(paneId as unknown as number) ?? null;
    },
  };
}

/** Scan stateDir for `<sessionId>.cc-pid` files and return their sessionIds. */
async function scanSessionIds(stateDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(CC_PID_SUFFIX))
    .map((name) => name.slice(0, -CC_PID_SUFFIX.length));
}

interface AliveCheckDeps {
  stateDir: string;
  pidProbe: PidProbe;
  idleTimeoutMs: number;
}

/**
 * Per-session 4-signal liveness check (mirrors term-wezterm PaneAlive's
 * decision lattice). Duplication is deliberate: term-wezterm consumes this
 * registry as `paneToSession`, so this side can't depend on PaneAlive.
 */
async function checkSessionAlive(
  sessionId: string,
  deps: AliveCheckDeps,
): Promise<boolean> {
  const { stateDir, pidProbe, idleTimeoutMs } = deps;

  if (await readEnded({ stateDir, sessionId })) return false;

  const ccPid = await readCcPid({ stateDir, sessionId });

  if (!ccPid) {
    const lastHookAt = await readLastHookAt({ stateDir, sessionId });
    if (lastHookAt === null) return false;
    return Date.now() - lastHookAt <= idleTimeoutMs;
  }

  if (!pidProbe.isAlive(ccPid.pid)) return false;

  let lstart: string;
  try {
    lstart = await pidProbe.getLstart(ccPid.pid);
  } catch {
    return false;
  }
  return lstart === ccPid.startedAt;
}
