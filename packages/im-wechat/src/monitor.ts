import type { CursorStore } from '@multi-cc-im/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { getUpdates } from '../lib/ilink/api/api.js';
import type { WeixinMessage } from '../lib/ilink/api/types.js';

/**
 * Multi-cc-im replacement for upstream `monitor/monitor.ts` (not vendored,
 * because it's deeply coupled to OpenClaw PluginRuntime + processOneMessage).
 *
 * Long-polls iLink getUpdates → invokes the onMessage callback for each
 * message → persists the cursor to CursorStore. By design this is decoupled
 * from IMAdapter.start(handler): the monitor is the low-level pump, while the
 * adapter sits on top and converts raw WeixinMessage into shared
 * IncomingMessage.
 *
 * The CLAUDE.md "Key conventions" rule "iLink long-poll must have timeout
 * (35s+) + backoff retry + cursor persistence" is implemented in this
 * function.
 */

export interface MonitorOpts {
  /** iLink endpoint, supplied by resolveAccount. */
  baseUrl: string;
  /** iLink bot_token, supplied after retrieval from the credential store. */
  token: string;
  /** Cursor persistence (resumes after restart, never drops messages) — sourced from storage-files. */
  cursorStore: CursorStore;
  /** Callback for each raw WeixinMessage received; the adapter layer handles downstream conversion. */
  onMessage: (msg: WeixinMessage) => Promise<void>;
  /** Notification for non-fatal errors (network jitter, etc.); fatal errors are thrown. */
  onError?: (err: Error) => void;
  /** Abort signal the caller can use to stop the loop. */
  abortSignal?: AbortSignal;
}

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Main pump loop. Exits gracefully when `abortSignal` is aborted. Errors back
 * off exponentially up to a 30-second cap.
 */
export async function runMonitor(opts: MonitorOpts): Promise<void> {
  let backoffMs = BACKOFF_INITIAL_MS;

  while (!opts.abortSignal?.aborted) {
    let cursor = (await opts.cursorStore.get()) ?? '';

    try {
      const resp = await getUpdates({
        baseUrl: opts.baseUrl,
        token: opts.token,
        get_updates_buf: cursor,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
      });

      // Business errors (session expired, etc.) flow through onError without exiting the loop.
      if (resp.errcode && resp.errcode !== 0) {
        opts.onError?.(
          new Error(
            `getUpdates errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
          ),
        );
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        continue;
      }

      // Success → reset backoff.
      backoffMs = BACKOFF_INITIAL_MS;

      // Push messages downstream.
      for (const msg of resp.msgs ?? []) {
        if (opts.abortSignal?.aborted) return;
        await opts.onMessage(msg);
      }

      // Persist the new cursor (resumes after restart).
      if (resp.get_updates_buf !== undefined) {
        await opts.cursorStore.set(resp.get_updates_buf);
      }
    } catch (err) {
      if (opts.abortSignal?.aborted) return;
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}
