import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  CredentialStore,
  IMHandler,
  IncomingMessage,
} from '@multi-cc-im/shared';
import { createLarkAdapter, type LarkClientShape, type LarkWSClientShape } from './adapter.js';
import type { LarkCredentials } from './credentials.js';

const VALID_CREDS: LarkCredentials = {
  appId: 'cli_test',
  appSecret: 'secret_test',
  savedAt: '2026-05-09T12:00:00.000Z',
};

function makeStore(creds: LarkCredentials | null): CredentialStore<LarkCredentials> {
  return {
    load: async () => creds,
    save: async () => {},
    delete: async () => {},
  };
}

function makeHandler(): IMHandler & { received: IncomingMessage[]; errors: Error[] } {
  const received: IncomingMessage[] = [];
  const errors: Error[] = [];
  return {
    received,
    errors,
    async onMessage(msg) {
      received.push(msg);
    },
    async onError(err) {
      errors.push(err);
    },
  };
}

interface CapturedDispatcher {
  handlers: Record<string, (data: unknown) => Promise<void> | void>;
  fire(eventName: string, data: unknown): Promise<void>;
}

function makeStubDispatcher(): lark.EventDispatcher & CapturedDispatcher {
  const handlers: Record<string, (data: unknown) => Promise<void> | void> = {};
  const stub = {
    handlers,
    register(handles: Record<string, (data: unknown) => Promise<void> | void>) {
      Object.assign(handlers, handles);
      return stub;
    },
    async fire(eventName: string, data: unknown) {
      const fn = handlers[eventName];
      if (!fn) return;
      await fn(data);
    },
  };
  // Adapter only calls `.register()` on the dispatcher (verified by the
  // contract test below) — every other EventDispatcher method is unused.
  // Cast through `unknown` to silence the strict-mode "private method
  // missing" complaint without disabling it for real code.
  return stub as unknown as lark.EventDispatcher & CapturedDispatcher;
}

const baseInboundEvent = {
  event_id: 'evt-1',
  create_time: '1715250000000',
  event_type: 'im.message.receive_v1',
  sender: {
    sender_id: { open_id: 'ou_user', user_id: 'u1', union_id: 'on_xxx' },
    sender_type: 'user',
  },
  message: {
    message_id: 'om_msg_1',
    create_time: '1715250000000',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: 'hello bot' }),
  },
};

describe('createLarkAdapter', () => {
  describe('start()', () => {
    it('loads credentials → builds Client + WSClient → registers handler → calls WSClient.start', async () => {
      const dispatcher = makeStubDispatcher();
      // Capture the callbacks the adapter passes to buildWSClient so the
      // stub `start` can trigger onReady — adapter.start() now awaits
      // onReady so the SDK's start() resolution alone won't unblock it.
      let cbs!: { onReady: () => void; onError: (err: Error) => void; onReconnecting: () => void; onReconnected: () => void };
      const wsStart = vi.fn(async () => {
        cbs.onReady();
      });
      const wsClose = vi.fn(() => {});
      const wsClient: LarkWSClientShape = { start: wsStart, close: wsClose };
      const client: LarkClientShape = {
        im: {
          v1: { message: { create: vi.fn(async () => ({ code: 0 })) } },
        },
      };

      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => client,
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          return wsClient;
        },
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());

      expect(wsStart).toHaveBeenCalledOnce();
      expect(wsStart).toHaveBeenCalledWith({ eventDispatcher: dispatcher });
      expect(dispatcher.handlers['im.message.receive_v1']).toBeTypeOf('function');
    });

    it('throws when no credentials persisted (user must run `login lark` first)', async () => {
      const adapter = createLarkAdapter({
        credentialStore: makeStore(null),
      });
      await expect(adapter.start(makeHandler())).rejects.toThrow(/login lark/);
    });

    it('throws on double-start', async () => {
      const dispatcher = makeStubDispatcher();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await expect(adapter.start(makeHandler())).rejects.toThrow(/already started/);
    });
  });

  describe('inbound im.message.receive_v1', () => {
    async function setupAndFire(eventOverride: Partial<typeof baseInboundEvent['message']> = {}) {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: { ...baseInboundEvent.message, ...eventOverride },
      });
      return { handler, adapter };
    }

    it('text message → IncomingMessage with text + replyCtx (lark variant) + correct chatId/openId/messageId', async () => {
      const { handler } = await setupAndFire();
      expect(handler.received).toHaveLength(1);
      const msg = handler.received[0]!;
      expect(msg.msgId).toBe('om_msg_1');
      expect(msg.from).toBe('ou_user');
      expect(msg.text).toBe('hello bot');
      expect(msg.attachments).toEqual([]);
      expect(msg.replyCtx).toEqual({
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
        messageId: 'om_msg_1',
      });
    });

    it('non-text message_type drops silently (v1 MVP text only — DD §8.4)', async () => {
      const { handler } = await setupAndFire({ message_type: 'image' });
      expect(handler.received).toHaveLength(0);
    });

    it('audio message → echoes keyboard-mic hint via client.im.v1.message.create + does NOT route (DD 2026-05-12 §5)', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const createCalls: unknown[] = [];
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: {
            v1: {
              message: {
                create: vi.fn(async (payload: unknown) => {
                  createCalls.push(payload);
                  return { code: 0 };
                }),
              },
            },
          },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: {
          ...baseInboundEvent.message,
          message_type: 'audio',
          content: JSON.stringify({
            file_key: '75235e0c-4f92-430a-a99b-8446610223cg',
            duration: 2000,
          }),
        },
      });

      // Did NOT route — bridge stays text-only per DD D1-1.
      expect(handler.received).toHaveLength(0);

      // DID send a friendly echo back to the user's chat.
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat',
          msg_type: 'text',
        },
      });
      const content = JSON.parse(
        (createCalls[0] as { data: { content: string } }).data.content,
      ) as { text: string };
      expect(content.text).toContain('音频消息');
      expect(content.text).toMatch(/键盘|🎤/);
    });

    it('audio message echo failure does NOT propagate — silent log, daemon stays alive', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const logs: string[] = [];
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: {
            v1: {
              message: {
                create: vi.fn(async () => {
                  throw new Error('Lark API down');
                }),
              },
            },
          },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
        log: (l) => logs.push(l),
      });
      await adapter.start(handler);
      await expect(
        dispatcher.fire('im.message.receive_v1', {
          ...baseInboundEvent,
          message: {
            ...baseInboundEvent.message,
            message_type: 'audio',
            content: JSON.stringify({ file_key: 'fk', duration: 1000 }),
          },
        }),
      ).resolves.toBeUndefined();
      expect(handler.received).toHaveLength(0);
      expect(
        logs.some((l) => l.startsWith('[lark] failed to echo audio-unsupported')),
      ).toBe(true);
    });

    it('event without sender.sender_id.open_id drops silently', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        sender: { sender_type: 'user' },
      });
      expect(handler.received).toHaveLength(0);
    });

    it('malformed content JSON drops silently', async () => {
      const { handler } = await setupAndFire({ content: 'not json' });
      expect(handler.received).toHaveLength(0);
    });

    it('content JSON without .text string drops silently', async () => {
      const { handler } = await setupAndFire({
        content: JSON.stringify({ image_key: 'img_xxx' }),
      });
      expect(handler.received).toHaveLength(0);
    });

    it('handler.onMessage throws → adapter calls handler.onError, does NOT propagate', async () => {
      const dispatcher = makeStubDispatcher();
      const onErrorCalls: Error[] = [];
      const handler: IMHandler = {
        async onMessage() {
          throw new Error('downstream router exploded');
        },
        async onError(err) {
          onErrorCalls.push(err);
        },
      };
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);

      // Should not throw — adapter swallows + reports.
      await expect(
        dispatcher.fire('im.message.receive_v1', baseInboundEvent),
      ).resolves.toBeUndefined();
      expect(onErrorCalls).toHaveLength(1);
      expect(onErrorCalls[0]?.message).toBe('downstream router exploded');
    });
  });

  // ============================================================================
  // Inbound msgId dedup — Feishu WS event delivery is at-least-once; the
  // SDK / server may redeliver after a reconnect or ack-loss, and without
  // dedup the bridge dispatches the same IM message multiple times. Per
  // user smoke 2026-05-11.
  // ============================================================================

  describe('inbound msgId dedup', () => {
    it('duplicate message_id → second fire silently dropped (no handler.onMessage, no console noise)', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const logs: string[] = [];
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        log: (line) => logs.push(line),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);

      // First fire processes normally.
      await dispatcher.fire('im.message.receive_v1', baseInboundEvent);
      // Second fire with same message_id is the redelivery scenario.
      await dispatcher.fire('im.message.receive_v1', baseInboundEvent);

      expect(handler.received).toHaveLength(1);
      // Silent dedup — SDK redelivery is normal protocol behavior, not
      // worth surfacing in daemon stderr. Per user feedback 2026-05-11.
      expect(
        logs.some((l) => /dropping duplicate/.test(l)),
      ).toBe(false);
    });

    it('different message_id → each is processed independently (no false-positive dedup)', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);

      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: { ...baseInboundEvent.message, message_id: 'om_msg_A' },
      });
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: { ...baseInboundEvent.message, message_id: 'om_msg_B' },
      });

      expect(handler.received).toHaveLength(2);
      expect(handler.received[0]?.msgId).toBe('om_msg_A');
      expect(handler.received[1]?.msgId).toBe('om_msg_B');
    });

    it('LRU evicts oldest after exceeding cap so very old redeliveries are still possible', async () => {
      // Guards against unbounded memory growth: after the cap is breached,
      // the oldest msgId is forgotten, and a redelivery of THAT specific
      // ancient message would be processed again. This is fine — Feishu
      // doesn't redeliver after hours, only seconds after a reconnect.
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(handler);

      // Fire SEEN_MSGID_MAX + 1 unique msgs to push the first one out.
      // SEEN_MSGID_MAX is 200 (constant in adapter.ts); we don't import it
      // here to avoid coupling — pick 201 fires.
      for (let i = 0; i < 201; i++) {
        await dispatcher.fire('im.message.receive_v1', {
          ...baseInboundEvent,
          message: { ...baseInboundEvent.message, message_id: `om_lru_${i}` },
        });
      }
      expect(handler.received).toHaveLength(201);
      // Now re-fire the very first one — it was evicted, so it's processed
      // again (not deduped).
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: { ...baseInboundEvent.message, message_id: 'om_lru_0' },
      });
      expect(handler.received).toHaveLength(202);
      // But the LATEST messages should still dedup correctly.
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: { ...baseInboundEvent.message, message_id: 'om_lru_200' },
      });
      expect(handler.received).toHaveLength(202);
    });
  });

  describe('send()', () => {
    it('calls client.im.v1.message.create with correct shape (chat_id + text msg_type + JSON-wrapped content)', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 0 }));
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await adapter.send('hello user', {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });
      expect(create).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_chat',
          msg_type: 'text',
          content: JSON.stringify({ text: 'hello user' }),
        },
      });
    });

    it('markdown stripping: bold / heading / fenced code in cc reply are simplified before send', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());

      const ccReply =
        '# 完成\n\n修了 `router.ts` 的 **bold echo**。\n\n```ts\nconst x = 1;\n```';
      await adapter.send(ccReply, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });

      // Inspect what the SDK actually got: the inner `text` should be
      // the stripped version, not the raw markdown.
      const sent = create.mock.calls[0]![0];
      const sentText = JSON.parse(sent.data.content) as { text: string };
      expect(sentText.text).toContain('▌ 完成');
      expect(sentText.text).toContain('「router.ts」');
      expect(sentText.text).toContain('bold echo');
      expect(sentText.text).not.toContain('**');
      expect(sentText.text).toContain('[ts]');
      expect(sentText.text).toContain('const x = 1;');
      expect(sentText.text).not.toContain('```');
    });

    it('throws on Lark non-zero code (surfaces code + msg)', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 230020, msg: 'permission denied' }));
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({ im: { v1: { message: { create } } } }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await expect(
        adapter.send('hello', {
          imType: 'lark',
          openId: 'ou_user',
          chatId: 'oc_chat',
        }),
      ).rejects.toThrow(/code=230020/);
    });

    it('throws when called before start()', async () => {
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
      });
      await expect(
        adapter.send('hello', {
          imType: 'lark',
          openId: 'ou_user',
          chatId: 'oc_chat',
        }),
      ).rejects.toThrow(/before start/);
    });

    it('throws when given a non-lark replyCtx (defends against bridge mis-route)', async () => {
      const dispatcher = makeStubDispatcher();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await expect(
        adapter.send('hello', {
          imType: 'telegram',
          chatId: 12345,
          messageId: 678,
        }),
      ).rejects.toThrow(/non-lark replyCtx/);
    });
  });

  describe('stop()', () => {
    it('calls WSClient.close + ignores the close error from the SDK', async () => {
      const dispatcher = makeStubDispatcher();
      const wsClose = vi.fn(() => {
        throw new Error('connection already gone');
      });
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: wsClose,
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(wsClose).toHaveBeenCalledOnce();
    });

    it('idempotent — stop after stop is no-op', async () => {
      const dispatcher = makeStubDispatcher();
      const wsClose = vi.fn(() => {});
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: wsClose,
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      await adapter.stop();
      await adapter.stop();
      expect(wsClose).toHaveBeenCalledOnce();
    });
  });

  describe('name', () => {
    it('exposes "lark" as adapter identifier', () => {
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
      });
      expect(adapter.name).toBe('lark');
    });
  });

  // ============================================================================
  // Cold-start race fix — adapter.start() now awaits onReady before
  // resolving so callers (orchestrator + start.ts) can trust that
  // "started" means "bridge is actually ready for inbound IM messages".
  // Per user smoke 2026-05-11 (first `/start` sent during the SDK's
  // initial WS handshake was lost; user had to re-send).
  // ============================================================================

  describe('start() — WS readiness gating', () => {
    it('does NOT resolve until onReady fires (cold-start race fix)', async () => {
      const dispatcher = makeStubDispatcher();
      let cbs!: { onReady: () => void; onError: (err: Error) => void; onReconnecting: () => void; onReconnected: () => void };
      // wsClient.start() resolves synchronously but does NOT trigger
      // onReady — simulates the SDK kicking off the WS handshake but
      // the actual connect taking longer.
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          return { start: async () => {}, close: () => {} };
        },
        buildDispatcher: () => dispatcher,
      });

      let resolved = false;
      const startPromise = adapter.start(makeHandler()).then(() => {
        resolved = true;
      });

      // Yield a few microtask ticks — SDK's start() has resolved, but
      // onReady hasn't fired yet. adapter.start() must still be pending.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(resolved).toBe(false);

      // Now fire onReady — adapter.start() should resolve.
      cbs.onReady();
      await startPromise;
      expect(resolved).toBe(true);
    });

    it('logs `[lark] connecting to Feishu WS...` at start so the user sees the wait state', async () => {
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        log: (line) => logs.push(line),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: async () => {
            cbs.onReady();
          },
          close: () => {},
        }),
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      expect(logs).toContain('[lark] connecting to Feishu WS...');
      expect(logs).toContain('[lark] WS connected');
      // Ordering: connecting log fires before connected log.
      const connectingIdx = logs.indexOf('[lark] connecting to Feishu WS...');
      const connectedIdx = logs.indexOf('[lark] WS connected');
      expect(connectingIdx).toBeLessThan(connectedIdx);
    });

    it('onReconnecting callback emits a user-readable log explaining the wait', async () => {
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      let cbs!: { onReady: () => void; onError: (err: Error) => void; onReconnecting: () => void; onReconnected: () => void };
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        log: (line) => logs.push(line),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          return {
            start: async () => {
              cbs.onReady();
            },
            close: () => {},
          };
        },
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());

      // Simulate the SDK losing the WS and starting to reconnect.
      cbs.onReconnecting();
      cbs.onReconnected();

      const joined = logs.join('\n');
      expect(joined).toMatch(
        /\[lark\] WS reconnecting \(Feishu network glitch, SDK retrying\)/,
      );
      expect(joined).toContain('[lark] WS reconnected — bridge ready');
    });
  });
});
