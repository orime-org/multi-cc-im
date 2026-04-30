import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursorStore } from '../cursor-store.js';

describe('CursorStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcim-cs-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null on first run when file does not exist', async () => {
    const store = createCursorStore({ filePath: join(tmpDir, 'cursor.txt') });
    expect(await store.get()).toBeNull();
  });

  it('persists cursor and reads it back', async () => {
    const store = createCursorStore({ filePath: join(tmpDir, 'cursor.txt') });
    await store.set('cursor-abc-123');
    expect(await store.get()).toBe('cursor-abc-123');
  });

  it('overwrites cursor on subsequent set', async () => {
    const store = createCursorStore({ filePath: join(tmpDir, 'cursor.txt') });
    await store.set('first');
    await store.set('second');
    expect(await store.get()).toBe('second');
  });

  it('preserves whitespace and special chars exactly', async () => {
    const store = createCursorStore({ filePath: join(tmpDir, 'cursor.txt') });
    const tricky = 'line1\nline2ÿ\t';
    await store.set(tricky);
    expect(await store.get()).toBe(tricky);
  });

  it('creates parent directories when missing', async () => {
    const store = createCursorStore({
      filePath: join(tmpDir, 'state', 'cursor.txt'),
    });
    await store.set('via-mkdir');
    expect(await store.get()).toBe('via-mkdir');
  });

  it('two stores at same path see each other', async () => {
    const path = join(tmpDir, 'cursor.txt');
    const a = createCursorStore({ filePath: path });
    const b = createCursorStore({ filePath: path });
    await a.set('from-a');
    expect(await b.get()).toBe('from-a');
  });
});
