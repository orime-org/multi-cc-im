import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionId } from '@multi-cc-im/shared';
import { atomicWrite } from '@multi-cc-im/storage-files';
import type { RouterState } from './router.js';

export interface CreatePersistentRouterStateOpts {
  /** Where state files live (e.g. `~/.multi-cc-im/state/`). */
  stateDir: string;
}

const FILE_NAME = 'current-session';

/**
 * File-backed RouterState for the router's `current_session` last-explicit-
 * mention sticky default. Restart-safe: bridge boots → reads file →
 * router.getCurrent() returns the persisted value. Synchronous getter (matches
 * `RouterState` contract); async write fire-and-forget after `setCurrent`.
 *
 * File: `<stateDir>/current-session` — single line, contains the SessionId
 * UUID v4 string, or empty when current is null. Atomic write via
 * `@multi-cc-im/storage-files` (mode 0600 + same-dir tmp + fsync + rename).
 */
export async function createPersistentRouterState(
  opts: CreatePersistentRouterStateOpts,
): Promise<RouterState> {
  const filePath = join(opts.stateDir, FILE_NAME);

  let current: SessionId | null = null;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const trimmed = raw.trim();
    if (trimmed.length > 0) current = trimmed as SessionId;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return {
    getCurrent(): SessionId | null {
      return current;
    },
    setCurrent(id: SessionId | null): void {
      current = id;
      // Fire-and-forget: persist asynchronously. Worst case on crash mid-
      // write is the file holds the previous value (atomicWrite uses tmp +
      // rename so we never see a torn write).
      void atomicWrite(filePath, id ?? '');
    },
  };
}
