import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CredentialStore } from '@multi-cc-im/shared';
import type { Dispatcher } from 'undici';
import type { HealthProbedDispatcher } from '../lib/ilink/api/dispatcher.js';
import type { WeixinCredentials } from './credentials.js';

const mockStartWeixinLoginWithQr = vi.hoisted(() => vi.fn());
const mockWaitForWeixinLogin = vi.hoisted(() => vi.fn());
const mockQrTerminalGenerate = vi.hoisted(() => vi.fn());
const mockCreateHealthProbedDispatcher = vi.hoisted(() => vi.fn());

vi.mock('../lib/ilink/auth/login-qr.js', () => ({
  startWeixinLoginWithQr: mockStartWeixinLoginWithQr,
  waitForWeixinLogin: mockWaitForWeixinLogin,
}));

vi.mock('../lib/ilink/api/dispatcher.js', () => ({
  createHealthProbedDispatcher: mockCreateHealthProbedDispatcher,
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: mockQrTerminalGenerate },
}));

function makeStubDispatcher(): HealthProbedDispatcher & {
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(async () => {});
  return {
    agent: { dispatch: vi.fn(), close: vi.fn() } as unknown as Dispatcher,
    stop,
    reprobeNow: async () => {},
    snapshot: () => ({ healthy: [], dead: [], degraded: false }),
  };
}

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
  mockCreateHealthProbedDispatcher.mockReset();
  // Default: every test gets a fresh stub dispatcher so we never hit real DNS
  // / TCP probes. Tests that need to assert on dispatcher lifecycle override
  // this in-place.
  mockCreateHealthProbedDispatcher.mockImplementation(async () =>
    makeStubDispatcher(),
  );
});

describe('loginWechat', () => {
  it('renders QR, polls for confirm, saves token + savedAt to credentialStore', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/abc',
      message: 'Scan the QR code above with WeChat',
      sessionKey: 'sess-1',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: 'tok-zzz',
      accountId: 'bot-1',
      baseUrl: 'https://ilink.example.com',
      userId: 'wxid_owner',
      message: 'Successfully connected to WeChat!',
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
    expect(lines).toContain('Scan the QR code above with WeChat');
    expect(lines).toContain('Successfully connected to WeChat!');
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
      message: 'Please scan',
      sessionKey: 'sess-3',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: false,
      message: 'Login timed out, please retry.',
    });
    const store = makeStore();
    await expect(
      loginWechat({
        credentialStore: store,
        output: { renderQR: () => {}, println: () => {} },
      }),
    ).rejects.toThrow(/login failed.*timed out/i);
    expect(store.saved).toBeUndefined();
  });

  it('throws when waitForWeixinLogin returns connected=true but no botToken (server bug)', async () => {
    mockStartWeixinLoginWithQr.mockResolvedValue({
      qrcodeUrl: 'https://example.com/qr/x',
      message: 'Please scan',
      sessionKey: 'sess-4',
    });
    mockWaitForWeixinLogin.mockResolvedValue({
      connected: true,
      botToken: undefined,
      message: 'connected but token missing',
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

  // ==========================================================================
  // dispatcher lifecycle: per CLAUDE.md "禁止直接用 global fetch 绕开
  // dispatcher" — login flow must build a health-probed dispatcher and
  // forward it to both vendor calls so requests route only to healthy iLink
  // LB IPs. Without this the bare global fetch hits a dead IP and login
  // fails with TLS ECONNRESET.
  // ==========================================================================

  it('creates a dispatcher, forwards it to start + wait, then closes it on success', async () => {
    const stub = makeStubDispatcher();
    mockCreateHealthProbedDispatcher.mockResolvedValueOnce(stub);
    mockStartWeixinLoginWithQr.mockResolvedValueOnce({
      qrcodeUrl: 'https://example.com/qr/d',
      message: 'go',
      sessionKey: 'sess-d',
    });
    mockWaitForWeixinLogin.mockResolvedValueOnce({
      connected: true,
      botToken: 'tok',
      message: 'ok',
    });

    await loginWechat({
      credentialStore: makeStore(),
      output: { renderQR: () => {}, println: () => {} },
    });

    expect(mockCreateHealthProbedDispatcher).toHaveBeenCalledOnce();
    // Hostname must match the iLink login host pinned in vendor.
    expect(mockCreateHealthProbedDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'ilinkai.weixin.qq.com' }),
    );
    expect(mockStartWeixinLoginWithQr).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcher: stub.agent }),
    );
    expect(mockWaitForWeixinLogin).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcher: stub.agent }),
    );
    expect(stub.stop).toHaveBeenCalledOnce();
  });

  it('closes the dispatcher even when login fails partway (finally semantics)', async () => {
    const stub = makeStubDispatcher();
    mockCreateHealthProbedDispatcher.mockResolvedValueOnce(stub);
    mockStartWeixinLoginWithQr.mockResolvedValueOnce({
      qrcodeUrl: undefined,
      message: 'Failed to start login: boom',
      sessionKey: 'sess-fail',
    });

    await expect(
      loginWechat({
        credentialStore: makeStore(),
        output: { renderQR: () => {}, println: () => {} },
      }),
    ).rejects.toThrow();
    expect(stub.stop).toHaveBeenCalledOnce();
  });

  it('respects createDispatcher DI — uses caller-supplied factory and closes it', async () => {
    const stub = makeStubDispatcher();
    const factory = vi.fn(async () => stub);
    mockStartWeixinLoginWithQr.mockResolvedValueOnce({
      qrcodeUrl: 'https://example.com/qr/di',
      message: 'go',
      sessionKey: 'sess-di',
    });
    mockWaitForWeixinLogin.mockResolvedValueOnce({
      connected: true,
      botToken: 'tok',
      message: 'ok',
    });

    await loginWechat({
      credentialStore: makeStore(),
      output: { renderQR: () => {}, println: () => {} },
      createDispatcher: factory,
    });

    expect(factory).toHaveBeenCalledOnce();
    // The default real factory should NOT be touched when DI is provided
    expect(mockCreateHealthProbedDispatcher).not.toHaveBeenCalled();
    expect(stub.stop).toHaveBeenCalledOnce();
  });
});
