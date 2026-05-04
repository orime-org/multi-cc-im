import type { PaneId, PaneToSessionMap } from '@multi-cc-im/shared';
import {
  readCcPid,
  readEnded,
  readLastHookAt,
} from '@multi-cc-im/cli-cc';
import { defaultPidProbe, type PidProbe } from './pid-probe.js';

/**
 * Default idle-timeout fallback: 30 minutes. Per [pane 活性策略 DD g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md)
 * 第 5 步未决问题 #2，30 min 是经验值；用户可在 `~/.multi-cc-im/config.toml`
 * 覆盖（future plumbing），bridge 直接 createIsPaneAlive 时也可以注入。
 *
 * 设计权衡：
 * - 太小：cc 长思考误判 dead → 假阴 → bridge 把 wechat 消息排队不送
 * - 太大：bridge 重启后 last-hook-at 残值仍 fresh → 假阳 → 注入到已死 cc 的 pane
 *   （但 PID 检查会兜底拦住绝大多数；只在 PID 复用 + lstart 巧合一致时漏，概率乘积极低）
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
 * 4-signal `isPaneAlive(paneId)` per [pane 活性策略 DD g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md).
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
 * Caller / bridge router enforces CLAUDE.md「禁止清单」"不验证 cc 活性就 send-text"
 * by gating every `sendText` behind this check.
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
