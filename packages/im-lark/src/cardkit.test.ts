import { describe, it, expect, vi } from 'vitest';
import { createCardKitClient } from './cardkit.js';
import type { TenantTokenStore } from './tenant-token.js';

function fakeTokenStore(token = 'tok'): TenantTokenStore {
  return {
    async getToken() {
      return token;
    },
    clear() {},
  };
}

interface CapturedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function makeCallRecorder(
  responseBuilder: (call: CapturedCall) => Record<string, unknown>,
) {
  const calls: CapturedCall[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : (url as URL).toString();
    const path = u.replace(/^https?:\/\/[^/]+\/open-apis\/cardkit\/v1/, '');
    const method = init?.method ?? 'GET';
    const body =
      init?.body && typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const call: CapturedCall = { method, path, body };
    calls.push(call);
    const data = responseBuilder(call);
    return new Response(JSON.stringify({ code: 0, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchImpl: impl, calls };
}

describe('createCardKitClient', () => {
  it('convertMessageToCard hits POST /cards/id_convert with message_id', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({ card_id: 'card-xyz' }));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    const id = await c.convertMessageToCard('msg-123');
    expect(id).toBe('card-xyz');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/cards/id_convert');
    expect(calls[0]?.body?.message_id).toBe('msg-123');
  });

  it('createCardEntity wraps card JSON in {type:card_json, data:<stringified>}', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({ card_id: 'new' }));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    const id = await c.createCardEntity({ schema: '2.0', body: { elements: [] } });
    expect(id).toBe('new');
    expect(calls[0]?.body?.type).toBe('card_json');
    expect(JSON.parse(calls[0]?.body?.data as string)).toEqual({
      schema: '2.0',
      body: { elements: [] },
    });
  });

  it('streamText PUTs element content with monotonic sequence per cardId', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.streamText('card-A', 'el-1', 'hello');
    await c.streamText('card-A', 'el-1', 'hello world');
    await c.streamText('card-B', 'el-1', 'other card');
    // card-A: seq 1, 2 ; card-B: seq 1 (independent counter)
    const aCalls = calls.filter((x) => x.path.startsWith('/cards/card-A/'));
    const bCalls = calls.filter((x) => x.path.startsWith('/cards/card-B/'));
    expect(aCalls.map((x) => x.body?.sequence)).toEqual([1, 2]);
    expect(bCalls.map((x) => x.body?.sequence)).toEqual([1]);
  });

  it('streamText drops empty / whitespace-only content (Feishu would reject 99992402)', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.streamText('card-A', 'el-1', '');
    await c.streamText('card-A', 'el-1', '   ');
    await c.streamText('card-A', 'el-1', 'real');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.content).toBe('real');
  });

  it('addElement defaults type=append; targetElementId opt sets target_element_id', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.addElement('card', { tag: 'div' });
    await c.addElement('card', { tag: 'hr' }, { type: 'insert_after', targetElementId: 'el-x' });
    expect(calls[0]?.body?.type).toBe('append');
    expect(calls[0]?.body?.target_element_id).toBeUndefined();
    expect(calls[1]?.body?.type).toBe('insert_after');
    expect(calls[1]?.body?.target_element_id).toBe('el-x');
  });

  it('replaceElement PUTs to /cards/:id/elements/:elem with stringified element', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.replaceElement('card', 'el-1', { tag: 'text', content: 'final' });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.path).toBe('/cards/card/elements/el-1');
    expect(JSON.parse(calls[0]?.body?.element as string)).toEqual({
      tag: 'text',
      content: 'final',
    });
  });

  it('deleteElement DELETEs /cards/:id/elements/:elem', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.deleteElement('card', 'el-1');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.path).toBe('/cards/card/elements/el-1');
  });

  it('patchSettings PATCHes /cards/:id/settings with stringified settings', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.patchSettings('card', { config: { streaming_mode: false } });
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.path).toBe('/cards/card/settings');
    expect(JSON.parse(calls[0]?.body?.settings as string)).toEqual({
      config: { streaming_mode: false },
    });
  });

  it('auto-reopens streaming when call returns code=300309 then retries once', async () => {
    let writes = 0;
    let reopens = 0;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as URL).toString();
      const path = u.replace(/^https?:\/\/[^/]+\/open-apis\/cardkit\/v1/, '');
      // streaming reopen path
      if (init?.method === 'PATCH' && path.endsWith('/settings')) {
        reopens += 1;
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      }
      // content writes: first fails 300309, then succeeds
      writes += 1;
      if (writes === 1) {
        return new Response(
          JSON.stringify({ code: 300309, msg: 'streaming mode is closed' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    };
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.streamText('card', 'el', 'content');
    expect(writes).toBe(2); // initial + retry
    expect(reopens).toBe(1);
  });

  it('streamText for same content twice — second skipped via lastSent? (NO — explicit streamText always writes; throttled is the dedup path)', async () => {
    // Explicit streamText always writes (caller's intent). Dedup is only
    // for throttled streamTextThrottled via the lastSent check at flush
    // time. Regression-pin this contract so callers can rely on it.
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.streamText('card', 'el', 'same');
    await c.streamText('card', 'el', 'same');
    expect(calls).toHaveLength(2);
  });

  it('streamTextThrottled buffers + flush() drains once', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
      flushIntervalMs: 1_000_000, // huge — only manual flush should fire
      flushMinDelta: 10_000, // huge — no delta-based flush
    });
    c.streamTextThrottled('card', 'el-1', 'a');
    c.streamTextThrottled('card', 'el-1', 'ab');
    c.streamTextThrottled('card', 'el-1', 'abc');
    await c.flush('card');
    // Only the latest buffered content gets PUT once
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.content).toBe('abc');
  });

  it('throws on non-zero non-streaming-closed code (e.g. 99992402)', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ code: 99992402, msg: 'field validation failed' }),
        { status: 200 },
      );
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
      log: () => {}, // swallow log noise
    });
    // streamText fire-and-forget — error logged + onFailure called, not thrown.
    // For convertMessageToCard the error DOES propagate (no queue catch).
    await expect(c.convertMessageToCard('msg')).rejects.toThrow(/code=99992402/);
  });

  it('addElement onFailure callback fires when element fails to create', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ code: 99992402, msg: 'invalid element' }),
        { status: 200 },
      );
    const onFailure = vi.fn();
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
      log: () => {},
    });
    await c.addElement('card', { tag: 'div' }, {}, onFailure);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('dispose() drains queue + clears state (subsequent streamText starts fresh seq)', async () => {
    const { fetchImpl, calls } = makeCallRecorder(() => ({}));
    const c = createCardKitClient({
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeTokenStore(),
      fetchImpl,
    });
    await c.streamText('card', 'el', 'one');
    await c.streamText('card', 'el', 'two');
    await c.dispose('card');
    await c.streamText('card', 'el', 'three');
    // After dispose, state is fresh — new card record, seq starts at 1
    const writes = calls.filter((x) => x.path.endsWith('/content'));
    expect(writes.map((x) => x.body?.sequence)).toEqual([1, 2, 1]);
  });
});
