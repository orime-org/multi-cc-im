import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId } from '@multi-cc-im/shared';
import { atomicWrite } from '@multi-cc-im/storage-files';
import type { RouterState } from './router.js';

export interface CreatePersistentRouterStateOpts {
  /** Where state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
  /**
   * Non-fatal write-error sink. Writes happen async (`setCurrent` doesn't
   * await), so caller hands a logger via this hook. Default: silently
   * swallow (so unhandled rejections don't crash the bridge).
   */
  onWriteError?: (err: unknown) => void;
}

/**
 * `RouterState` extended with a `flush()` for clean shutdown / test teardown.
 * `setCurrent` writes are serialized via an internal Promise chain; `flush()`
 * resolves once every queued write has hit the filesystem.
 */
export interface PersistentRouterState extends RouterState {
  /**
   * Await all in-flight writes triggered by prior `setCurrent` calls. Caller
   * (main entry CLI on Ctrl+C, tests in afterEach) uses this to avoid
   * racing `rm -rf` against pending atomicWrite renames.
   */
  flush(): Promise<void>;
}

const FILE_NAME = 'current-session';

/**
 * File-backed RouterState for the router's `current_session` last-explicit-
 * mention sticky default. Restart-safe: bridge boots → reads file →
 * router.getCurrent() returns the persisted value. Synchronous getter (matches
 * `RouterState` contract); writes are queued via an internal Promise chain
 * so back-to-back `setCurrent` calls land on disk in submission order (the
 * last call wins, deterministically). Without serialization, racing
 * `atomicWrite` calls would `rename` in non-deterministic order and the file
 * could end up reflecting an older value than the most recent `setCurrent`.
 *
 * File: `<stateDir>/current-session` — single line, contains the SessionId
 * UUID v4 string, or empty when current is null. Atomic write via
 * `@multi-cc-im/storage-files` (mode 0600 + same-dir tmp + fsync + rename).
 */
export async function createPersistentRouterState(
  opts: CreatePersistentRouterStateOpts,
): Promise<PersistentRouterState> {
  const filePath = join(opts.stateDir, FILE_NAME);
  const onWriteError = opts.onWriteError ?? (() => {});

  let current: SessionId | null = null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const trimmed = raw.trim();
    if (trimmed.length > 0) current = trimmed as SessionId;
  } catch (err) {
    // Swallow any read failure (ENOENT first-run / ENOTDIR bad parent /
    // EACCES permission / corrupt file) — start fresh. Failing bridge boot
    // because of a transient state-file issue is worse UX than losing
    // current_session (router falls back to "no current" which is recoverable
    // via @<name>). Surface via onWriteError so caller can log.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      onWriteError(err);
    }
  }

  let writeChain: Promise<void> = Promise.resolve();

  return {
    getCurrent(): SessionId | null {
      return current;
    },
    setCurrent(id: SessionId | null): void {
      current = id;
      const target = id ?? '';
      writeChain = writeChain.then(() =>
        atomicWrite(filePath, target).catch((err) => onWriteError(err)),
      );
    },
    async flush(): Promise<void> {
      await writeChain;
    },
  };
}
