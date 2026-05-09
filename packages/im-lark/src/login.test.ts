import { describe, it, expect, vi } from 'vitest';
import type { CredentialStore } from '@multi-cc-im/shared';
import { loginLark } from './login.js';
import type { LarkCredentials } from './credentials.js';

function makeStore(): CredentialStore<LarkCredentials> & {
  saved: LarkCredentials | undefined;
} {
  let saved: LarkCredentials | undefined;
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

describe('loginLark', () => {
  it('happy path — Feishu returns code=0 → credentials persisted with savedAt', async () => {
    const internal = vi.fn(async () => ({
      code: 0,
      msg: 'ok',
      data: { tenant_access_token: 't_xxxx', expire: 7200 },
    }));
    const store = makeStore();

    const before = Date.now();
    const result = await loginLark({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      credentialStore: store,
      buildClient: () => ({
        auth: { v3: { tenantAccessToken: { internal } } },
      }),
    });
    const after = Date.now();

    expect(result.appId).toBe('cli_test123');
    expect(result.appSecret).toBe('secret_abc');
    const savedAtMs = new Date(result.savedAt).getTime();
    expect(savedAtMs).toBeGreaterThanOrEqual(before);
    expect(savedAtMs).toBeLessThanOrEqual(after);

    expect(store.saved).toEqual(result);
    expect(internal).toHaveBeenCalledOnce();
    expect(internal).toHaveBeenCalledWith({
      data: { app_id: 'cli_test123', app_secret: 'secret_abc' },
    });
  });

  it('Feishu non-zero code → throws with code + msg surfaced', async () => {
    const internal = vi.fn(async () => ({
      code: 10003,
      msg: 'app id not exist',
      data: {},
    }));
    const store = makeStore();

    await expect(
      loginLark({
        appId: 'cli_bad',
        appSecret: 'secret',
        credentialStore: store,
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/code=10003/);
    await expect(
      loginLark({
        appId: 'cli_bad',
        appSecret: 'secret',
        credentialStore: store,
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/app id not exist/);

    expect(store.saved).toBeUndefined();
  });

  it('network error → throws with formatErrorWithCause chain', async () => {
    const networkErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    });
    const internal = vi.fn(async () => {
      throw networkErr;
    });
    const store = makeStore();

    await expect(
      loginLark({
        appId: 'cli_x',
        appSecret: 'secret_x',
        credentialStore: store,
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/network \/ SDK error/);
    await expect(
      loginLark({
        appId: 'cli_x',
        appSecret: 'secret_x',
        credentialStore: store,
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    expect(store.saved).toBeUndefined();
  });

  it('credential store save() rejection propagates (no silent swallow)', async () => {
    const internal = vi.fn(async () => ({ code: 0, msg: 'ok', data: {} }));
    const store: CredentialStore<LarkCredentials> = {
      load: async () => null,
      save: async () => {
        throw new Error('EACCES: permission denied');
      },
      delete: async () => {},
    };

    await expect(
      loginLark({
        appId: 'cli_x',
        appSecret: 'secret_x',
        credentialStore: store,
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/EACCES/);
  });

  it('forwards exact app_id + app_secret to SDK (no transform)', async () => {
    const internal = vi.fn(async () => ({ code: 0, msg: 'ok', data: {} }));
    await loginLark({
      appId: '  cli_with_padding  ',
      appSecret: '  secret_with_padding  ',
      credentialStore: makeStore(),
      buildClient: () => ({
        auth: { v3: { tenantAccessToken: { internal } } },
      }),
    });
    // Caller is responsible for trimming; we don't silently mutate input.
    expect(internal).toHaveBeenCalledWith({
      data: {
        app_id: '  cli_with_padding  ',
        app_secret: '  secret_with_padding  ',
      },
    });
  });

  it('savedAt is parseable as a valid ISO 8601 UTC timestamp', async () => {
    const internal = vi.fn(async () => ({ code: 0, msg: 'ok', data: {} }));
    const result = await loginLark({
      appId: 'cli_x',
      appSecret: 'secret',
      credentialStore: makeStore(),
      buildClient: () => ({
        auth: { v3: { tenantAccessToken: { internal } } },
      }),
    });
    expect(result.savedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Number.isFinite(new Date(result.savedAt).getTime())).toBe(true);
  });
});
