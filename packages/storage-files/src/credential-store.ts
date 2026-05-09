import type { CredentialStore } from '@multi-cc-im/shared';
import { readFile, rm } from 'node:fs/promises';
import type { ZodType } from 'zod';
import { atomicWrite } from './atomic-write.js';
import { isENOENT } from './utils.js';

export interface CredentialStoreOpts<T> {
  /**
   * Absolute path to the credentials JSON file
   * (e.g. `~/.multi-cc-im/credentials/lark.json`).
   */
  filePath: string;
  /**
   * zod schema validating the credentials shape on **both** load and save.
   * Per CLAUDE.md "validate external input via zod at runtime" — credentials
   * read from disk are external input.
   */
  schema: ZodType<T>;
}

/**
 * File-backed CredentialStore. JSON serialization, atomic write at mode 0600
 * (via `atomicWrite`), schema-validated on every load and save.
 *
 * Per [DD: credentials persistence strategy](../../../../docs/superpowers/specs/2026-05-03-keychain-library-dd.md)
 * we deliberately don't use OS keychain — see CLAUDE.md "credentials persist
 * to disk at 0600".
 */
export function createCredentialStore<T>(
  opts: CredentialStoreOpts<T>,
): CredentialStore<T> {
  const { filePath, schema } = opts;
  return {
    async load(): Promise<T | null> {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
      // JSON.parse + schema.parse both throw on malformed input — both are
      // fail-fast surface for a corrupted credentials file.
      return schema.parse(JSON.parse(raw));
    },
    async save(credentials: T): Promise<void> {
      const validated = schema.parse(credentials);
      await atomicWrite(filePath, JSON.stringify(validated, null, 2));
    },
    async delete(): Promise<void> {
      try {
        await rm(filePath);
      } catch (err) {
        if (isENOENT(err)) return;
        throw err;
      }
    },
  };
}
