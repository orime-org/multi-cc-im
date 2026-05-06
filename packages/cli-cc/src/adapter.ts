import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import type {
  CLIAdapter,
  CLIHandler,
  CwdAbs,
  SessionEndPayload,
  SessionId,
  SessionStartPayload,
  StopPayload,
  TranscriptPath,
} from '@multi-cc-im/shared';
import { enqueueInjection } from './injection-queue.js';
import {
  SESSION_END_SUFFIX,
  SESSION_START_SUFFIX,
  STOP_PREFIX,
  deleteStopFile,
  readSessionStartFile,
  readStopFile,
} from './state-files.js';

export interface CreateCcCliAdapterOpts {
  /**
   * State dir holding the per-event-type files (e.g. `~/.multi-cc-im/state/`).
   * Caller (CLI / bridge) decides exact path; matches the `stateDir` passed
   * to `runHookReceiver` on the writer side.
   */
  stateDir: string;
  /**
   * Called when a Handler callback throws. Default: silently swallow (the
   * watcher keeps going so one bad event doesn't stop the bridge). Bridge
   * passes its `pino` logger via this hook.
   */
  onHandlerError?: (
    err: unknown,
    context: { kind: 'SessionStart' | 'Stop' | 'SessionEnd'; sessionId: string },
  ) => void;
}

/**
 * UUID v4 prefix matcher for our state-file naming convention. Used to
 * extract the sessionId from a state-file basename.
 */
const SID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

interface ClassifiedFile {
  sid: string;
  kind: 'SessionStart' | 'Stop' | 'SessionEnd';
  filePath: string;
}

/** Classify a state-dir basename into one of the 3 event types or null. */
function classifyStateFile(
  filePath: string,
  fileBasename: string,
): ClassifiedFile | null {
  const m = SID_PATTERN.exec(fileBasename);
  if (!m) return null;
  const sid = m[1]!;
  const rest = fileBasename.slice(sid.length);
  if (rest === SESSION_START_SUFFIX)
    return { sid, kind: 'SessionStart', filePath };
  if (rest === SESSION_END_SUFFIX)
    return { sid, kind: 'SessionEnd', filePath };
  if (rest.startsWith(STOP_PREFIX)) return { sid, kind: 'Stop', filePath };
  return null;
}

/**
 * File-watching CLIAdapter for cc.
 *
 * Watches `<stateDir>/` for the 3 per-event-type files written by
 * `runHookReceiver`:
 * - `<sid>.SessionStart` create → `Handler.onSessionStart`
 * - `<sid>.Stop.<ts>` create → `Handler.onStop` (then `unlink` after success)
 * - `<sid>.SessionEnd` create → `Handler.onSessionEnd` (file kept as
 *   tombstone; cleanup sweep deletes it later)
 *
 * Per-session dispatch chain: events for the same `sid` are processed
 * serially (preserves Stop-order across multiple `.Stop.<ts>` files dropped
 * close together; daemon down then up sees them in chronological order).
 *
 * `enqueueInjection(sid, content)` is the bridge router's entry into the
 * Stop-hook injection mechanism — content gets popped by the next non-active
 * Stop hook fire (see `runHookReceiver` Stop branch).
 *
 * Why file-based vs IPC: aligns with [Storage DD pattern A](../../../docs/superpowers/specs/2026-04-29-storage-strategy-dd.md)
 * file-first persistence, CLAUDE.md "local-first", and avoids the
 * bridge-lifecycle / port management problems IPC brings (cc hooks fire even
 * when bridge is down; file-based is naturally restart-safe).
 */
export function createCcCliAdapter(
  opts: CreateCcCliAdapterOpts,
): CLIAdapter {
  let watcher: FSWatcher | undefined;
  let handler: CLIHandler | undefined;
  /**
   * Per-session serial dispatch chain. Stop files are written one per turn
   * with monotonic timestamp suffixes; daemon must process them in arrival
   * order so wechat sees the assistant turns in the correct order.
   */
  const sessionChains = new Map<string, Promise<void>>();
  /**
   * Tracks files we've already scheduled for dispatch in this process, so a
   * second chokidar event (rare 'add' + 'change' for same path) doesn't
   * double-dispatch. ENOENT on read is also a sign we already processed +
   * unlinked.
   */
  const seenFiles = new Set<string>();

  function scheduleDispatch(classified: ClassifiedFile): void {
    if (seenFiles.has(classified.filePath)) return;
    seenFiles.add(classified.filePath);

    const prev = sessionChains.get(classified.sid) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!handler) return;
      try {
        await dispatchOne(handler, classified, opts.stateDir);
      } catch (err) {
        opts.onHandlerError?.(err, {
          kind: classified.kind,
          sessionId: classified.sid,
        });
      } finally {
        // Free the seen entry so a future *new* file (different timestamp)
        // for the same session won't get accidentally suppressed. The
        // sessionChains entry stays — it serializes future writes.
        seenFiles.delete(classified.filePath);
      }
    });
    sessionChains.set(classified.sid, next);
  }

  return {
    name: 'claude-code',

    async start(h: CLIHandler): Promise<void> {
      if (watcher) {
        throw new Error('createCcCliAdapter: already started');
      }
      handler = h;

      // chokidar v4 dropped glob support — watch the directory + filter by
      // basename in the event handler.
      const w = chokidar.watch(opts.stateDir, {
        ignoreInitial: false,
        persistent: true,
        awaitWriteFinish: false,
        depth: 0,
      });
      watcher = w;

      const onAdd = (filePath: string): void => {
        const classified = classifyStateFile(filePath, basename(filePath));
        if (!classified) return;
        scheduleDispatch(classified);
      };
      w.on('add', onAdd);
      // 'change' is rare for our writers (atomicWrite renames into place →
      // chokidar sees that as 'add'), but subscribe defensively.
      w.on('change', onAdd);

      // Wait for chokidar's initial scan to complete (fires 'add' for each
      // pre-existing state file). Then await all in-flight chains so backlog
      // dispatch finishes before start() resolves.
      await new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      });
      await Promise.all(sessionChains.values());
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
      // Drain any in-flight chains before clearing handler so we don't drop
      // mid-dispatch events.
      await Promise.all(sessionChains.values());
      handler = undefined;
      sessionChains.clear();
      seenFiles.clear();
    },
  };
}

async function dispatchOne(
  handler: CLIHandler,
  classified: ClassifiedFile,
  stateDir: string,
): Promise<void> {
  switch (classified.kind) {
    case 'SessionStart': {
      const file = await readSessionStartFile({
        stateDir,
        sessionId: classified.sid,
      });
      // ENOENT (file deleted between chokidar event + our read) → silently
      // skip. Most likely cause: cc /resume already cleaned the file before
      // we got here (race window) — the new SessionStart event will fire.
      if (!file) return;
      const payload: SessionStartPayload = {
        session_id: classified.sid as unknown as SessionId,
        transcript_path: file.transcript_path as unknown as TranscriptPath,
        cwd: file.cwd as unknown as CwdAbs,
        hook_event_name: 'SessionStart',
        // The state file doesn't persist `source` / `model` — fill with
        // defaults the bridge can tolerate; consumers that need these
        // would need to read cc transcript directly.
        source: 'startup',
        model: '',
      };
      await handler.onSessionStart(payload);
      return;
    }

    case 'Stop': {
      const file = await readStopFile(classified.filePath);
      if (!file) return; // ENOENT — already processed by another tick
      const payload: StopPayload = {
        session_id: classified.sid as unknown as SessionId,
        // The stop file only persists last_assistant_message; fill required
        // fields with bridge-tolerable defaults. Bridge orchestrator only
        // reads session_id + last_assistant_message in onStop.
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'Stop',
        permission_mode: '',
        stop_hook_active: false,
        last_assistant_message: file.last_assistant_message,
      };
      await handler.onStop(payload);
      // Forward succeeded (no throw) → unlink so the file doesn't replay
      // on next daemon restart. Throws → onHandlerError caller already
      // logged; leave the file for next-run retry / sweep cleanup.
      await deleteStopFile(classified.filePath);
      return;
    }

    case 'SessionEnd': {
      const payload: SessionEndPayload = {
        session_id: classified.sid as unknown as SessionId,
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'SessionEnd',
        reason: '',
      };
      await handler.onSessionEnd(payload);
      // Don't unlink — SessionEnd is a tombstone, kept as historical record
      // until cleanup sweep removes the SessionStart+SessionEnd pair.
      return;
    }
  }
}
