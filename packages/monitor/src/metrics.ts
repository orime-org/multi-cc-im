/**
 * In-memory metrics primitives for the monitor dashboard.
 *
 * Per [DD 2026-05-15 §4](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md):
 * monitor stores **zero persistent state** — every datum is either pulled
 * live from the daemon at render time or held in an in-memory ring that
 * resets on each daemon restart. The user accepted "lose history on
 * restart" as a baseline trade.
 *
 * Only data structure here is the error ring buffer (capacity 200 by
 * default). Other metrics (daemon state / sessions / cost) are pulled
 * fresh each request and don't need a buffer.
 */

import type { ErrorEntry } from './types.js';

export interface ErrorRingBufferOpts {
  /** Max entries retained. Default 200 (~100 KB at 500 bytes/entry). */
  capacity?: number;
  /**
   * Time source override for tests. Default `() => new Date().toISOString()`.
   * Tests inject a stub for deterministic timestamp assertions.
   */
  now?: () => string;
}

/**
 * Bounded FIFO buffer of error entries. Newest at the **end** of `snapshot()`.
 *
 * Insertion is O(1) amortized (push + shift when full). For N=200, shift
 * cost is negligible at the rates daemon errors actually occur (handful
 * per minute at most).
 *
 * **Thread-safety**: Node single-threaded event loop — no mutex needed.
 * Don't call `push` from a worker thread without your own sync.
 */
export class ErrorRingBuffer {
  private readonly capacity: number;
  private readonly now: () => string;
  private readonly buffer: ErrorEntry[] = [];

  constructor(opts: ErrorRingBufferOpts = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 200);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /**
   * Append a new error entry. Drops the oldest entry if at capacity.
   *
   * @param phase  Logical phase (e.g. `'imAdapter'`, `'forwardStop'`).
   * @param message  Human-readable; truncate caller-side if it could be
   *   huge (we don't truncate here so test fixtures can assert
   *   message preservation).
   */
  push(phase: string, message: string): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push({
      timestamp: this.now(),
      phase,
      message,
    });
  }

  /**
   * Return a copy of buffer contents — newest at the end. Caller-safe
   * (caller can mutate the returned array without affecting the buffer).
   */
  snapshot(): ErrorEntry[] {
    return [...this.buffer];
  }

  /** Current entry count (≤ capacity). Useful for tests + the dashboard header. */
  size(): number {
    return this.buffer.length;
  }

  /** Clear all entries. Useful for tests; never called by production. */
  clear(): void {
    this.buffer.length = 0;
  }
}

/**
 * Format a Date / ISO string as a relative "X ago" English string.
 * Used by views to render "last reconnected 3m ago" without locale
 * surprises (issue 377 LC_TIME lesson: keep relative time formatting
 * deterministic, never delegate to `toLocaleString` here).
 */
export function relativeTime(when: string | Date, now: Date = new Date()): string {
  const t = typeof when === 'string' ? new Date(when) : when;
  const deltaMs = now.getTime() - t.getTime();
  if (deltaMs < 0) return 'in the future';
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
