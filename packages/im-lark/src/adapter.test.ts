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
      const wsStart = vi.fn(async () => {});
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
        buildWSClient: () => wsClient,
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
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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

    it('event without sender.sender_id.open_id drops silently', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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

  describe('send()', () => {
    it('calls client.im.v1.message.create with correct shape (chat_id + text msg_type + JSON-wrapped content)', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 0 }));
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create } } },
        }),
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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

    it('throws on Lark non-zero code (surfaces code + msg)', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 230020, msg: 'permission denied' }));
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({ im: { v1: { message: { create } } } }),
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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
        buildWSClient: () => ({ start: async () => {}, close: () => {} }),
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
        buildWSClient: () => ({ start: async () => {}, close: wsClose }),
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
        buildWSClient: () => ({ start: async () => {}, close: wsClose }),
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
});
