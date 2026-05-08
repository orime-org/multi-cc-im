import type { PaneId } from '../types.js';

/**
 * TermAdapter handler. Terminal multiplexers (wezterm/tmux/zellij) are mostly
 * push-by-bridge; this handler is sparse — only fires for terminal-side
 * lifecycle events the bridge needs to observe.
 */
export interface Handler {
  /** A pane the bridge previously routed to has closed. */
  onPaneClosed?: (paneId: PaneId) => Promise<void>;
}

/**
 * Core TermAdapter interface — every terminal multiplexer implementation
 * (wezterm / tmux / zellij / ghostty) must satisfy this.
 *
 * Per hook+wezterm DD (W1), input to a cc TUI pane is a two-step send-text:
 *  1. paste the prompt content (default paste mode)
 *  2. send `\r` separately with `--no-paste` to commit
 * `sendText` covers step 1; `sendKeystroke` covers step 2.
 */
export interface Adapter {
  /** Stable identifier (e.g. `'wezterm'`). */
  readonly name: string;
  /** Subscribe to terminal-side lifecycle events. */
  start(handler: Handler): Promise<void>;
  /** Step 1 of input: paste content into the pane (no submit). */
  sendText(paneId: PaneId, content: string): Promise<void>;
  /** Step 2 of input: send a single keystroke (e.g. `'\r'` to submit). */
  sendKeystroke(paneId: PaneId, key: string): Promise<void>;
  /** Release multiplexer client / close socket. */
  stop(): Promise<void>;
}

/**
 * Snapshot of a single pane returned by `ListPanes.listPanes()`.
 * Subset of fields needed by the bridge router for tab-title routing —
 * adapter is free to expose more on its own concrete return type but
 * must include at least these.
 */
export interface PaneInfo {
  paneId: PaneId;
  /**
   * Tab/pane title as the user sees it. Cleaned by adapter (for wezterm:
   * cc status emoji prefix stripped, default cc title `"Claude Code [...]"`
   * collapsed to empty so it doesn't shadow user-renamed sessions).
   * Empty string = pane has no user-set title — un-routable from IM via
   * tabname.
   */
  title: string;
  /** Working dir of the foreground process in the pane (as URI or path). */
  cwd: string;
}

/**
 * Capability: list current panes from the underlying terminal multiplexer.
 *
 * Per [DD: pane-keyed state files](../../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 * bridge router uses `listPanes()` directly as the source of truth for
 * tabname → paneId routing (no longer joins SessionStart files with
 * wezterm cli list). Daemon trusts user-side knowledge from `/start` IM
 * listing for cc liveness; no separate `isPaneAlive` capability needed.
 */
export interface ListPanes extends Adapter {
  /** Snapshot of all currently visible panes in the multiplexer. */
  listPanes(): Promise<readonly PaneInfo[]>;
}
