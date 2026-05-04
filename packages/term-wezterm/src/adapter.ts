import type {
  PaneId,
  TermAdapter,
  TermHandler,
} from '@multi-cc-im/shared';
import { runWezTermCli } from './cli.js';

export interface CreateWezTermAdapterOpts {
  /**
   * Pre-resolved absolute path to the `wezterm` binary. Caller (CLI / bridge
   * core) calls `resolveWezTermPath()` once at startup, caches in
   * `~/.multi-cc-im/config.toml`, and passes the result here. CLAUDE.md
   * 「禁止硬编码密钥 / 外部 CLI 路径」 — never hardcode this.
   */
  wezterm: { path: string };
}

/**
 * Create a TermAdapter for WezTerm. Implements the core 4 methods
 * (`name` / `start` / `sendText` / `sendKeystroke` / `stop`) from
 * `shared/adapter/term.ts`. **Two-step input** is enforced by exposing
 * `sendText` and `sendKeystroke` as separate primitives:
 *
 *   1. `sendText(paneId, content)` → `wezterm cli send-text --pane-id <p>`
 *      with content piped via stdin (default paste mode = bracketed paste,
 *      \\n / shell metachars / Unicode / emoji all preserved verbatim, never
 *      triggers submit).
 *   2. Caller (bridge router) sleeps ~300ms for paste-render.
 *   3. `sendKeystroke(paneId, '\\r')` → `wezterm cli send-text --pane-id <p>
 *      --no-paste` with `\\r` piped via stdin (escapes paste wrapping; \\r
 *      reaches TUI as a real keystroke and submits the prompt).
 *
 * Mixing single-step (paste + \\r together OR --no-paste with content) is
 * forbidden by CLAUDE.md「关键规范」 "send-text 注入两步法". This adapter
 * doesn't enforce the order at the type level — bridge router must do it.
 *
 * **PaneAlive capability is intentionally NOT implemented in this PR**: the
 * multi-signal strategy (DD: pane 活性策略) requires SessionEnd hook + cc PID
 * state files which are owned by `packages/cli-cc/`. PaneAlive lands in the
 * follow-up PR that wires cli-cc + bridge router together. CLAUDE.md
 * 「禁止清单」"不验证 cc 活性就 send-text" enforcement is bridge router's
 * responsibility — at that layer it must check `isPaneAlive(adapter)` guard
 * and reject send if false.
 */
export function createWezTermAdapter(
  opts: CreateWezTermAdapterOpts,
): TermAdapter {
  const wezterm = opts.wezterm.path;

  return {
    name: 'wezterm',

    async start(_handler: TermHandler): Promise<void> {
      // v1 has no terminal-side lifecycle event source to subscribe to:
      // pane closures are observed through the cli-cc / SessionEnd path,
      // not through wezterm cli. Handler.onPaneClosed stays unfired in v1.
    },

    async sendText(paneId: PaneId, content: string): Promise<void> {
      await runWezTermCli({
        wezterm,
        args: ['cli', 'send-text', '--pane-id', String(paneId)],
        stdin: content,
      });
    },

    async sendKeystroke(paneId: PaneId, key: string): Promise<void> {
      if (key.length === 0) {
        throw new Error(
          'WezTermAdapter.sendKeystroke: keystroke must not be empty',
        );
      }
      await runWezTermCli({
        wezterm,
        args: ['cli', 'send-text', '--pane-id', String(paneId), '--no-paste'],
        stdin: key,
      });
    },

    async stop(): Promise<void> {
      // No socket / subprocess held — nothing to release.
    },
  };
}
