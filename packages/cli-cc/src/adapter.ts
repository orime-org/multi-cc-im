import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import type {
  CLIAdapter,
  CLIHandler,
  CwdAbs,
  PreToolUsePayload,
  SessionId,
  StopPayload,
  TranscriptPath,
} from '@multi-cc-im/shared';
import { enqueueInjection } from './injection-queue.js';
import {
  deleteStopFile,
  parsePermissionFilename,
  parseStopFilename,
  readPermissionRequestFile,
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
    context: {
      kind: 'PreToolUse' | 'Stop';
      paneId: number;
      sessionId: string;
    },
  ) => void;
}

interface ClassifiedStopFile {
  kind: 'Stop';
  paneId: number;
  sessionId: string;
  filePath: string;
}

interface ClassifiedPreToolUseFile {
  kind: 'PreToolUse';
  paneId: number;
  sessionId: string;
  requestId: string;
  filePath: string;
}

type ClassifiedFile = ClassifiedStopFile | ClassifiedPreToolUseFile;

/**
 * Classify a state-dir basename. Returns null for any file that's not a
 * cc-hook-fired event we route on (i.e. ignores `<paneId>.IMOrigin` /
 * `IMWork` / `daemon.pid` / IM-adapter-owned top-level files like
 * `lark-cursor` / `<paneId>_<sid>.PermissionResponse.*` — the daemon
 * writes Response, hook reads it; daemon does not dispatch Response
 * chokidar events to handlers).
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md):
 *   - `<paneId>_<sid>.Stop.<ts>`                    → ClassifiedStopFile
 *   - `<paneId>_<sid>.PermissionRequest.<id>.json`  → ClassifiedPreToolUseFile
 */
function classifyStateFile(filePath: string, fileBasename: string): ClassifiedFile | null {
  const stop = parseStopFilename(fileBasename);
  if (stop) {
    return {
      kind: 'Stop',
      paneId: stop.paneId,
      sessionId: stop.sessionId,
      filePath,
    };
  }
  const perm = parsePermissionFilename(fileBasename);
  if (perm && perm.kind === 'request') {
    return {
      kind: 'PreToolUse',
      paneId: perm.paneId,
      sessionId: perm.sessionId,
      requestId: perm.requestId,
      filePath,
    };
  }
  return null;
}

/**
 * File-watching CLIAdapter for cc.
 *
 * Watches `<stateDir>/` for the cc-hook-fired files written by
 * `runHookReceiver`:
 * - `<paneId>_<sid>.Stop.<ts>` create → `Handler.onStop`
 *   (then `unlink` after success — daemon also reaper's a 10s safety
 *   net for orphans)
 * - `<paneId>_<sid>.PermissionRequest.<id>.json` create → `Handler.onPreToolUse`
 *   (daemon does NOT unlink — hook subprocess polls Response and cleans both)
 *
 * Per-pane+sid dispatch chain: events for the same `(paneId, sid)` pair
 * are processed serially (preserves Stop-order across multiple Stop files
 * dropped close together; daemon-down then up sees them in chronological
 * order). Different pane+sid pairs dispatch in parallel.
 *
 * `enqueueInjection(sessionId, content)` is the bridge router's entry into
 * the Stop-hook injection mechanism — content gets popped by the next
 * non-active Stop hook fire (see `runHookReceiver` Stop branch).
 */
export function createCcCliAdapter(opts: CreateCcCliAdapterOpts): CLIAdapter {
  let watcher: FSWatcher | undefined;
  let handler: CLIHandler | undefined;
  /**
   * Per-(paneId, sessionId) serial dispatch chain. Stop files for the same
   * cc are written one per turn; daemon must process them in arrival order
   * so the IM channel sees the assistant turns in correct order. Different
   * cc sessions are independent and dispatch in parallel.
   *
   * Key: `<paneId>_<sid>` — same as the file prefix.
   */
  const sessionChains = new Map<string, Promise<void>>();
  /**
   * Tracks files we've already scheduled for dispatch in this process, so a
   * second chokidar event (rare 'add' + 'change' for same path) doesn't
   * double-dispatch.
   */
  const seenFiles = new Set<string>();

  function chainKey(c: ClassifiedFile): string {
    return `${c.paneId}_${c.sessionId}`;
  }

  function scheduleDispatch(classified: ClassifiedFile): void {
    if (seenFiles.has(classified.filePath)) return;
    seenFiles.add(classified.filePath);

    const key = chainKey(classified);
    const prev = sessionChains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (!handler) return;
      try {
        await dispatchOne(handler, classified);
      } catch (err) {
        opts.onHandlerError?.(err, {
          kind: classified.kind,
          paneId: classified.paneId,
          sessionId: classified.sessionId,
        });
      } finally {
        seenFiles.delete(classified.filePath);
      }
    });
    sessionChains.set(key, next);
  }

  return {
    name: 'claude-code',

    async start(h: CLIHandler): Promise<void> {
      if (watcher) {
        throw new Error('createCcCliAdapter: already started');
      }
      handler = h;

      const w = chokidar.watch(opts.stateDir, {
        ignoreInitial: false,
        persistent: true,
        awaitWriteFinish: false,
        depth: 0,
      });
      watcher = w;

      // Buffer initial-scan adds + drain in basename-sorted order so
      // backlogged Stop files dispatch in chronological (= lex) order
      // regardless of OS readdir order. Live events post-'ready' dispatch
      // immediately.
      let initialScanComplete = false;
      const backlog: ClassifiedFile[] = [];

      const onAdd = (filePath: string): void => {
        const classified = classifyStateFile(filePath, basename(filePath));
        if (!classified) return;
        if (!initialScanComplete) {
          backlog.push(classified);
          return;
        }
        scheduleDispatch(classified);
      };
      w.on('add', onAdd);
      w.on('change', onAdd);

      await new Promise<void>((resolve) => {
        w.once('ready', () => resolve());
      });
      initialScanComplete = true;

      backlog.sort((a, b) =>
        basename(a.filePath).localeCompare(basename(b.filePath)),
      );
      for (const c of backlog) scheduleDispatch(c);
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
): Promise<void> {
  switch (classified.kind) {
    case 'PreToolUse': {
      const file = await readPermissionRequestFile(classified.filePath);
      if (!file) return; // ENOENT — file already cleaned up
      const payload: PreToolUsePayload & {
        requestId: string;
        paneId: number;
      } = {
        session_id: classified.sessionId as unknown as SessionId,
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'PreToolUse',
        permission_mode: '',
        tool_name: file.toolName,
        tool_input: file.toolInput,
        tool_use_id: '',
        requestId: file.requestId,
        paneId: classified.paneId,
      };
      await handler.onPreToolUse(payload);
      // Daemon does NOT unlink — hook subprocess polls Response then
      // cleans both Request and Response itself.
      return;
    }

    case 'Stop': {
      const file = await readStopFile(classified.filePath);
      if (!file) return; // ENOENT — already processed by another tick
      const payload: StopPayload & { paneId: number } = {
        session_id: classified.sessionId as unknown as SessionId,
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'Stop',
        permission_mode: '',
        stop_hook_active: false,
        last_assistant_message: file.last_assistant_message,
        paneId: classified.paneId,
      };
      await handler.onStop(payload);
      // Forward succeeded → unlink so the file doesn't replay on next
      // daemon restart. Throws → onHandlerError already logged; leave
      // the file for next-run retry / sweep cleanup.
      await deleteStopFile(classified.filePath);
      return;
    }
  }
}
