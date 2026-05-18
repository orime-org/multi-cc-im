import { describe, it, expect } from 'vitest';
import { createTenantTokenStore } from './tenant-token.js';

function mockFetchOk(token: string, expireSec = 7200) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ code: 0, tenant_access_token: token, expire: expireSec }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return Object.assign(impl, { getCalls: () => calls });
}

describe('createTenantTokenStore', () => {
  it('fetches token on first call', async () => {
    const fetchImpl = mockFetchOk('tok-1');
    const store = createTenantTokenStore({ fetchImpl, now: () => 1000 });
    expect(await store.getToken('app-x', 'sec-y')).toBe('tok-1');
    expect(fetchImpl.getCalls()).toBe(1);
  });

  it('caches token within validity window', async () => {
    const fetchImpl = mockFetchOk('tok-2', 7200);
    let nowMs = 1000;
    const store = createTenantTokenStore({ fetchImpl, now: () => nowMs });
    expect(await store.getToken('app-a', 'sec-a')).toBe('tok-2');
    // 1 hour later — well within 2h validity
    nowMs += 3600 * 1000;
    expect(await store.getToken('app-a', 'sec-a')).toBe('tok-2');
    expect(fetchImpl.getCalls()).toBe(1);
  });

  it('refreshes token after refresh margin elapsed', async () => {
    let counter = 0;
    let nowMs = 1000;
    const fetchImpl = async () => {
      counter += 1;
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: `tok-${counter}`, expire: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const store = createTenantTokenStore({
      fetchImpl,
      now: () => nowMs,
      refreshMarginSeconds: 60,
    });
    expect(await store.getToken('app', 'sec')).toBe('tok-1');
    // Jump past refresh threshold (7200 - 60 = 7140s = 7,140,000ms)
    nowMs += 7141 * 1000;
    expect(await store.getToken('app', 'sec')).toBe('tok-2');
    expect(counter).toBe(2);
  });

  it('keys cache by appId so two apps don\'t share token', async () => {
    let counter = 0;
    const fetchImpl = async () => {
      counter += 1;
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: `tok-${counter}`, expire: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const store = createTenantTokenStore({ fetchImpl, now: () => 1000 });
    expect(await store.getToken('app-1', 'sec-1')).toBe('tok-1');
    expect(await store.getToken('app-2', 'sec-2')).toBe('tok-2');
    // each app cached separately
    expect(await store.getToken('app-1', 'sec-1')).toBe('tok-1');
    expect(await store.getToken('app-2', 'sec-2')).toBe('tok-2');
    expect(counter).toBe(2);
  });

  it('throws when Feishu returns no tenant_access_token', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ code: 99991663, msg: 'app not found' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    const store = createTenantTokenStore({ fetchImpl });
    await expect(store.getToken('app', 'sec')).rejects.toThrow(/code=99991663/);
  });

  it('clear() drops cached tokens forcing re-fetch', async () => {
    let counter = 0;
    const fetchImpl = async () => {
      counter += 1;
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: `tok-${counter}`, expire: 7200 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const store = createTenantTokenStore({ fetchImpl, now: () => 1000 });
    expect(await store.getToken('app', 'sec')).toBe('tok-1');
    store.clear();
    expect(await store.getToken('app', 'sec')).toBe('tok-2');
  });
});
