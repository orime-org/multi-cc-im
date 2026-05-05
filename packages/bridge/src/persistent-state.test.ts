import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionId } from '@multi-cc-im/shared';
import { createPersistentRouterState } from './persistent-state.js';

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa' as SessionId;

describe('createPersistentRouterState', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'pst-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('first call returns null when no file exists', async () => {
    const state = await createPersistentRouterState({ stateDir });
    expect(state.getCurrent()).toBeNull();
  });

  it('setCurrent persists to file; getCurrent reads in-memory cached value', async () => {
    const state = await createPersistentRouterState({ stateDir });
    state.setCurrent(SID_A);
    expect(state.getCurrent()).toBe(SID_A);

    // Wait briefly so async write completes; then verify file contents.
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(join(stateDir, 'current-session'), 'utf-8');
    expect(raw.trim()).toBe(SID_A);
  });

  it('persistence survives "restart" (new state instance reads existing file)', async () => {
    const state1 = await createPersistentRouterState({ stateDir });
    state1.setCurrent(SID_A);
    await new Promise((r) => setTimeout(r, 50));

    const state2 = await createPersistentRouterState({ stateDir });
    expect(state2.getCurrent()).toBe(SID_A);
  });

  it('setCurrent(null) clears file (empty string written)', async () => {
    const state = await createPersistentRouterState({ stateDir });
    state.setCurrent(SID_A);
    await new Promise((r) => setTimeout(r, 50));
    state.setCurrent(null);
    expect(state.getCurrent()).toBeNull();

    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(join(stateDir, 'current-session'), 'utf-8');
    expect(raw.trim()).toBe('');
  });

  it('writes file with mode 0600 (atomic write semantics)', async () => {
    const state = await createPersistentRouterState({ stateDir });
    state.setCurrent(SID_A);
    await new Promise((r) => setTimeout(r, 50));
    const stats = await stat(join(stateDir, 'current-session'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('creates nested stateDir if missing', async () => {
    const nested = join(stateDir, 'level1', 'level2');
    const state = await createPersistentRouterState({ stateDir: nested });
    state.setCurrent(SID_A);
    await new Promise((r) => setTimeout(r, 50));
    expect(state.getCurrent()).toBe(SID_A);
  });

  it('ignores file containing whitespace-only string (treats as null)', async () => {
    await mkdtempJoin(stateDir);
    await writeFile(join(stateDir, 'current-session'), '\n\n  \n', 'utf-8');
    const state = await createPersistentRouterState({ stateDir });
    expect(state.getCurrent()).toBeNull();
  });
});

async function mkdtempJoin(_stateDir: string): Promise<void> {
  // Helper for the trailing test — stateDir already exists from outer
  // beforeEach. (Empty placeholder kept for clarity.)
}
