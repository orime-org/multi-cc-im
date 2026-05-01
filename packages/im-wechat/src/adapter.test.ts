import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ConfigStore,
  CursorStore,
  IMHandler,
  IncomingMessage,
} from '@multi-cc-im/shared';
import type { WeixinMessage } from '../lib/ilink/api/types.js';

// Hoisted mocks — must be set up before module imports so the SUT picks them up.
const mockSendMessageWeixin = vi.hoisted(() => vi.fn());
const mockRunMonitor = vi.hoisted(() => vi.fn());

vi.mock('../lib/ilink/messaging/send.js', () => ({
  sendMessageWeixin: mockSendMessageWeixin,
}));

vi.mock('./monitor.js', () => ({
  runMonitor: mockRunMonitor,
}));

const { createWeixinAdapter } = await import('./adapter.js');

const stubConfigStore: ConfigStore = {
  load: async () => ({
    friendly_names: {},
    acl: { owners: [] },
    external_paths: {},
  }),
  save: async () => {},
};

function makeCursorStore(): CursorStore {
  return {
    get: async () => null,
    set: async () => {},
  };
}

function makeHandler(): IMHandler & {
  received: IncomingMessage[];
  errors: Error[];
} {
  const received: IncomingMessage[] = [];
  const errors: Error[] = [];
  return {
    received,
    errors,
    onMessage: async (m) => {
      received.push(m);
    },
    onError: async (e) => {
      errors.push(e);
    },
  };
}

beforeEach(() => {
  mockSendMessageWeixin.mockReset();
  mockRunMonitor.mockReset();
  mockRunMonitor.mockResolvedValue(undefined);
});

describe('createWeixinAdapter', () => {
  it('exposes name = "wechat"', () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    expect(adapter.name).toBe('wechat');
  });

  it('throws if start() is called twice', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    await adapter.start(makeHandler());
    await expect(adapter.start(makeHandler())).rejects.toThrow(
      /start\(\) called twice/,
    );
    await adapter.stop();
  });

  it('throws if send() is called before start()', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    await expect(
      adapter.send('hi', { to: 'u1', contextToken: undefined }),
    ).rejects.toThrow(/before start/);
  });

  it('forwards a TEXT WeixinMessage to handler.onMessage as IncomingMessage', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    const handler = makeHandler();
    let capturedOnMessage:
      | ((msg: WeixinMessage) => Promise<void>)
      | undefined;
    mockRunMonitor.mockImplementation(async (opts) => {
      capturedOnMessage = opts.onMessage;
    });
    await adapter.start(handler);
    expect(capturedOnMessage).toBeDefined();

    const raw: WeixinMessage = {
      message_id: 42,
      from_user_id: 'wxid_user',
      create_time_ms: 1700000000000,
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    };
    await capturedOnMessage!(raw);

    expect(handler.received).toHaveLength(1);
    expect(handler.received[0]).toEqual({
      msgId: '42',
      from: 'wxid_user',
      text: 'hello',
      attachments: [],
      timestamp: 1700000000000,
    });
    await adapter.stop();
  });

  it('skips non-business WeixinMessage (no from_user_id)', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    const handler = makeHandler();
    let capturedOnMessage:
      | ((msg: WeixinMessage) => Promise<void>)
      | undefined;
    mockRunMonitor.mockImplementation(async (opts) => {
      capturedOnMessage = opts.onMessage;
    });
    await adapter.start(handler);

    await capturedOnMessage!({ message_id: 1 } as WeixinMessage); // no from_user_id

    expect(handler.received).toHaveLength(0);
    await adapter.stop();
  });

  it('joins multiple text items into a single text payload', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    const handler = makeHandler();
    let captured:
      | ((msg: WeixinMessage) => Promise<void>)
      | undefined;
    mockRunMonitor.mockImplementation(async (opts) => {
      captured = opts.onMessage;
    });
    await adapter.start(handler);

    await captured!({
      message_id: 99,
      from_user_id: 'u',
      item_list: [
        { type: 1, text_item: { text: 'foo' } },
        { type: 1, text_item: { text: 'bar' } },
      ],
    });
    expect(handler.received[0]?.text).toBe('foobar');
    await adapter.stop();
  });

  it('send() routes through sendMessageWeixin with replyCtx fields', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 'tok-xyz',
    });
    await adapter.start(makeHandler());

    await adapter.send('reply text', {
      to: 'wxid_user',
      contextToken: 'ctx-1',
    });

    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(1);
    expect(mockSendMessageWeixin).toHaveBeenCalledWith({
      to: 'wxid_user',
      text: 'reply text',
      opts: expect.objectContaining({
        token: 'tok-xyz',
        contextToken: 'ctx-1',
      }),
    });
    await adapter.stop();
  });

  it('send() rejects malformed replyCtx', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    await adapter.start(makeHandler());
    await expect(
      adapter.send('hi', { /* no `to` */ contextToken: 'x' } as unknown),
    ).rejects.toThrow(/replyCtx/);
    await adapter.stop();
  });

  it('stop() resets state so start() can be called again', async () => {
    const adapter = createWeixinAdapter({
      configStore: stubConfigStore,
      cursorStore: makeCursorStore(),
      token: 't',
    });
    await adapter.start(makeHandler());
    await adapter.stop();
    await expect(adapter.start(makeHandler())).resolves.toBeUndefined();
    await adapter.stop();
  });
});
