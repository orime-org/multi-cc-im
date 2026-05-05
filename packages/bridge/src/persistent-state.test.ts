import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionId } from '@multi-cc-im/shared';
import {
  createPersistentRouterState,
  type PersistentRouterState,
} from './persistent-state.js';

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa' as SessionId;
const SID_B = '22222222-3606-4fe4-b01d-bbbbbbbbbbbb' as SessionId;

describe('createPersistentRouterState', () => {
  let stateDir: string;
  let openStates: PersistentRouterState[] = [];

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'pst-'));
    openStates = [];
  });

  afterEach(async () => {
    // Drain pending writes for every state created in this test before
    // wiping the dir — otherwise an in-flight atomicWrite will race the
    // `rm -rf` and fail with ENOENT during rename.
    for (const s of openStates) await s.flush();
    await rm(stateDir, { recursive: true, force: true });
  });

  async function makeState(): Promise<PersistentRouterState> {
    const s = await createPersistentRouterState({ stateDir });
    openStates.push(s);
    return s;
  }

  it('first call returns null when no file exists', async () => {
    const state = await makeState();
    expect(state.getCurrent()).toBeNull();
  });

  it('setCurrent persists to file; getCurrent reads in-memory cached value', async () => {
    const state = await makeState();
    state.setCurrent(SID_A);
    expect(state.getCurrent()).toBe(SID_A);

    await state.flush();
    const raw = await readFile(join(stateDir, 'current-session'), 'utf-8');
    expect(raw.trim()).toBe(SID_A);
  });

  it('persistence survives "restart" (new state instance reads existing file)', async () => {
    const state1 = await makeState();
    state1.setCurrent(SID_A);
    await state1.flush();

    const state2 = await makeState();
    expect(state2.getCurrent()).toBe(SID_A);
  });

  it('setCurrent(null) clears file (empty string written)', async () => {
    const state = await makeState();
    state.setCurrent(SID_A);
    state.setCurrent(null);
    expect(state.getCurrent()).toBeNull();

    await state.flush();
    const raw = await readFile(join(stateDir, 'current-session'), 'utf-8');
    expect(raw.trim()).toBe('');
  });

  it('back-to-back setCurrent calls land in submission order (write chain serialized)', async () => {
    const state = await makeState();
    state.setCurrent(SID_A);
    state.setCurrent(SID_B);
    state.setCurrent(SID_A);
    state.setCurrent(null);

    await state.flush();
    const raw = await readFile(join(stateDir, 'current-session'), 'utf-8');
    expect(raw.trim()).toBe('');
    expect(state.getCurrent()).toBeNull();
  });

  it('writes file with mode 0600 (atomic write semantics)', async () => {
    const state = await makeState();
    state.setCurrent(SID_A);
    await state.flush();
    const stats = await stat(join(stateDir, 'current-session'));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('creates nested stateDir if missing', async () => {
    const nested = join(stateDir, 'level1', 'level2');
    const state = await createPersistentRouterState({ stateDir: nested });
    openStates.push(state);
    state.setCurrent(SID_A);
    await state.flush();
    expect(state.getCurrent()).toBe(SID_A);
  });

  it('ignores file containing whitespace-only string (treats as null)', async () => {
    await writeFile(join(stateDir, 'current-session'), '\n\n  \n', 'utf-8');
    const state = await makeState();
    expect(state.getCurrent()).toBeNull();
  });

  it('write errors surface via onWriteError (no unhandled rejection)', async () => {
    const errors: unknown[] = [];
    // Path under /dev/null can't be created on Linux/macOS — atomicWrite mkdir fails
    const badDir = '/dev/null/cannot-create';
    const state = await createPersistentRouterState({
      stateDir: badDir,
      onWriteError: (err) => errors.push(err),
    });
    state.setCurrent(SID_A);
    await state.flush();
    expect(errors.length).toBeGreaterThan(0);
  });
});
