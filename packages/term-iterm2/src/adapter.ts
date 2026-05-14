import type {
  PaneId,
  TermAdapter,
  TermHandler,
  TermListPanes,
  TermPaneInfo,
} from '@multi-cc-im/shared';
import { runIterM2Helper, type IterM2RawSession } from './python-bridge.js';
import { cleanCwd, cleanTitle } from './tab-title.js';

export interface CreateITerm2AdapterOpts {
  /**
   * Pre-resolved absolute path to a `python3` binary. Caller (CLI /
   * bridge core) calls `resolvePython3Path()` once at startup and caches
   * the result in `~/.multi-cc-im/config.toml`. CLAUDE.md
   * "no hardcoded external CLI paths" — never hardcode this.
   */
  python: { path: string };
  /**
   * Pre-resolved absolute path to `bin/iterm2-helper.py`. The CLI
   * resolves this relative to the package install location at startup
   * (mirror W3 wezterm path resolution) and passes the result here.
   */
  helperScript: { path: string };
  /**
   * Optional diagnostic log sink. When provided, every iterm2-helper
   * subprocess invocation prints a one-line action summary before spawn
   * and a result/error line after. Production wires this to the daemon's
   * stderr + `~/.multi-cc-im/daemon.log` dual logger so users / AI can
   * reconstruct exactly what the daemon asked iTerm2 to do.
   */
  log?: (line: string) => void;
}

/**
 * Create a `TermAdapter & TermListPanes` for iTerm2. Per
 * [DD: iTerm2 adapter §6](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#6-recommendation)
 * (candidate C1): every method invokes one ephemeral `python3` subprocess
 * running `iterm2-helper.py`, which speaks the iTerm2 WebSocket Python
 * API for one action and exits. No persistent connection, no daemon
 * lifecycle event subscriptions (C2 work, deferred to v2).
 *
 * Two-step input semantics mirror the WezTerm adapter: `sendText`
 * delivers the paste-mode payload (no Enter), the orchestrator sleeps
 * ~300ms, then `sendKeystroke('\r')` submits. iTerm2 has no separate
 * "raw keystroke" API verb, so both methods route through
 * `async_send_text` on the Python side — for `\r` this delivers a real
 * Enter key event to the foregrounded process (cc TUI). See
 * `bin/iterm2-helper.py` `_send_keystroke` doc for the protocol-level
 * justification.
 *
 * Per the DD §3 audit, the bridge orchestrator treats `PaneId` as
 * opaque — number for wezterm, UUID-string for iTerm2 — so the same
 * router code path handles both adapters without conditionals.
 *
 * Per [DD §7](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#7-trade-offs-the-user-accepts-by-locking-c1):
 * the user accepted ~100-300ms cold-start latency per call vs wezterm's
 * `execFile`-only path. Acceptable for hook events (seconds/minutes
 * apart); not acceptable for sub-second polling.
 */
export function createITerm2Adapter(
  opts: CreateITerm2AdapterOpts,
): TermAdapter & TermListPanes {
  const { python, helperScript, log } = opts;

  return {
    name: 'iterm2',

    async start(_handler: TermHandler): Promise<void> {
      // v1 has no terminal-side lifecycle event source — same as wezterm.
      // Push-event lifecycle (C2 path) would open a persistent Python
      // process and subscribe to SessionTerminationMonitor; that's a
      // future opt-in, not required for v1 correctness.
    },

    async sendText(paneId: PaneId, content: string): Promise<void> {
      await runIterM2Helper({
        python,
        helperScript,
        log,
        request: {
          action: 'sendText',
          sessionId: paneId as unknown as string,
          text: content,
        },
      });
    },

    async sendKeystroke(paneId: PaneId, key: string): Promise<void> {
      if (key.length === 0) {
        throw new Error(
          'ITerm2Adapter.sendKeystroke: keystroke must not be empty',
        );
      }
      await runIterM2Helper({
        python,
        helperScript,
        log,
        request: {
          action: 'sendKeystroke',
          sessionId: paneId as unknown as string,
          key,
        },
      });
    },

    async listPanes(): Promise<readonly TermPaneInfo[]> {
      const result = await runIterM2Helper({
        python,
        helperScript,
        log,
        request: { action: 'listSessions' },
      });
      // runIterM2Helper's return type is a union; narrow to the array
      // form. If someone wires the wrong action this throws clearly
      // rather than silently returning {sent: N}.
      if (!Array.isArray(result)) {
        throw new Error(
          'iTerm2Adapter.listPanes: helper returned non-array result',
        );
      }
      return (result as readonly IterM2RawSession[]).map((row) => ({
        paneId: row.paneId as unknown as PaneId,
        title: cleanTitle(row.title),
        cwd: cleanCwd(row.cwd),
      }));
    },

    async stop(): Promise<void> {
      // No socket / subprocess held between calls — nothing to release.
      // (Persistent-connection C2 path would close its WebSocket here.)
    },
  };
}
