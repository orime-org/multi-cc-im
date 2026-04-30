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
 * Capability: probe whether a pane currently hosts a live cc TUI process
 * (vs. having returned to the user shell after `/exit`).
 *
 * Required by CLAUDE.md「关键规范」: "路由前必须验证 pane 里 cc 活着"。
 * Concrete strategy (heartbeat / pid probe / SessionEnd hook) is per-impl
 * and tracked by a separate v1 implementation DD (CLAUDE.md「关键设计假设」
 * 表 "pane 活性验证策略").
 */
export interface PaneAlive extends Adapter {
  isPaneAlive(paneId: PaneId): Promise<boolean>;
}
