import type { CursorStore } from '@multi-cc-im/shared';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.js';
import { isENOENT } from './utils.js';

export interface CursorStoreOpts {
  /** Absolute path where the cursor string is persisted. */
  filePath: string;
}

/**
 * File-backed CursorStore. Stores a single string (e.g. iLink long-poll
 * cursor) at `filePath`. Set is atomic; first-run get returns null.
 */
export function createCursorStore(opts: CursorStoreOpts): CursorStore {
  const { filePath } = opts;
  return {
    async get(): Promise<string | null> {
      try {
        return await readFile(filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
    },
    async set(cursor: string): Promise<void> {
      await atomicWrite(filePath, cursor);
    },
  };
}
