import type {
  PaneId,
  TermAdapter,
  TermHandler,
  TermListPanes,
  TermPaneInfo,
} from '@multi-cc-im/shared';
import { runWezTermCli } from './cli.js';
import { listAllTabs } from './tab-title.js';

export interface CreateWezTermAdapterOpts {
  /**
   * Pre-resolved absolute path to the `wezterm` binary. Caller (CLI / bridge
   * core) calls `resolveWezTermPath()` once at startup, caches in
   * `~/.multi-cc-im/config.toml`, and passes the result here. CLAUDE.md
   * "no hardcoded secrets / external CLI paths" — never hardcode this.
   */
  wezterm: { path: string };
}

/**
 * Create a TermAdapter for WezTerm. Implements the core 4 methods
 * (`name` / `start` / `sendText` / `sendKeystroke` / `stop`) from
 * `shared/adapter/term.ts`, plus the `listPanes` capability for tabname
 * routing per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md).
 *
 * **Two-step input** is enforced by exposing `sendText` and `sendKeystroke`
 * as separate primitives:
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
 * forbidden by CLAUDE.md "Key conventions" rule "send-text two-step
 * injection".
 *
 * **PaneAlive capability removed** in DD #61 — daemon trusts user-side
 * knowledge from `/start` IM listing for cc liveness; bridge router does
 * not gate `sendText` on a runtime liveness probe (corner case: cc died
 * after user `/start`'d → daemon blindly injects to zsh; user notices via
 * IM round-trip absence + reboots cc).
 */
export function createWezTermAdapter(
  opts: CreateWezTermAdapterOpts,
): TermAdapter & TermListPanes {
  const wezterm = opts.wezterm.path;

  return {
    name: 'wezterm',

    async start(_handler: TermHandler): Promise<void> {
      // v1 has no terminal-side lifecycle event source to subscribe to:
      // pane closures observed via wezterm cli list re-runs (each IM event
      // re-fetches), not via push events.
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

    async listPanes(): Promise<readonly TermPaneInfo[]> {
      const tabs = await listAllTabs({ wezterm });
      const result: TermPaneInfo[] = [];
      for (const tab of tabs.values()) {
        result.push({
          paneId: tab.paneId as PaneId,
          title: tab.title,
          cwd: tab.cwd,
        });
      }
      return result;
    },

    async stop(): Promise<void> {
      // No socket / subprocess held — nothing to release.
    },
  };
}
