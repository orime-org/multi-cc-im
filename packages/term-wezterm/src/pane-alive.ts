import type { PaneId, PaneToSessionMap } from '@multi-cc-im/shared';
import {
  readCcPid,
  readEnded,
  readLastHookAt,
} from '@multi-cc-im/cli-cc';
import { defaultPidProbe, type PidProbe } from './pid-probe.js';

/**
 * Default idle-timeout fallback: 30 minutes. Per [pane-alive strategy DD section g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md)
 * step 5 open question #2, 30 min is an empirical value; users can override
 * in `~/.multi-cc-im/config.toml` (future plumbing), and bridge can also
 * inject when calling createIsPaneAlive directly.
 *
 * Design tradeoffs:
 * - Too small: long-thinking cc misjudged as dead → false negative → bridge
 *   queues wechat messages without delivering
 * - Too large: stale last-hook-at after bridge restart still appears fresh →
 *   false positive → injects into pane of a dead cc (but the PID check
 *   catches the vast majority; only leaks when PID reuse + lstart
 *   coincidentally match, joint probability extremely low)
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface CreateIsPaneAliveOpts {
  /** Where cli-cc state files live (`~/.multi-cc-im/state/`). */
  stateDir: string;
  /** pane_id → session_id reverse lookup; bridge router supplies. */
  paneToSession: PaneToSessionMap;
  /** Test seam (default: real `kill(0)` + `ps -o lstart=`). */
  pidProbe?: PidProbe;
  /** Stale-hook fallback threshold; default 30 min. */
  idleTimeoutMs?: number;
}

/**
 * 4-signal `isPaneAlive(paneId)` per [pane-alive strategy DD section g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md).
 *
 * Decision lattice:
 *   1. unknown pane (paneToSession.get → null)              → DEAD (conservative)
 *   2. SessionEnd file present                              → DEAD (signal 1 — graceful exit)
 *   3. cc-pid present + PID dead                            → DEAD (signal 2 — abnormal exit)
 *   4. cc-pid present + PID alive + lstart mismatch         → DEAD (signal 3 — PID reuse defense)
 *   5. cc-pid present + PID alive + ps lstart probe throws  → DEAD (probe failure conservative)
 *   6. cc-pid present + PID alive + lstart matches          → ALIVE (steady state)
 *   7. cc-pid MISSING + last-hook-at fresh (< idleTimeout)  → ALIVE (bridge restart fallback)
 *   8. cc-pid MISSING + last-hook-at stale (> idleTimeout)  → DEAD (signal 4 — idle timeout)
 *   9. cc-pid MISSING + last-hook-at MISSING                → DEAD (no signal at all)
 *
 * Caller / bridge router enforces CLAUDE.md "Forbidden list" "do not
 * send-text without verifying cc liveness" by gating every `sendText` behind
 * this check.
 */
export function createIsPaneAlive(
  opts: CreateIsPaneAliveOpts,
): (paneId: PaneId) => Promise<boolean> {
  const stateDir = opts.stateDir;
  const paneToSession = opts.paneToSession;
  const pidProbe = opts.pidProbe ?? defaultPidProbe;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  return async function isPaneAlive(paneId: PaneId): Promise<boolean> {
    const sessionId = paneToSession.get(paneId);
    if (!sessionId) return false;

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
  };
}
