import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import type {
  CLIAdapter,
  CLIHandler,
  CwdAbs,
  PaneId,
  PermissionRequestPayload,
  PreToolUsePayload,
  SessionId,
  StopPayload,
  TerminalId,
  TranscriptPath,
} from '@multi-cc-im/shared';
import { enqueueInjection } from './injection-queue.js';
import {
  deleteStopFile,
  parsePermissionDialogFilename,
  parsePermissionFilename,
  parseStopFilename,
  readPermissionDialogRequestFile,
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
      kind: 'PreToolUse' | 'PermissionDialog' | 'Stop';
      paneId: PaneId;
      sessionId: string;
    },
  ) => void;
}

interface ClassifiedStopFile {
  kind: 'Stop';
  paneId: PaneId;
  sessionId: string;
  filePath: string;
}

interface ClassifiedPreToolUseFile {
  kind: 'PreToolUse';
  paneId: PaneId;
  sessionId: string;
  requestId: string;
  filePath: string;
}

interface ClassifiedPermissionDialogFile {
  kind: 'PermissionDialog';
  paneId: PaneId;
  sessionId: string;
  requestId: string;
  filePath: string;
}

type ClassifiedFile =
  | ClassifiedStopFile
  | ClassifiedPreToolUseFile
  | ClassifiedPermissionDialogFile;

/**
 * Classify a state-dir basename. Returns null for any file that's not a
 * cc-hook-fired event we route on (i.e. ignores `<paneId>.IMOrigin` /
 * `IMWork` / `daemon.pid` / IM-adapter-owned top-level files like
 * `lark-cursor` / `<paneId>_<sid>.PermissionResponse.*` /
 * `<paneId>_<sid>.PermissionDialogResponse.*` — the daemon writes
 * Responses, hook reads them; daemon does not dispatch Response chokidar
 * events to handlers).
 *
 * Per [DD: pane-keyed state files](../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * + [DD: PermissionRequest hook IM bridge](../../../docs/superpowers/specs/2026-05-13-permission-request-hook-bridge-dd.md):
 *   - `<paneId>_<sid>.Stop.<ts>`                          → ClassifiedStopFile
 *   - `<paneId>_<sid>.PermissionRequest.<id>.json`        → ClassifiedPreToolUseFile
 *   - `<paneId>_<sid>.PermissionDialogRequest.<id>.json`  → ClassifiedPermissionDialogFile
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
  // Try PermissionDialog FIRST — the regex for it is more specific than
  // the older PermissionRequest match (which would otherwise greedily
  // accept "PermissionDialogRequest" too via its broader pattern). The
  // parsers' regexes already disambiguate, but the order keeps it
  // explicit + immune to a future parser tweak.
  const permDialog = parsePermissionDialogFilename(fileBasename);
  if (permDialog && permDialog.kind === 'request') {
    return {
      kind: 'PermissionDialog',
      paneId: permDialog.paneId,
      sessionId: permDialog.sessionId,
      requestId: permDialog.requestId,
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
        paneId: PaneId;
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

    case 'PermissionDialog': {
      const file = await readPermissionDialogRequestFile(classified.filePath);
      if (!file) return; // ENOENT — file already cleaned up
      if (!handler.onPermissionDialog) return; // handler doesn't subscribe
      const payload: PermissionRequestPayload & {
        requestId: string;
        paneId: PaneId;
      } = {
        session_id: classified.sessionId as unknown as SessionId,
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'PermissionRequest',
        tool_name: file.toolName,
        tool_input: file.toolInput,
        permission_suggestions: file.permissionSuggestions,
        requestId: file.requestId,
        paneId: classified.paneId,
      };
      await handler.onPermissionDialog(payload);
      // Daemon does NOT unlink — hook subprocess polls Response then
      // cleans both Request and Response itself.
      return;
    }

    case 'Stop': {
      const file = await readStopFile(classified.filePath);
      if (!file) return; // ENOENT — already processed by another tick
      const payload: StopPayload & { paneId: PaneId; termId?: TerminalId } = {
        session_id: classified.sessionId as unknown as SessionId,
        transcript_path: '' as unknown as TranscriptPath,
        cwd: '' as unknown as CwdAbs,
        hook_event_name: 'Stop',
        permission_mode: '',
        stop_hook_active: false,
        last_assistant_message: file.last_assistant_message,
        paneId: classified.paneId,
        termId: file.termId,
      };
      // Delete-always semantics (user policy 2026-05-11): once we've
      // dispatched the Stop file to the orchestrator, drop it from disk
      // regardless of forward success. Keeping it around for "next-run
      // retry" was misleading — the daemon's state-sweep is only on
      // start, so failed forwards already could not auto-retry. Better
      // to delete cleanly + let the next cc reply produce a fresh Stop.
      try {
        await handler.onStop(payload);
      } finally {
        await deleteStopFile(classified.filePath);
      }
      return;
    }
  }
}
