import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ConfigStore,
  CredentialStore,
  CursorStore,
  IMHandler,
  IncomingMessage,
  IMReplyContext,
} from '@multi-cc-im/shared';
import type { WeixinCredentials } from './credentials.js';
import {
  isFileSender,
  isImageSender,
  isTypingIndicator,
  isVoiceSender,
} from '@multi-cc-im/shared';
import type { WeixinMessage } from '../lib/ilink/api/types.js';

// Hoisted mocks — must be set up before SUT import so the module picks them up.
const mockSendMessageWeixin = vi.hoisted(() => vi.fn());
const mockSendImageMessageWeixin = vi.hoisted(() => vi.fn());
const mockSendFileMessageWeixin = vi.hoisted(() => vi.fn());
const mockUploadFileToWeixin = vi.hoisted(() => vi.fn());
const mockUploadFileAttachmentToWeixin = vi.hoisted(() => vi.fn());
const mockSendTyping = vi.hoisted(() => vi.fn());
const mockGetConfig = vi.hoisted(() => vi.fn());
const mockDownloadMediaFromItem = vi.hoisted(() => vi.fn());
const mockRunMonitor = vi.hoisted(() => vi.fn());

vi.mock('../lib/ilink/messaging/send.js', () => ({
  sendMessageWeixin: mockSendMessageWeixin,
  sendImageMessageWeixin: mockSendImageMessageWeixin,
  sendFileMessageWeixin: mockSendFileMessageWeixin,
}));

vi.mock('../lib/ilink/cdn/upload.js', () => ({
  uploadFileToWeixin: mockUploadFileToWeixin,
  uploadFileAttachmentToWeixin: mockUploadFileAttachmentToWeixin,
}));

vi.mock('../lib/ilink/api/api.js', () => ({
  sendTyping: mockSendTyping,
  getConfig: mockGetConfig,
}));

vi.mock('../lib/ilink/media/media-download.js', () => ({
  downloadMediaFromItem: mockDownloadMediaFromItem,
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

function makeCredentialStore(
  token = 't',
): CredentialStore<WeixinCredentials> {
  return {
    load: async () => ({ token }),
    save: async () => {},
    delete: async () => {},
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

let inboundMediaDir: string;

beforeEach(() => {
  inboundMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-inbound-'));
  mockSendMessageWeixin.mockReset();
  mockSendImageMessageWeixin.mockReset().mockResolvedValue({ messageId: 'img-1' });
  mockSendFileMessageWeixin.mockReset().mockResolvedValue({ messageId: 'file-1' });
  mockUploadFileToWeixin.mockReset().mockResolvedValue({
    filekey: 'fk-1',
    downloadEncryptedQueryParam: 'dl-1',
    aeskey: '00'.repeat(16),
    fileSize: 1234,
    fileSizeCiphertext: 1248,
  });
  mockUploadFileAttachmentToWeixin.mockReset().mockResolvedValue({
    filekey: 'fk-2',
    downloadEncryptedQueryParam: 'dl-2',
    aeskey: '00'.repeat(16),
    fileSize: 4321,
    fileSizeCiphertext: 4336,
  });
  mockSendTyping.mockReset().mockResolvedValue(undefined);
  mockGetConfig
    .mockReset()
    .mockResolvedValue({ ret: 0, typing_ticket: 'ticket-abc' });
  mockDownloadMediaFromItem.mockReset().mockResolvedValue({});
  mockRunMonitor.mockReset();
  mockRunMonitor.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(inboundMediaDir, { recursive: true, force: true });
});

function makeAdapter() {
  return createWeixinAdapter({
    configStore: stubConfigStore,
    cursorStore: makeCursorStore(),
    credentialStore: makeCredentialStore(),
    inboundMediaDir,
  });
}

describe('createWeixinAdapter — core IMAdapter', () => {
  it('exposes name = "wechat"', () => {
    expect(makeAdapter().name).toBe('wechat');
  });

  it('throws if start() is called twice', async () => {
    const adapter = makeAdapter();
    await adapter.start(makeHandler());
    await expect(adapter.start(makeHandler())).rejects.toThrow(
      /start\(\) called twice/,
    );
    await adapter.stop();
  });

  it('throws if send() is called before start()', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.send('hi', { imType: 'wechat', to: 'u1', contextToken: undefined }),
    ).rejects.toThrow(/before start/);
  });

  it('forwards a TEXT WeixinMessage to handler.onMessage as IncomingMessage', async () => {
    const adapter = makeAdapter();
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
      replyCtx: { imType: 'wechat', to: 'wxid_user', contextToken: undefined },
      timestamp: 1700000000000,
    });
    await adapter.stop();
  });

  it('skips non-business WeixinMessage (no from_user_id)', async () => {
    const adapter = makeAdapter();
    const handler = makeHandler();
    let capturedOnMessage:
      | ((msg: WeixinMessage) => Promise<void>)
      | undefined;
    mockRunMonitor.mockImplementation(async (opts) => {
      capturedOnMessage = opts.onMessage;
    });
    await adapter.start(handler);

    await capturedOnMessage!({ message_id: 1 } as WeixinMessage);

    expect(handler.received).toHaveLength(0);
    await adapter.stop();
  });

  it('joins multiple text items into a single text payload', async () => {
    const adapter = makeAdapter();
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
      credentialStore: makeCredentialStore('tok-xyz'),
      inboundMediaDir,
    });
    await adapter.start(makeHandler());

    await adapter.send('reply text', {
      imType: 'wechat',
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
    const adapter = makeAdapter();
    await adapter.start(makeHandler());
    await expect(
      adapter.send('hi', { contextToken: 'x' } as unknown as IMReplyContext),
    ).rejects.toThrow(/replyCtx/);
    await adapter.stop();
  });

  it('stop() resets state so start() can be called again', async () => {
    const adapter = makeAdapter();
    await adapter.start(makeHandler());
    await adapter.stop();
    await expect(adapter.start(makeHandler())).resolves.toBeUndefined();
    await adapter.stop();
  });
});

describe('createWeixinAdapter — capability surface (type guards)', () => {
  it('satisfies ImageSender / FileSender / TypingIndicator (not VoiceSender)', () => {
    const a = makeAdapter();
    expect(isImageSender(a)).toBe(true);
    expect(isFileSender(a)).toBe(true);
    expect(isTypingIndicator(a)).toBe(true);
    // iLink Bot API has no outbound voice — capability is intentionally absent.
    expect(isVoiceSender(a)).toBe(false);
  });
});

describe('createWeixinAdapter — sendImage / sendFile', () => {
  it('sendImage uploads then sends image with replyCtx', async () => {
    const a = makeAdapter();
    if (!isImageSender(a)) throw new Error('not ImageSender');
    await a.start(makeHandler());

    await a.sendImage('/tmp/photo.png', { imType: 'wechat', to: 'wxid_user', contextToken: 'ctx-2' });

    expect(mockUploadFileToWeixin).toHaveBeenCalledTimes(1);
    expect(mockUploadFileToWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/photo.png',
        toUserId: 'wxid_user',
        opts: expect.objectContaining({ token: 't' }),
      }),
    );
    expect(mockSendImageMessageWeixin).toHaveBeenCalledTimes(1);
    expect(mockSendImageMessageWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'wxid_user',
        text: '',
        opts: expect.objectContaining({ contextToken: 'ctx-2' }),
        uploaded: expect.objectContaining({ filekey: 'fk-1' }),
      }),
    );
    await a.stop();
  });

  it('sendFile uploads then sends file with file_name from path basename', async () => {
    const a = makeAdapter();
    if (!isFileSender(a)) throw new Error('not FileSender');
    await a.start(makeHandler());

    await a.sendFile('/tmp/report.pdf', { imType: 'wechat', to: 'wxid_user', contextToken: 'ctx-3' });

    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledTimes(1);
    expect(mockUploadFileAttachmentToWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/report.pdf',
        fileName: 'report.pdf',
        toUserId: 'wxid_user',
      }),
    );
    expect(mockSendFileMessageWeixin).toHaveBeenCalledTimes(1);
    expect(mockSendFileMessageWeixin).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'wxid_user',
        fileName: 'report.pdf',
        uploaded: expect.objectContaining({ filekey: 'fk-2' }),
      }),
    );
    await a.stop();
  });

  it('sendImage / sendFile reject malformed replyCtx', async () => {
    const a = makeAdapter();
    if (!isImageSender(a) || !isFileSender(a)) throw new Error('caps missing');
    await a.start(makeHandler());

    await expect(
      a.sendImage('/tmp/x.png', { contextToken: 'x' } as unknown as IMReplyContext),
    ).rejects.toThrow(/replyCtx/);
    await expect(
      a.sendFile('/tmp/x.pdf', { contextToken: 'x' } as unknown as IMReplyContext),
    ).rejects.toThrow(/replyCtx/);
    await a.stop();
  });

  it('sendImage / sendFile throw if called before start()', async () => {
    const a = makeAdapter();
    if (!isImageSender(a) || !isFileSender(a)) throw new Error('caps missing');
    await expect(
      a.sendImage('/tmp/x.png', { imType: 'wechat', to: 'u', contextToken: undefined }),
    ).rejects.toThrow(/before start/);
    await expect(
      a.sendFile('/tmp/x.pdf', { imType: 'wechat', to: 'u', contextToken: undefined }),
    ).rejects.toThrow(/before start/);
  });
});

describe('createWeixinAdapter — startTyping', () => {
  it('fetches typing_ticket via getConfig and sends TYPING; cancel fn sends CANCEL', async () => {
    const a = makeAdapter();
    if (!isTypingIndicator(a)) throw new Error('not TypingIndicator');
    await a.start(makeHandler());

    const cancel = await a.startTyping({ imType: 'wechat', to: 'wxid_user', contextToken: 'ctx' });

    expect(mockGetConfig).toHaveBeenCalledTimes(1);
    expect(mockGetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ilinkUserId: 'wxid_user', contextToken: 'ctx' }),
    );

    expect(mockSendTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          ilink_user_id: 'wxid_user',
          typing_ticket: 'ticket-abc',
          status: 1,
        }),
      }),
    );

    cancel();
    await new Promise((r) => setImmediate(r));

    const cancelCalls = mockSendTyping.mock.calls.filter(
      (c) => (c[0] as { body: { status?: number } }).body.status === 2,
    );
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          ilink_user_id: 'wxid_user',
          typing_ticket: 'ticket-abc',
          status: 2,
        }),
      }),
    );
    await a.stop();
  });

  it('caches typing_ticket per-user (vendored WeixinConfigManager)', async () => {
    const a = makeAdapter();
    if (!isTypingIndicator(a)) throw new Error('not TypingIndicator');
    await a.start(makeHandler());

    await a.startTyping({ imType: 'wechat', to: 'wxid_user', contextToken: 'ctx' });
    await a.startTyping({ imType: 'wechat', to: 'wxid_user', contextToken: 'ctx' });

    // Same userId twice → cache hit on second call.
    expect(mockGetConfig).toHaveBeenCalledTimes(1);
    await a.stop();
  });

  it('startTyping is a no-op when getConfig returns no typing_ticket', async () => {
    mockGetConfig.mockResolvedValue({ ret: 0 });
    const a = makeAdapter();
    if (!isTypingIndicator(a)) throw new Error('not TypingIndicator');
    await a.start(makeHandler());

    const cancel = await a.startTyping({ imType: 'wechat', to: 'u', contextToken: undefined });
    expect(mockSendTyping).not.toHaveBeenCalled();
    cancel();
    await new Promise((r) => setImmediate(r));
    expect(mockSendTyping).not.toHaveBeenCalled();
    await a.stop();
  });

  it('startTyping throws if called before start()', async () => {
    const a = makeAdapter();
    if (!isTypingIndicator(a)) throw new Error('not TypingIndicator');
    await expect(
      a.startTyping({ imType: 'wechat', to: 'u', contextToken: undefined }),
    ).rejects.toThrow(/before start/);
  });
});

describe('createWeixinAdapter — inbound media → IncomingMessage.attachments', () => {
  function captureOnMessage(): {
    capture: () => (msg: WeixinMessage) => Promise<void>;
  } {
    let inner: ((msg: WeixinMessage) => Promise<void>) | undefined;
    mockRunMonitor.mockImplementation(async (opts) => {
      inner = opts.onMessage;
    });
    return {
      capture: () => {
        if (!inner) throw new Error('onMessage not yet captured');
        return inner;
      },
    };
  }

  it('IMAGE item → attachment kind=image with localPath', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({
      decryptedPicPath: '/tmp/inbound/pic-1.jpg',
    });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 7,
      from_user_id: 'u',
      item_list: [{ type: 2, image_item: { aeskey: 'aa' } }],
    });
    expect(handler.received[0]?.attachments).toEqual([
      { kind: 'image', localPath: '/tmp/inbound/pic-1.jpg' },
    ]);
    expect(handler.received[0]?.text).toBeNull();
    await a.stop();
  });

  it('FILE item → attachment kind=file with localPath + mimetype', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({
      decryptedFilePath: '/tmp/inbound/doc.pdf',
      fileMediaType: 'application/pdf',
    });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 8,
      from_user_id: 'u',
      item_list: [{ type: 4, file_item: { file_name: 'doc.pdf' } }],
    });
    expect(handler.received[0]?.attachments).toEqual([
      { kind: 'file', localPath: '/tmp/inbound/doc.pdf', mimetype: 'application/pdf' },
    ]);
    await a.stop();
  });

  it('VOICE item with voice_text populates IncomingMessage.text and skips voice attachment', async () => {
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 9,
      from_user_id: 'u',
      item_list: [{ type: 3, voice_item: { text: 'spoken hello' } }],
    });
    expect(handler.received[0]?.text).toBe('spoken hello');
    expect(handler.received[0]?.attachments).toHaveLength(0);
    expect(mockDownloadMediaFromItem).not.toHaveBeenCalled();
    await a.stop();
  });

  it('VOICE item without voice_text → attachment kind=voice', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({
      decryptedVoicePath: '/tmp/inbound/voice.wav',
      voiceMediaType: 'audio/wav',
    });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 10,
      from_user_id: 'u',
      item_list: [{ type: 3, voice_item: {} }],
    });
    expect(handler.received[0]?.attachments).toEqual([
      { kind: 'voice', localPath: '/tmp/inbound/voice.wav', mimetype: 'audio/wav' },
    ]);
    await a.stop();
  });

  it('VIDEO item → attachment kind=file mime=video/mp4 (shared has no video kind)', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({
      decryptedVideoPath: '/tmp/inbound/clip.mp4',
    });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 11,
      from_user_id: 'u',
      item_list: [{ type: 5, video_item: {} }],
    });
    expect(handler.received[0]?.attachments).toEqual([
      { kind: 'file', localPath: '/tmp/inbound/clip.mp4', mimetype: 'video/mp4' },
    ]);
    await a.stop();
  });

  it('mixed TEXT + IMAGE → text + 1 attachment', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({
      decryptedPicPath: '/tmp/inbound/pic-2.jpg',
    });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 12,
      from_user_id: 'u',
      item_list: [
        { type: 1, text_item: { text: 'caption' } },
        { type: 2, image_item: { aeskey: 'aa' } },
      ],
    });
    expect(handler.received[0]?.text).toBe('caption');
    expect(handler.received[0]?.attachments).toHaveLength(1);
    await a.stop();
  });

  it('multiple media items → multiple attachments preserving order', async () => {
    mockDownloadMediaFromItem
      .mockResolvedValueOnce({ decryptedPicPath: '/tmp/a.jpg' })
      .mockResolvedValueOnce({
        decryptedFilePath: '/tmp/b.pdf',
        fileMediaType: 'application/pdf',
      });
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 13,
      from_user_id: 'u',
      item_list: [
        { type: 2, image_item: {} },
        { type: 4, file_item: { file_name: 'b.pdf' } },
      ],
    });
    expect(handler.received[0]?.attachments).toEqual([
      { kind: 'image', localPath: '/tmp/a.jpg' },
      { kind: 'file', localPath: '/tmp/b.pdf', mimetype: 'application/pdf' },
    ]);
    await a.stop();
  });

  it('media download returning empty result → no attachment, no error thrown', async () => {
    mockDownloadMediaFromItem.mockResolvedValueOnce({});
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 14,
      from_user_id: 'u',
      item_list: [{ type: 2, image_item: {} }],
    });
    expect(handler.received[0]?.attachments).toHaveLength(0);
    expect(handler.errors).toHaveLength(0);
    await a.stop();
  });

  it('passes inboundMediaDir-derived saveMedia callback to downloadMediaFromItem', async () => {
    const a = makeAdapter();
    const handler = makeHandler();
    const cap = captureOnMessage();
    await a.start(handler);
    await cap.capture()({
      message_id: 15,
      from_user_id: 'u',
      item_list: [{ type: 2, image_item: {} }],
    });
    expect(mockDownloadMediaFromItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 2 }),
      expect.objectContaining({
        cdnBaseUrl: expect.any(String),
        saveMedia: expect.any(Function),
        log: expect.any(Function),
        errLog: expect.any(Function),
        label: expect.any(String),
      }),
    );
    await a.stop();
  });

  it('saveMedia callback writes buffer under inboundMediaDir and returns absolute path', async () => {
    let captured: undefined | ((buf: Buffer, ct?: string) => Promise<{ path: string }>);
    mockDownloadMediaFromItem.mockImplementationOnce(async (_item, deps) => {
      captured = deps.saveMedia;
      return {};
    });
    const a = makeAdapter();
    const cap = captureOnMessage();
    await a.start(makeHandler());
    await cap.capture()({
      message_id: 16,
      from_user_id: 'u',
      item_list: [{ type: 2, image_item: {} }],
    });
    expect(captured).toBeDefined();
    const { path: savedPath } = await captured!(Buffer.from([1, 2, 3]), 'image/png');
    expect(savedPath.startsWith(inboundMediaDir)).toBe(true);
    expect(fs.readFileSync(savedPath)).toEqual(Buffer.from([1, 2, 3]));
    await a.stop();
  });
});
