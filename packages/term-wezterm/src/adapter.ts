import type {
  PaneId,
  PaneToSessionMap,
  TermAdapter,
  TermHandler,
  TermPaneAlive,
} from '@multi-cc-im/shared';
import { runWezTermCli } from './cli.js';
import { createIsPaneAlive } from './pane-alive.js';
import type { PidProbe } from './pid-probe.js';

/**
 * PaneAlive plumbing — pass to attach the `isPaneAlive` capability. Without
 * this, returned adapter is plain `TermAdapter` (no capability); bridge
 * router using such an adapter would have nothing to gate `sendText` against
 * and **must refuse** per CLAUDE.md「不验证 cc 活性就 send-text」.
 */
export interface PaneAliveOpts {
  /** Where cli-cc state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /** Bridge router's pane_id → session_id map. */
  paneToSession: PaneToSessionMap;
  /** Test seam (default: real `kill(0)` + `ps -o lstart=`). */
  pidProbe?: PidProbe;
  /** Stale-hook fallback threshold; default 30 min (DD g). */
  idleTimeoutMs?: number;
}

export interface CreateWezTermAdapterOpts {
  /**
   * Pre-resolved absolute path to the `wezterm` binary. Caller (CLI / bridge
   * core) calls `resolveWezTermPath()` once at startup, caches in
   * `~/.multi-cc-im/config.toml`, and passes the result here. CLAUDE.md
   * 「禁止硬编码密钥 / 外部 CLI 路径」 — never hardcode this.
   */
  wezterm: { path: string };
  /**
   * Optional PaneAlive capability config. When provided, returned adapter
   * also satisfies `TermPaneAlive` (intersection type via overload signature).
   */
  paneAlive?: PaneAliveOpts;
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
 * When `opts.paneAlive` is supplied, the returned adapter also satisfies
 * `TermPaneAlive` (multi-signal `isPaneAlive` per [pane 活性策略 DD g](../../../docs/superpowers/specs/2026-04-30-pane-alive-strategy-dd.md)).
 * Without it the adapter has no `isPaneAlive` method — bridge router using
 * `isPaneAlive(adapter)` guard from `@multi-cc-im/shared` will see it as
 * a plain TermAdapter and (per CLAUDE.md「禁止清单」"不验证 cc 活性就
 * send-text") must refuse to route.
 */
export function createWezTermAdapter(
  opts: CreateWezTermAdapterOpts & { paneAlive: PaneAliveOpts },
): TermAdapter & TermPaneAlive;
export function createWezTermAdapter(
  opts: CreateWezTermAdapterOpts,
): TermAdapter;
export function createWezTermAdapter(
  opts: CreateWezTermAdapterOpts,
): TermAdapter | (TermAdapter & TermPaneAlive) {
  const wezterm = opts.wezterm.path;

  const base: TermAdapter = {
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

  if (!opts.paneAlive) return base;

  const isPaneAlive = createIsPaneAlive(opts.paneAlive);
  return { ...base, isPaneAlive } satisfies TermAdapter & TermPaneAlive;
}
