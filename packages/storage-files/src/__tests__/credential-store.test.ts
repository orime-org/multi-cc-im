import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createCredentialStore } from '../credential-store.js';

// Test schema is a generic IM credential shape (token + savedAt). Lives here
// so storage-files stays IM-agnostic; concrete IM adapters (lark / etc.)
// declare their own schema and pass it to createCredentialStore.
const TestCredsSchema = z.object({
  token: z.string().min(1),
  savedAt: z.string().optional(),
});
type TestCreds = z.infer<typeof TestCredsSchema>;

describe('CredentialStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcim-cred-'));
    filePath = join(tmpDir, 'lark.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeStore() {
    return createCredentialStore<TestCreds>({
      filePath,
      schema: TestCredsSchema,
    });
  }

  it('returns null on first run when file does not exist', async () => {
    expect(await makeStore().load()).toBeNull();
  });

  it('persists credentials and reads them back', async () => {
    const store = makeStore();
    await store.save({ token: 'tok-123', savedAt: '2026-05-04T00:00:00Z' });
    expect(await store.load()).toEqual({
      token: 'tok-123',
      savedAt: '2026-05-04T00:00:00Z',
    });
  });

  it('overwrites credentials on subsequent save (atomic)', async () => {
    const store = makeStore();
    await store.save({ token: 'first' });
    await store.save({ token: 'second' });
    expect(await store.load()).toEqual({ token: 'second' });
  });

  it('writes file with mode 0600 (owner read/write only)', async () => {
    const store = makeStore();
    await store.save({ token: 'tok' });
    const stats = await stat(filePath);
    // Lower 9 bits = unix permission
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('creates parent directories when missing', async () => {
    const nested = join(tmpDir, 'credentials', 'lark.json');
    const store = createCredentialStore<TestCreds>({
      filePath: nested,
      schema: TestCredsSchema,
    });
    await store.save({ token: 'via-mkdir' });
    expect(await store.load()).toEqual({ token: 'via-mkdir' });
  });

  it('rejects save() with malformed credentials via zod (fail-fast)', async () => {
    const store = makeStore();
    await expect(
      store.save({ token: '' } as unknown as TestCreds),
    ).rejects.toThrow();
  });

  it('rejects load() when on-disk JSON does not match schema (corruption)', async () => {
    await writeFile(filePath, JSON.stringify({ unrelated: true }), 'utf-8');
    await expect(makeStore().load()).rejects.toThrow();
  });

  it('rejects load() when on-disk content is not valid JSON', async () => {
    await writeFile(filePath, 'not-json{{{', 'utf-8');
    await expect(makeStore().load()).rejects.toThrow();
  });

  it('delete() removes the file; subsequent load() returns null', async () => {
    const store = makeStore();
    await store.save({ token: 'will-be-gone' });
    await store.delete();
    expect(await store.load()).toBeNull();
  });

  it('delete() is idempotent — no error when file already absent', async () => {
    await expect(makeStore().delete()).resolves.toBeUndefined();
  });

  it('two stores at same path see each other', async () => {
    const a = makeStore();
    const b = makeStore();
    await a.save({ token: 'from-a' });
    expect(await b.load()).toEqual({ token: 'from-a' });
  });
});
