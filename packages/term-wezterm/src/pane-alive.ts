import type { PaneId, PaneToSessionMap } from '@multi-cc-im/shared';
import {
  existsSessionEndFile,
  readSessionStartFile,
} from '@multi-cc-im/cli-cc';
import { defaultPidProbe, type PidProbe } from './pid-probe.js';

export interface CreateIsPaneAliveOpts {
  /** Where cli-cc state files live (`~/.multi-cc-im/state/`). */
  stateDir: string;
  /** pane_id → session_id reverse lookup; bridge router supplies. */
  paneToSession: PaneToSessionMap;
  /** Test seam (default: real `kill(0)` + `ps -o lstart=`). */
  pidProbe?: PidProbe;
}

/**
 * 3-signal `isPaneAlive(paneId)` per [pane-alive strategy DD section g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md),
 * simplified after the state-directory redesign (no more idle-timeout
 * fallback — the per-event-type files give us authoritative signals).
 *
 * Decision lattice:
 *   1. unknown pane (paneToSession.get → null)              → DEAD (conservative)
 *   2. <sid>.SessionEnd file present                        → DEAD (graceful exit)
 *   3. <sid>.SessionStart MISSING                           → DEAD (no signal at all)
 *   4. SessionStart present + PID dead                      → DEAD (abnormal exit)
 *   5. SessionStart present + PID alive + lstart mismatch   → DEAD (PID reuse defense)
 *   6. SessionStart present + PID alive + ps probe throws   → DEAD (probe failure conservative)
 *   7. SessionStart present + PID alive + lstart matches    → ALIVE (steady state)
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

  return async function isPaneAlive(paneId: PaneId): Promise<boolean> {
    const sessionId = paneToSession.get(paneId);
    if (!sessionId) return false;

    if (await existsSessionEndFile({ stateDir, sessionId })) return false;

    const startFile = await readSessionStartFile({ stateDir, sessionId });
    if (!startFile) return false;

    if (!pidProbe.isAlive(startFile.pid)) return false;

    let lstart: string;
    try {
      lstart = await pidProbe.getLstart(startFile.pid);
    } catch {
      return false;
    }
    return lstart === startFile.startedAt;
  };
}
