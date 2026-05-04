import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CredentialStore } from '@multi-cc-im/shared';
import type { WeixinCredentials } from './credentials.js';

const mockStartWeixinLoginWithQr = vi.hoisted(() => vi.fn());
const mockWaitForWeixinLogin = vi.hoisted(() => vi.fn());
const mockQrTerminalGenerate = vi.hoisted(() => vi.fn());

vi.mock('../lib/ilink/auth/login-qr.js', () => ({
  startWeixinLoginWithQr: mockStartWeixinLoginWithQr,
  waitForWeixinLogin: mockWaitForWeixinLogin,
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: mockQrTerminalGenerate },
}));

const { loginWechat } = await import('./login.js');

function makeStore(): CredentialStore<WeixinCredentials> & {
  saved: WeixinCredentials | undefined;
} {
  let saved: WeixinCredentials | undefined;
  return {
    get saved() {
      return saved;
    },
    load: async () => null,
    save: async (creds) => {
      saved = creds;
    },
    delete: async () => {
      saved = undefined;
    },
  };
}

beforeEach(() => {
  mockStartWeixinLoginWithQr.mockReset();
  mockWaitForWeixinLogin.mockReset();
  mockQrTerminalGenerate.mockReset();
});

describe('loginWechat', () => {
  it('renders QR, polls for confirm, saves token + savedAt to credentialStore', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/abc',
      message: '使用微信扫描以下二维码',
      sessionKey: 'sess-1',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: 'tok-zzz',
      accountId: 'bot-1',
      baseUrl: 'https://ilink.example.com',
      userId: 'wxid_owner',
      message: '✅ 与微信连接成功！',
    });

    const store = makeStore();
    const lines: string[] = [];
    const renderedQR: string[] = [];

    const before = Date.now();
    const result = await loginWechat({
      credentialStore: store,
      output: {
        renderQR: (url) => renderedQR.push(url),
        println: (m) => lines.push(m),
      },
    });
    const after = Date.now();

    expect(result.token).toBe('tok-zzz');
    expect(result.savedAt).toBeDefined();
    const savedAtMs = new Date(result.savedAt!).getTime();
    expect(savedAtMs).toBeGreaterThanOrEqual(before);
    expect(savedAtMs).toBeLessThanOrEqual(after);

    expect(store.saved).toEqual(result);
    expect(renderedQR).toEqual(['https://example.com/qr/abc']);
    expect(lines).toContain('使用微信扫描以下二维码');
    expect(lines).toContain('✅ 与微信连接成功！');
  });

  it('throws when startWeixinLoginWithQr returns no qrcodeUrl (initial fetch failed)', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: undefined,
      message: 'Failed to start login: network error',
      sessionKey: 'sess-2',
    });
    const store = makeStore();
    await expect(
      loginWechat({
        credentialStore: store,
        output: { renderQR: () => {}, println: () => {} },
      }),
    ).rejects.toThrow(/Failed to start.*network error/);
    expect(store.saved).toBeUndefined();
    expect(mockWaitForWeixinLogin).not.toHaveBeenCalled();
  });

  it('throws when waitForWeixinLogin returns connected=false (timeout / expired)', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/x',
      message: '请扫码',
      sessionKey: 'sess-3',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: false,
      message: '登录超时，请重试。',
    });
    const store = makeStore();
    await expect(
      loginWechat({
        credentialStore: store,
        output: { renderQR: () => {}, println: () => {} },
      }),
    ).rejects.toThrow(/login failed.*登录超时/i);
    expect(store.saved).toBeUndefined();
  });

  it('throws when waitForWeixinLogin returns connected=true but no botToken (server bug)', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/x',
      message: '请扫码',
      sessionKey: 'sess-4',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: undefined,
      message: '已连接但缺 token',
    });
    const store = makeStore();
    await expect(
      loginWechat({
        credentialStore: store,
        output: { renderQR: () => {}, println: () => {} },
      }),
    ).rejects.toThrow(/login failed/i);
    expect(store.saved).toBeUndefined();
  });

  it('forwards timeoutMs to waitForWeixinLogin', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/x',
      message: 'go',
      sessionKey: 'sess-5',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: 't',
      message: 'ok',
    });
    await loginWechat({
      credentialStore: makeStore(),
      output: { renderQR: () => {}, println: () => {} },
      timeoutMs: 60_000,
    });
    expect(mockWaitForWeixinLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'sess-5',
        timeoutMs: 60_000,
      }),
    );
  });

  it('default output renders via qrcode-terminal and writes URL fallback', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/y',
      message: 'go',
      sessionKey: 'sess-6',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: 't',
      message: 'ok',
    });

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await loginWechat({ credentialStore: makeStore() });
      expect(mockQrTerminalGenerate).toHaveBeenCalledWith(
        'https://example.com/qr/y',
        expect.objectContaining({ small: true }),
      );
      const stdoutText = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).toContain('https://example.com/qr/y');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
