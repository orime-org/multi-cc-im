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
  handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>;
  fire(eventName: string, data: unknown): Promise<void>;
  invoke(eventName: string, data: unknown): Promise<unknown>;
}

function makeStubDispatcher(): lark.EventDispatcher & CapturedDispatcher {
  const handlers: Record<string, (data: unknown) => Promise<unknown> | unknown> = {};
  const stub = {
    handlers,
    register(handles: Record<string, (data: unknown) => Promise<unknown> | unknown>) {
      Object.assign(handlers, handles);
      return stub;
    },
    async fire(eventName: string, data: unknown) {
      const fn = handlers[eventName];
      if (!fn) return;
      await fn(data);
    },
    // Same as `fire` but returns the handler's return value — used by
    // `card.action.trigger` tests where the response is the toast shape
    // that Feishu surfaces back to the user.
    async invoke(eventName: string, data: unknown): Promise<unknown> {
      const fn = handlers[eventName];
      if (!fn) return undefined;
      return await fn(data);
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

  describe('WS close-detector (zombie recovery)', () => {
    /**
     * Per [DD 2026-05-21 ws-zombie-detection]: adapter must attach a close
     * listener on the SDK's underlying ws so socket-half-open / sleep-wake
     * disconnects trigger our retry loop (SDK swallows close events
     * silently when autoReconnect:false). Tests below lock in:
     *
     *  1. SDK shape `wsClient.wsConfig.getWSInstance()` returning a node-
     *     style EventEmitter with `on('close', ...)`. If a future SDK
     *     release changes this shape, the first test goes red so we know
     *     to re-validate before publishing.
     *  2. Defensive fallback: if the shape disappears, adapter logs but
     *     does not crash and start() still resolves.
     */

    it('attaches a close listener that triggers retry on disconnect (Lark SDK ≥ 1.63.1 shape)', async () => {
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      let closeHandler: (() => void) | undefined;
      const wsInstanceMock = {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') closeHandler = cb;
        }),
      };
      let cbs!: { onReady: () => void; onError: (err: Error) => void };
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          const ws: LarkWSClientShape & {
            wsConfig: { getWSInstance: () => typeof wsInstanceMock };
          } = {
            start: vi.fn(async () => {
              cbs.onReady();
            }),
            close: vi.fn(() => {}),
            wsConfig: { getWSInstance: () => wsInstanceMock },
          };
          return ws;
        },
        buildDispatcher: () => dispatcher,
        retryIntervalMs: 5,
        cooldownMs: 5,
        log: (l) => logs.push(l),
      });
      await adapter.start(makeHandler());

      // After successful connect, adapter should have attached close listener.
      expect(wsInstanceMock.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(closeHandler).toBeTypeOf('function');

      // Fire close — adapter should log + start retrying.
      closeHandler!();
      expect(logs.some((l) => l.includes('WS close detected'))).toBe(true);
    });

    it('does not crash when SDK shape changes (wsConfig / getWSInstance missing)', async () => {
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, cbs) => ({
          start: vi.fn(async () => {
            cbs.onReady();
          }),
          close: vi.fn(() => {}),
          // No wsConfig — simulates future SDK release with renamed/private field.
        }),
        buildDispatcher: () => dispatcher,
        retryIntervalMs: 5,
        cooldownMs: 5,
        log: (l) => logs.push(l),
      });
      await expect(adapter.start(makeHandler())).resolves.toBeUndefined();
      expect(logs.some((l) => l.includes('close-detector NOT attached'))).toBe(true);
    });

    it('close fired after stop() is a no-op (stopRequested guard prevents stale retry)', async () => {
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      let closeHandler: (() => void) | undefined;
      const wsInstanceMock = {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') closeHandler = cb;
        }),
      };
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          const ws: LarkWSClientShape & {
            wsConfig: { getWSInstance: () => typeof wsInstanceMock };
          } = {
            start: vi.fn(async () => {
              captured.onReady();
            }),
            close: vi.fn(() => {}),
            wsConfig: { getWSInstance: () => wsInstanceMock },
          };
          return ws;
        },
        buildDispatcher: () => dispatcher,
        retryIntervalMs: 5,
        cooldownMs: 5,
        log: (l) => logs.push(l),
      });
      await adapter.start(makeHandler());
      await adapter.stop();
      logs.length = 0;
      closeHandler!();
      expect(logs.some((l) => l.includes('WS close detected'))).toBe(false);
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

    it('image message_type without tenantTokenStore wired → degraded drop (no crash, no emit)', async () => {
      // setupAndFire wires no tenantTokenStore / inboundImagesDir, so the
      // adapter takes the graceful-degrade branch — log + drop, not throw.
      const { handler } = await setupAndFire({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_x' }),
      });
      expect(handler.received).toHaveLength(0);
    });

    it('sticker / file message_type still drops silently (v1 MVP text + image only)', async () => {
      const { handler: h1 } = await setupAndFire({ message_type: 'sticker' });
      expect(h1.received).toHaveLength(0);
      const { handler: h2 } = await setupAndFire({ message_type: 'file' });
      expect(h2.received).toHaveLength(0);
    });

    it('image message with tenantTokenStore + inboundImagesDir wired → downloads, emits IncomingMessage with image attachment + replyToMessageId', async () => {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const downloadCalls: Array<{
        messageId: string;
        fileKey: string;
        type: string;
      }> = [];
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
        tenantTokenStore: { async getToken() { return 't'; }, clear() {} },
        inboundImagesDir: '/tmp/inbox/lark/images',
        downloadAttachmentImpl: async (messageId, fileKey, type) => {
          downloadCalls.push({ messageId, fileKey, type });
          return {
            localPath: `/tmp/inbox/lark/images/${messageId}-cat.png`,
            bytes: 4,
            mimetype: 'image/png',
          };
        },
      });
      await adapter.start(handler);
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: {
          ...baseInboundEvent.message,
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_v3_abc' }),
          parent_id: 'om_parent_99',
        },
      });
      expect(downloadCalls).toEqual([
        { messageId: 'om_msg_1', fileKey: 'img_v3_abc', type: 'image' },
      ]);
      expect(handler.received).toHaveLength(1);
      const m = handler.received[0]!;
      expect(m.text).toBeNull();
      expect(m.attachments).toEqual([
        {
          kind: 'image',
          localPath: '/tmp/inbox/lark/images/om_msg_1-cat.png',
          mimetype: 'image/png',
        },
      ]);
      expect(m.replyToMessageId).toBe('om_parent_99');
    });

    it('image with no parent_id → replyToMessageId is undefined (image-only first send)', async () => {
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
        tenantTokenStore: { async getToken() { return 't'; }, clear() {} },
        inboundImagesDir: '/tmp/inbox/lark/images',
        downloadAttachmentImpl: async (messageId) => ({
          localPath: `/tmp/inbox/lark/images/${messageId}.png`,
          bytes: 1,
        }),
      });
      await adapter.start(handler);
      await dispatcher.fire('im.message.receive_v1', {
        ...baseInboundEvent,
        message: {
          ...baseInboundEvent.message,
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_v3_x' }),
        },
      });
      expect(handler.received[0]!.replyToMessageId).toBeUndefined();
    });

    it('image download throws → drops without crashing the WS event loop', async () => {
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
        tenantTokenStore: { async getToken() { return 't'; }, clear() {} },
        inboundImagesDir: '/tmp/inbox/lark/images',
        downloadAttachmentImpl: async () => {
          throw new Error('HTTP 403');
        },
      });
      await adapter.start(handler);
      await expect(
        dispatcher.fire('im.message.receive_v1', {
          ...baseInboundEvent,
          message: {
            ...baseInboundEvent.message,
            message_type: 'image',
            content: JSON.stringify({ image_key: 'img_v3_x' }),
          },
        }),
      ).resolves.toBeUndefined();
      expect(handler.received).toHaveLength(0);
    });

    it('text message with parent_id → replyToMessageId carries through (reply-thread routing source)', async () => {
      const { handler } = await setupAndFire({
        content: JSON.stringify({ text: '#frontend 看这图' }),
        parent_id: 'om_parent_image',
      } as unknown as Partial<typeof baseInboundEvent['message']>);
      expect(handler.received).toHaveLength(1);
      expect(handler.received[0]!.replyToMessageId).toBe('om_parent_image');
      expect(handler.received[0]!.text).toBe('#frontend 看这图');
    });

    // ----- quotedMessage on-demand fetch (text reply quoted context) -----
    // Nested under `inbound im.message.receive_v1` so setupAndFire stays in
    // scope; each test below crafts its own buildClient when it needs to
    // assert message.get behaviour, but lighter-weight stubs reuse the
    // outer setupAndFire when only the no-parent path matters.
    async function setupWithGet(
      messageOverride: Partial<typeof baseInboundEvent['message']>,
      getImpl: NonNullable<
        Parameters<typeof createLarkAdapter>[0]['buildClient']
      > extends (creds: infer _C) => infer R
        ? R extends { im: { v1: { message: infer M } } }
          ? M extends { get?: infer G }
            ? G
            : never
          : never
        : never,
    ): Promise<{
      handler: ReturnType<typeof makeHandler>;
      getCalls: string[];
    }> {
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const getCalls: string[] = [];
      const wrappedGet = async (payload: { path: { message_id: string } }) => {
        getCalls.push(payload.path.message_id);
        return (getImpl as (p: unknown) => Promise<unknown>)(payload) as ReturnType<
          NonNullable<LarkClientShape['im']['v1']['message']['get']>
        >;
      };
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: {
            v1: {
              message: {
                create: vi.fn(async () => ({ code: 0 })),
                get: wrappedGet as NonNullable<
                  LarkClientShape['im']['v1']['message']['get']
                >,
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
        message: { ...baseInboundEvent.message, ...messageOverride },
      });
      return { handler, getCalls };
    }

    it('text reply with parent + successful message.get → quotedMessage populated with parent text body + sender role=user', async () => {
      const { handler, getCalls } = await setupWithGet(
        {
          content: JSON.stringify({ text: '帮我看看' }),
          parent_id: 'om_parent_abc',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => ({
          code: 0,
          data: {
            items: [
              {
                message_id: 'om_parent_abc',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: '前端那个 PR 怎么样了？' }) },
                sender: { id: 'ou_other', sender_type: 'user' },
              },
            ],
          },
        })) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(getCalls).toEqual(['om_parent_abc']);
      expect(handler.received).toHaveLength(1);
      const msg = handler.received[0]!;
      expect(msg.replyToMessageId).toBe('om_parent_abc');
      expect(msg.quotedMessage).toEqual({
        content: '前端那个 PR 怎么样了？',
        sender: { id: 'ou_other', role: 'user' },
      });
    });

    it('text reply with parent → sender_type=app maps to role=bot (cc Stop reply scenario)', async () => {
      const { handler } = await setupWithGet(
        {
          content: JSON.stringify({ text: '继续' }),
          parent_id: 'om_parent_cc',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => ({
          code: 0,
          data: {
            items: [
              {
                msg_type: 'text',
                body: { content: JSON.stringify({ text: 'cc done.' }) },
                sender: { id: 'ou_bot', sender_type: 'app' },
              },
            ],
          },
        })) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(handler.received[0]!.quotedMessage).toEqual({
        content: 'cc done.',
        sender: { id: 'ou_bot', role: 'bot' },
      });
    });

    it('text reply with parent of non-text msg_type → quotedMessage.content is [msg_type] placeholder', async () => {
      const { handler } = await setupWithGet(
        {
          content: JSON.stringify({ text: '关于这张图' }),
          parent_id: 'om_parent_img',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => ({
          code: 0,
          data: {
            items: [
              {
                msg_type: 'image',
                body: { content: JSON.stringify({ image_key: 'img_v3' }) },
                sender: { id: 'ou_other', sender_type: 'user' },
              },
            ],
          },
        })) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(handler.received[0]!.quotedMessage).toEqual({
        content: '[image]',
        sender: { id: 'ou_other', role: 'user' },
      });
    });

    it('text reply with parent → message.get returns deleted item → quotedMessage undefined', async () => {
      const { handler } = await setupWithGet(
        {
          content: JSON.stringify({ text: '?' }),
          parent_id: 'om_parent_del',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => ({
          code: 0,
          data: {
            items: [
              {
                msg_type: 'text',
                deleted: true,
                body: { content: JSON.stringify({ text: 'was here' }) },
                sender: { id: 'ou_other', sender_type: 'user' },
              },
            ],
          },
        })) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(handler.received[0]!.replyToMessageId).toBe('om_parent_del');
      expect(handler.received[0]!.quotedMessage).toBeUndefined();
    });

    it('text reply with parent → message.get returns non-zero Feishu code (230110 deleted) → quotedMessage undefined + no throw', async () => {
      const { handler } = await setupWithGet(
        {
          content: JSON.stringify({ text: '?' }),
          parent_id: 'om_parent_gone',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => ({
          code: 230110,
          msg: 'Action unavailable as the message has been deleted',
        })) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(handler.received).toHaveLength(1);
      expect(handler.received[0]!.quotedMessage).toBeUndefined();
    });

    it('text reply with parent → message.get throws (network) → quotedMessage undefined + adapter still emits', async () => {
      const { handler } = await setupWithGet(
        {
          content: JSON.stringify({ text: '?' }),
          parent_id: 'om_parent_net',
        } as unknown as Partial<typeof baseInboundEvent['message']>,
        (async () => {
          throw new Error('ECONNRESET');
        }) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
      );
      expect(handler.received).toHaveLength(1);
      expect(handler.received[0]!.quotedMessage).toBeUndefined();
    });

    it('text message WITHOUT parent_id → no message.get call + quotedMessage undefined', async () => {
      const getCalls: string[] = [];
      const dispatcher = makeStubDispatcher();
      const handler = makeHandler();
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        buildClient: () => ({
          im: {
            v1: {
              message: {
                create: vi.fn(async () => ({ code: 0 })),
                get: vi.fn(async (p: { path: { message_id: string } }) => {
                  getCalls.push(p.path.message_id);
                  return { code: 0 };
                }) as NonNullable<LarkClientShape['im']['v1']['message']['get']>,
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
      await dispatcher.fire('im.message.receive_v1', baseInboundEvent);
      expect(getCalls).toEqual([]);
      expect(handler.received).toHaveLength(1);
      expect(handler.received[0]!.quotedMessage).toBeUndefined();
    });

    it('client lacks message.get (legacy stub) → reply still emits, quotedMessage undefined (no crash)', async () => {
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
        message: {
          ...baseInboundEvent.message,
          content: JSON.stringify({ text: '?' }),
          parent_id: 'om_parent_xyz',
        } as unknown as typeof baseInboundEvent['message'],
      });
      expect(handler.received).toHaveLength(1);
      expect(handler.received[0]!.quotedMessage).toBeUndefined();
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

    // β.MVP P3 (2026-05-18): cc reply containing a markdown table → adapter
    // routes through `mdToCard` and sends as `msg_type: 'interactive'`
    // (schema-2.0 card JSON) so the table renders with native column_set
    // rows on mobile instead of `|...|---|` character garbage.
    it('card path: cc reply containing md table → msg_type=interactive + card JSON content', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      const replyWithTable = [
        '改完了，结果：',
        '',
        '| 文件 | 状态 |',
        '|---|---|',
        '| router.ts | ✅ |',
        '| adapter.ts | ✅ |',
      ].join('\n');
      await adapter.send(replyWithTable, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });

      const sent = create.mock.calls[0]![0];
      expect(sent.data.msg_type).toBe('interactive');
      expect(sent.data.receive_id).toBe('oc_chat');
      const parsed = JSON.parse(sent.data.content) as {
        schema: string;
        body: { elements: Array<{ tag: string }> };
      };
      expect(parsed.schema).toBe('2.0');
      const tags = parsed.body.elements.map((e) => e.tag);
      // markdown(intro) + column_set(header) + 2 × column_set(rows)
      expect(tags).toEqual(['markdown', 'column_set', 'column_set', 'column_set']);
    });

    it('text path preserved: cc reply WITHOUT table still goes msg_type=text + stripMarkdown', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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
      await adapter.send('just a paragraph, no tables here', {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });
      const sent = create.mock.calls[0]![0];
      expect(sent.data.msg_type).toBe('text');
      expect(JSON.parse(sent.data.content)).toEqual({
        text: 'just a paragraph, no tables here',
      });
    });

    // 2026-05-19 — Feishu rejects cards with > 3 md tables (code 230099
    // ErrCode 11310 card table number over limit; verified via
    // larksuite/openclaw-lark source). The adapter splits the reply
    // into N consecutive IM messages, each ≤ 3 tables, each prefixed
    // with a `**[X/Y]**` section marker.
    it('table-limit split: 5-table cc reply → 2 IM messages (3 + 2) with section markers', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      const fiveTables = [
        'lead intro',
        '',
        '| t1 | v1 |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '| t2 | v2 |',
        '|---|---|',
        '| 3 | 4 |',
        '',
        '| t3 | v3 |',
        '|---|---|',
        '| 5 | 6 |',
        '',
        '| t4 | v4 |',
        '|---|---|',
        '| 7 | 8 |',
        '',
        '| t5 | v5 |',
        '|---|---|',
        '| 9 | 0 |',
        '',
        'closing line',
      ].join('\n');
      await adapter.send(fiveTables, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });

      expect(create).toHaveBeenCalledTimes(2);
      const first = create.mock.calls[0]![0];
      const second = create.mock.calls[1]![0];
      expect(first.data.msg_type).toBe('interactive');
      expect(second.data.msg_type).toBe('interactive');

      const firstCard = JSON.parse(first.data.content) as {
        schema: string;
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      const secondCard = JSON.parse(second.data.content) as {
        schema: string;
        body: { elements: Array<{ tag: string; content?: string }> };
      };

      const firstFirstEl = firstCard.body.elements[0]!;
      const secondFirstEl = secondCard.body.elements[0]!;
      expect(firstFirstEl.tag).toBe('markdown');
      expect(secondFirstEl.tag).toBe('markdown');
      expect(firstFirstEl.content).toContain('**[1/2]**');
      expect(secondFirstEl.content).toContain('**[2/2]**');

      const firstTables = firstCard.body.elements.filter((e) => e.tag === 'column_set').length;
      const secondTables = secondCard.body.elements.filter((e) => e.tag === 'column_set').length;
      expect(firstTables).toBeGreaterThanOrEqual(6);
      expect(secondTables).toBeGreaterThanOrEqual(4);
    });

    it('serial send order: messages arrive in chunk order (await each)', async () => {
      const dispatcher = makeStubDispatcher();
      const sendOrder: string[] = [];
      const create = vi.fn(
        async (opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => {
          const card = JSON.parse(opts.data.content) as {
            body: { elements: Array<{ tag: string; content?: string }> };
          };
          const markerEl = card.body.elements[0];
          if (markerEl?.tag === 'markdown' && markerEl.content) {
            const m = /\*\*\[(\d+)\/(\d+)\]\*\*/.exec(markerEl.content);
            if (m) sendOrder.push(`${m[1]}/${m[2]}`);
          }
          await new Promise((r) => setTimeout(r, 0));
          return { code: 0 };
        },
      );
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

      const md4 = ['| a | b |', '|---|---|', '| 1 | 2 |']
        .concat(['', '| c | d |', '|---|---|', '| 3 | 4 |'])
        .concat(['', '| e | f |', '|---|---|', '| 5 | 6 |'])
        .concat(['', '| g | h |', '|---|---|', '| 7 | 8 |'])
        .join('\n');
      await adapter.send(md4, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });

      expect(sendOrder).toEqual(['1/2', '2/2']);
    });

    it('single-chunk (≤ 3 tables) preserves PR #197 surface: NO section marker', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      const oneTable = ['intro', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
      await adapter.send(oneTable, {
        imType: 'lark',
        openId: 'ou_user',
        chatId: 'oc_chat',
      });

      expect(create).toHaveBeenCalledTimes(1);
      const sent = create.mock.calls[0]![0];
      const card = JSON.parse(sent.data.content) as {
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      // First element should be the `intro` paragraph, NOT a `**[1/1]**` marker.
      const firstEl = card.body.elements[0];
      expect(firstEl?.tag).toBe('markdown');
      expect(firstEl?.content).not.toContain('[1/1]');
      expect(firstEl?.content).toContain('intro');
    });

    // 2026-05-19 — sourceTag is carried as `opts.sourceTag` metadata, not
    // baked into `content`. The adapter prepends `**[<tag>] [X/Y]**\n\n`
    // on every chunk so the user knows both the producer and the section
    // (the old approach baked `[<tag>]` into chunk[0] only, leaving
    // chunk[1+] without source attribution — discovered in real-account
    // smoke when an operations cc tab's 4-table audit summary split into
    // 2 IM messages but only the first carried `[operations]`).
    it('sourceTag + multi-chunk: every chunk gets `[<tag>] [X/Y]` prefix', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      const fourTables = [
        'lead',
        '',
        '| t1 | v1 |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '| t2 | v2 |',
        '|---|---|',
        '| 3 | 4 |',
        '',
        '| t3 | v3 |',
        '|---|---|',
        '| 5 | 6 |',
        '',
        '| t4 | v4 |',
        '|---|---|',
        '| 7 | 8 |',
      ].join('\n');

      await adapter.send(
        fourTables,
        { imType: 'lark', openId: 'ou_user', chatId: 'oc_chat' },
        { sourceTag: 'operations' },
      );

      expect(create).toHaveBeenCalledTimes(2);
      const first = create.mock.calls[0]![0];
      const second = create.mock.calls[1]![0];
      const firstCard = JSON.parse(first.data.content) as {
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      const secondCard = JSON.parse(second.data.content) as {
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      // Both chunks must carry the source-tag + section marker.
      expect(firstCard.body.elements[0]?.content).toContain('**[operations] [1/2]**');
      expect(secondCard.body.elements[0]?.content).toContain('**[operations] [2/2]**');
    });

    it('sourceTag + single chunk: only `[<tag>]` prefix, no [1/1] section marker', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      const oneTable = ['intro', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
      await adapter.send(
        oneTable,
        { imType: 'lark', openId: 'ou_user', chatId: 'oc_chat' },
        { sourceTag: 'frontend' },
      );

      expect(create).toHaveBeenCalledTimes(1);
      const sent = create.mock.calls[0]![0];
      const card = JSON.parse(sent.data.content) as {
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      const firstEl = card.body.elements[0];
      expect(firstEl?.content).toContain('**[frontend]**');
      expect(firstEl?.content).not.toContain('[1/1]');
      // Original `intro` paragraph still present after the tag prefix.
      expect(firstEl?.content).toContain('intro');
    });

    // β.MVP P5 (2026-05-19): sendAUQ + card.action.trigger handler.
    // Verifies the IMAUQSender capability path — adapter renders a
    // button card per AUQRequest, zod-parses card click events, and
    // forwards them to handler.onCardAction.
    it('sendAUQ: builds card with interactive_container per option + sourceTag prefix', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(
        async (_opts: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => ({ code: 0 }),
      );
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

      await adapter.sendAUQ(
        {
          toolUseId: 'toolu_xyz',
          tabName: 'operations',
          questions: [
            {
              questionIdx: 0,
              text: 'Pick a database',
              options: [
                { label: 'Postgres', description: 'mature relational' },
                { label: 'MongoDB', description: 'doc store' },
              ],
            },
          ],
        },
        { imType: 'lark', openId: 'ou_user', chatId: 'oc_chat' },
        { sourceTag: 'operations' },
      );

      expect(create).toHaveBeenCalledTimes(1);
      const sent = create.mock.calls[0]![0];
      expect(sent.data.msg_type).toBe('interactive');
      const card = JSON.parse(sent.data.content) as {
        schema: string;
        body: {
          elements: Array<{
            tag: string;
            content?: string;
            behaviors?: Array<{ type: string; value: Record<string, unknown> }>;
          }>;
        };
      };
      expect(card.schema).toBe('2.0');
      // First element = sourceTag prefix markdown
      expect(card.body.elements[0]).toEqual({
        tag: 'markdown',
        content: '**[operations]**',
      });
      // Second element = question text markdown
      expect(card.body.elements[1]?.tag).toBe('markdown');
      expect(card.body.elements[1]?.content).toContain('Pick a database');
      // Then 2 interactive_container (one per option)
      const containers = card.body.elements.filter((e) => e.tag === 'interactive_container');
      expect(containers).toHaveLength(2);
      expect(containers[0]?.behaviors?.[0]?.value).toEqual({
        kind: 'auq',
        toolUseId: 'toolu_xyz',
        questionIdx: 0,
        optionIdx: 0,
      });
      expect(containers[1]?.behaviors?.[0]?.value).toEqual({
        kind: 'auq',
        toolUseId: 'toolu_xyz',
        questionIdx: 0,
        optionIdx: 1,
      });
    });

    it('card.action.trigger: zod-parses payload + forwards to handler.onCardAction with toast return', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 0 }));
      let receivedEvent: unknown = null;
      const handler = makeHandler();
      handler.onCardAction = async (event) => {
        receivedEvent = event;
        return { toast: { type: 'success' as const, content: '已回答' } };
      };
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
      await adapter.start(handler);

      // Simulate Lark SDK dispatching a `card.action.trigger` event.
      const fakeEvent = {
        action: {
          value: {
            kind: 'auq',
            toolUseId: 'toolu_abc',
            questionIdx: 0,
            optionIdx: 1,
          },
          tag: 'interactive_container',
        },
        context: { open_chat_id: 'oc_chat' },
        operator: { open_id: 'ou_user' },
      };
      const result = await dispatcher.invoke('card.action.trigger', fakeEvent);

      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as { action: { value: { optionIdx: number } } }).action.value.optionIdx).toBe(1);
      expect(result).toEqual({ toast: { type: 'success', content: '已回答' } });
    });

    it('card.action.trigger: malformed payload → log + empty return (no crash)', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 0 }));
      const handler = makeHandler();
      let handlerCalled = false;
      handler.onCardAction = async () => {
        handlerCalled = true;
        return {};
      };
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
      await adapter.start(handler);

      const result = await dispatcher.invoke('card.action.trigger', {
        action: { value: { kind: 'unknown', foo: 'bar' } },
      });

      expect(handlerCalled).toBe(false);
      expect(result).toEqual({});
    });

    // 2026-05-19 hotfix: post-Feishu-config-flip real-account smoke showed
    // the SDK delivering the FULL webhook envelope (`{schema, event_id,
    // event_type, event:{action,...}}`) to the WS handler, not the
    // unwrapped inner shape. `CardActionEventSchema` preprocesses to
    // detect the outer envelope and unwrap `event` to the inner shape.
    it('card.action.trigger: outer envelope is unwrapped and handler sees inner action', async () => {
      const dispatcher = makeStubDispatcher();
      const create = vi.fn(async () => ({ code: 0 }));
      let receivedToolUseId: string | null = null;
      const handler = makeHandler();
      handler.onCardAction = async (event) => {
        const v = event.action.value;
        if (v.kind === 'auq') receivedToolUseId = v.toolUseId;
        return { toast: { type: 'success' as const, content: 'ok' } };
      };
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
      await adapter.start(handler);

      // The Feishu webhook envelope shape — real-account 2026-05-19 evidence.
      const outerEnvelope = {
        schema: '2.0',
        event_id: 'f5db0ebed15a71cbbfcb18c92be48313',
        token: 'c-014f7222',
        create_time: '1779179594971499',
        event_type: 'card.action.trigger',
        tenant_key: '1539abc',
        event: {
          action: {
            value: {
              kind: 'auq',
              toolUseId: 'tu_envelope',
              questionIdx: 0,
              optionIdx: 1,
            },
            tag: 'interactive_container',
          },
          context: { open_chat_id: 'oc_chat' },
          operator: { open_id: 'ou_user' },
        },
      };
      const result = await dispatcher.invoke('card.action.trigger', outerEnvelope);

      expect(receivedToolUseId).toBe('tu_envelope');
      expect(result).toEqual({
        toast: { type: 'success', content: 'ok' },
      });
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
      // Connected line now reports attempt count for diagnosability —
      // match the prefix to stay tolerant of the attempt suffix.
      const connectedIdx = logs.findIndex((l) =>
        l.startsWith('[lark] WS connected'),
      );
      expect(connectedIdx).toBeGreaterThanOrEqual(0);
      // Ordering: connecting log fires before connected log.
      const connectingIdx = logs.indexOf('[lark] connecting to Feishu WS...');
      expect(connectingIdx).toBeLessThan(connectedIdx);
    });

    it('onError after successful connect triggers retry log + onReady fires "reconnected — bridge ready"', async () => {
      // The previous SDK-driven `onReconnecting` callback no longer fires
      // because we set `autoReconnect: false` and drive retries ourselves
      // (per user feedback 2026-05-14: SDK exp-backoff was too slow).
      // The reconnect path now uses onError → scheduled retry → onReady
      // fires the second time, logged as "WS reconnected — bridge ready".
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      let cbs!: {
        onReady: () => void;
        onError: (err: Error) => void;
        onReconnecting: () => void;
        onReconnected: () => void;
      };
      let startCount = 0;
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        log: (line) => logs.push(line),
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          startCount += 1;
          return {
            start: async () => {
              // First WSClient: fire onReady so adapter.start() resolves.
              // Subsequent WSClients (built when retry timer fires) also
              // fire onReady so the "reconnected" branch logs.
              cbs.onReady();
            },
            close: () => {},
          };
        },
        buildDispatcher: () => dispatcher,
      });
      await adapter.start(makeHandler());
      expect(startCount).toBe(1);

      // Simulate the WS dropping after connect. onError schedules a retry
      // (1s default — fake-timer through it by waiting).
      cbs.onError(new Error('socket closed'));
      // Wait for the 1s retry timer to fire + the new WSClient onReady.
      await new Promise((r) => setTimeout(r, 1100));

      const joined = logs.join('\n');
      // First-attempt successful connect line.
      expect(joined).toContain('[lark] WS connected');
      // Error reported with attempt count.
      expect(joined).toMatch(/\[lark\] WS error \(attempt 1\)/);
      // Retry kicked in.
      expect(joined).toMatch(/\[lark\] 连接中\.\.\. \(尝试 2\)/);
      // Re-ready branch surfaces the reconnected line.
      expect(joined).toContain('[lark] WS reconnected — bridge ready');

      await adapter.stop();
    });

    it('10 consecutive failures emit a cool-down log line, then loop continues', async () => {
      // Per user feedback 2026-05-14: SDK exponential backoff was
      // replaced with fixed 1s retry; every 10 consecutive failures the
      // loop sleeps 5s ("冷却 5s 后继续重试") and then resumes without
      // resetting attempt-counter. This test forces 10 failures and
      // verifies the cool-down banner fires.
      const dispatcher = makeStubDispatcher();
      const logs: string[] = [];
      let cbs!: {
        onReady: () => void;
        onError: (err: Error) => void;
        onReconnecting: () => void;
        onReconnected: () => void;
      };
      let startCount = 0;
      const adapter = createLarkAdapter({
        credentialStore: makeStore(VALID_CREDS),
        log: (line) => logs.push(line),
        // Fast timings for the test — production defaults to 1000ms /
        // 5000ms / 10 attempts.
        retryIntervalMs: 10,
        cooldownMs: 50,
        cooldownAfter: 10,
        buildClient: () => ({
          im: { v1: { message: { create: vi.fn(async () => ({ code: 0 })) } } },
        }),
        buildWSClient: (_creds, captured) => {
          cbs = captured;
          startCount += 1;
          return {
            start: async () => {
              if (startCount === 11) {
                // 11th invocation (after the cool-down branch) finally
                // succeeds, so adapter.start() can resolve.
                cbs.onReady();
              } else {
                // Use process.nextTick to give the test loop a chance to
                // observe the new WSClient before onError fires.
                process.nextTick(() => cbs.onError(new Error('connect refused')));
              }
            },
            close: () => {},
          };
        },
        buildDispatcher: () => dispatcher,
      });

      // 10 retries × 10ms + 1 cool-down × 50ms + 11th attempt ≈ 160ms.
      // Generous budget (500ms) for setTimeout drift.
      await adapter.start(makeHandler());
      await new Promise((r) => setTimeout(r, 100));

      const joined = logs.join('\n');
      // The 10th failure should be followed by the cool-down line —
      // attempt count uses `attempt + 1` semantics so "失败 10 次" is
      // expected when 10 consecutive errors fire.
      expect(joined).toMatch(/\[lark\] 连接失败 10 次，冷却 50ms 后继续重试/);
      // The loop must NOT abort — attempt 11 fires and connects.
      expect(joined).toContain('[lark] WS connected (after 11 attempt(s))');

      await adapter.stop();
    });
  });
});
