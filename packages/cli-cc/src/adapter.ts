import chokidar, { type FSWatcher } from 'chokidar';
import { join, basename } from 'node:path';
import type {
  CLIAdapter,
  CLIHandler,
  SessionEndPayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
} from '@multi-cc-im/shared';
import { tailNewEvents } from './events-log.js';
import { enqueueInjection } from './injection-queue.js';
import type { ParsedHookPayload } from './payloads.js';

export interface CreateCcCliAdapterOpts {
  /**
   * State dir holding `<sid>.events.jsonl` + `<sid>.injection-queue.jsonl`
   * (e.g. `~/.multi-cc-im/state/`). Caller (CLI / bridge) decides exact path;
   * matches the `stateDir` passed to `runHookReceiver` on the writer side.
   */
  stateDir: string;
  /**
   * Called when a Handler callback throws. Default: silently swallow (the
   * watcher keeps going so one bad event doesn't stop the bridge). Bridge
   * passes its `pino` logger via this hook.
   */
  onHandlerError?: (err: unknown, payload: ParsedHookPayload) => void;
  /**
   * Called when an events.jsonl line fails JSON / zod parse. Default: silent.
   */
  onParseError?: (line: string, error: unknown) => void;
}

const EVENTS_LOG_SUFFIX = '.events.jsonl';

/**
 * File-watching CLIAdapter for cc. Tails per-session `<sid>.events.jsonl`
 * files written by `runHookReceiver`, dispatches events to the supplied
 * `Handler`, exposes `enqueueInjection(sid, content)` for bridge router to
 * schedule Stop-hook injections.
 *
 * Why file-based vs IPC: aligns with [Storage DD pattern A](../../../docs/superpowers/specs/2026-04-29-storage-strategy-dd.md)
 * file-first persistence, CLAUDE.md "local-first", and avoids the
 * bridge-lifecycle / port management problems IPC brings (cc hooks fire even
 * when bridge is down; file-based is naturally restart-safe).
 *
 * Caveats:
 * - Per-file offset tracker is in-memory; on bridge restart the watcher
 *   re-reads from offset 0 → re-delivers any backlog. Handler must be
 *   idempotent or the bridge router must dedupe by `(session_id, hook fire id)`.
 * - SessionEnd events are dispatched at the file-watcher level but have no
 *   `Handler.onSessionEnd` callback in `@multi-cc-im/shared`. Receiver state
 *   files (`<sid>.ended`) are the consumer for that signal (PaneAlive). Add
 *   `onSessionEnd` to shared if bridge router ever needs the live event.
 */
export function createCcCliAdapter(
  opts: CreateCcCliAdapterOpts,
): CLIAdapter {
  let watcher: FSWatcher | undefined;
  let handler: CLIHandler | undefined;
  const offsets = new Map<string, number>();
  // Per-file serial dispatch chain. Multiple chokidar events for the same
  // file (e.g. 'add' + 'change' fired close together) must be processed in
  // arrival order to keep events.jsonl tail offsets monotonic; chaining via
  // `.then` guarantees that without losing any event.
  const tailChains = new Map<string, Promise<void>>();

  function scheduleTail(filePath: string): Promise<void> {
    const prev = tailChains.get(filePath) ?? Promise.resolve();
    const next = prev.then(async () => {
      const fromOffset = offsets.get(filePath) ?? 0;
      const result = await tailNewEvents({
        filePath,
        fromOffset,
        ...(opts.onParseError ? { onParseError: opts.onParseError } : {}),
      });
      offsets.set(filePath, result.newOffset);
      if (!handler) return;
      for (const event of result.events) {
        try {
          await dispatch(handler, event);
        } catch (err) {
          opts.onHandlerError?.(err, event);
        }
      }
    });
    tailChains.set(filePath, next);
    return next;
  }

  return {
    name: 'claude-code',

    async start(h: CLIHandler): Promise<void> {
      if (watcher) {
        throw new Error('createCcCliAdapter: already started');
      }
      handler = h;

      // chokidar v4 dropped glob support — watch the directory + filter by
      // suffix in event handlers.
      const w = chokidar.watch(opts.stateDir, {
        ignoreInitial: false,
        persistent: true,
        awaitWriteFinish: false,
        depth: 0,
      });
      watcher = w;

      const onChange = (filePath: string): void => {
        if (!basename(filePath).endsWith(EVENTS_LOG_SUFFIX)) return;
        void scheduleTail(filePath);
      };
      w.on('add', onChange);
      w.on('change', onChange);

      // Wait for chokidar's initial scan to complete (fires 'add' for each
      // pre-existing events.jsonl). Then await all in-flight tail chains so
      // backlog dispatch finishes before start() resolves.
      await new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      });
      await Promise.all(tailChains.values());
    },

    async enqueueInjection(
      sessionId: SessionId,
      content: string,
    ): Promise<void> {
      await enqueueInjection({
        stateDir: opts.stateDir,
        sessionId,
        content,
      });
    },

    async stop(): Promise<void> {
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
      // Drain any in-flight tails before clearing handler so we don't drop
      // mid-dispatch events.
      await Promise.all(tailChains.values());
      handler = undefined;
      offsets.clear();
      tailChains.clear();
    },
  };
}

async function dispatch(
  handler: CLIHandler,
  event: ParsedHookPayload,
): Promise<void> {
  // Boundary cast: parsed payloads carry plain `string` for the branded
  // shared types (session_id / cwd / transcript_path) — see payloads.ts
  // header for why brand transforms are intentionally absent. Shared's
  // Handler types use the branded variants, so cast at this dispatch seam.
  switch (event.hook_event_name) {
    case 'SessionStart':
      await handler.onSessionStart(event as unknown as SessionStartPayload);
      return;
    case 'Stop':
      // CLIAdapter at this layer doesn't return a HookDecision — Stop hook
      // injection (decision:block) is the receiver's responsibility (it pops
      // from injection-queue.jsonl in `runHookReceiver`). Bridge router
      // signals "queue this prompt next" via `enqueueInjection`, not via the
      // Handler.onStop return.
      await handler.onStop(event as unknown as StopPayload);
      return;
    case 'SessionEnd':
      await handler.onSessionEnd(event as unknown as SessionEndPayload);
      return;
  }
}
