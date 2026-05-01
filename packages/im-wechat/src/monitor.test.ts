import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CursorStore } from '@multi-cc-im/shared';
import type { GetUpdatesResp, WeixinMessage } from '../lib/ilink/api/types.js';

const mockGetUpdates = vi.hoisted(() => vi.fn());
vi.mock('../lib/ilink/api/api.js', () => ({
  getUpdates: mockGetUpdates,
}));

// Backoff sleep: instant in tests so error-path coverage doesn't hang
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => {}),
}));

const { runMonitor } = await import('./monitor.js');

function makeCursorStore(initial: string | null = null) {
  const state: { value: string | null } = { value: initial };
  const store: CursorStore = {
    get: vi.fn(async () => state.value),
    set: vi.fn(async (cursor: string) => {
      state.value = cursor;
    }),
  };
  return { store, state };
}

beforeEach(() => {
  mockGetUpdates.mockReset();
});

describe('runMonitor', () => {
  it('forwards each message and persists the new cursor on success', async () => {
    const { store, state } = makeCursorStore(null);
    const msg: WeixinMessage = { from_user_id: 'u1', message_id: 1 };
    const resp: GetUpdatesResp = {
      msgs: [msg],
      get_updates_buf: 'cursor-1',
    };
    const ac = new AbortController();
    let calls = 0;
    mockGetUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return resp;
      ac.abort();
      return { msgs: [], get_updates_buf: 'cursor-2' };
    });

    const onMessage = vi.fn(async () => {});
    await runMonitor({
      baseUrl: 'http://x',
      token: 't',
      cursorStore: store,
      onMessage,
      abortSignal: ac.signal,
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(msg);
    expect(state.value).toBe('cursor-2');
    expect(store.set).toHaveBeenCalled();
  });

  it('passes the persisted cursor as get_updates_buf on next iteration', async () => {
    const { store } = makeCursorStore('saved-cursor');
    const ac = new AbortController();
    mockGetUpdates.mockImplementation(async () => {
      ac.abort();
      return { msgs: [], get_updates_buf: 'saved-cursor' };
    });
    await runMonitor({
      baseUrl: 'http://x',
      token: 't',
      cursorStore: store,
      onMessage: async () => {},
      abortSignal: ac.signal,
    });
    expect(mockGetUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ get_updates_buf: 'saved-cursor' }),
    );
  });

  it('routes business errcode to onError without exiting the loop', async () => {
    const { store } = makeCursorStore(null);
    const ac = new AbortController();
    let calls = 0;
    mockGetUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { errcode: -14, errmsg: 'session expired' };
      ac.abort();
      return { msgs: [], get_updates_buf: 'after-error' };
    });
    const onError = vi.fn();
    await runMonitor({
      baseUrl: 'http://x',
      token: 't',
      cursorStore: store,
      onMessage: async () => {},
      onError,
      abortSignal: ac.signal,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toContain('errcode=-14');
  });

  it('exits cleanly when abortSignal is aborted before first poll', async () => {
    const { store } = makeCursorStore(null);
    const ac = new AbortController();
    ac.abort();
    await runMonitor({
      baseUrl: 'http://x',
      token: 't',
      cursorStore: store,
      onMessage: async () => {},
      abortSignal: ac.signal,
    });
    expect(mockGetUpdates).not.toHaveBeenCalled();
  });

  it('routes thrown errors to onError without exiting the loop', async () => {
    const { store } = makeCursorStore(null);
    const ac = new AbortController();
    let calls = 0;
    mockGetUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('network blip');
      ac.abort();
      return { msgs: [], get_updates_buf: 'after-throw' };
    });
    const onError = vi.fn();
    await runMonitor({
      baseUrl: 'http://x',
      token: 't',
      cursorStore: store,
      onMessage: async () => {},
      onError,
      abortSignal: ac.signal,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('network blip');
  });
});
