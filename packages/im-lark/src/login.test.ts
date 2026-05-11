import { describe, it, expect, vi } from 'vitest';
import { validateLarkCredentials } from './login.js';

/**
 * `validateLarkCredentials` is the pure-validation primitive used by
 * `larkSetupSchema.validate` (W3) and `runLoginCommand` (W7). No
 * persistence side effects — the caller decides what to do on success.
 *
 * Per [DD #86 §11.4 M2](../../../docs/superpowers/specs/2026-05-09-lark-im-adapter-dd.md)
 * + W3/W7 refactor (the wrapping `loginLark` was deleted in W7 because
 * the CLI shortcut now routes through `AdapterRegistryEntry.persist`).
 */
describe('validateLarkCredentials', () => {
  it('Feishu code=0 → resolves silently (no throw, no return value)', async () => {
    const internal = vi.fn(async () => ({
      code: 0,
      msg: 'ok',
      data: { tenant_access_token: 't_xxxx', expire: 7200 },
    }));
    await expect(
      validateLarkCredentials({
        appId: 'cli_test123',
        appSecret: 'secret_abc',
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).resolves.toBeUndefined();
    expect(internal).toHaveBeenCalledOnce();
    expect(internal).toHaveBeenCalledWith({
      data: { app_id: 'cli_test123', app_secret: 'secret_abc' },
    });
  });

  it('Feishu non-zero code → throws with code + msg surfaced verbatim', async () => {
    const internal = vi.fn(async () => ({
      code: 10003,
      msg: 'app id not exist',
      data: {},
    }));
    await expect(
      validateLarkCredentials({
        appId: 'cli_bad',
        appSecret: 'secret',
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/code=10003/);

    await expect(
      validateLarkCredentials({
        appId: 'cli_bad',
        appSecret: 'secret',
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/app id not exist/);
  });

  it('network error → throws with formatErrorWithCause chain (preserves ECONNREFUSED)', async () => {
    const networkErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    });
    const internal = vi.fn(async () => {
      throw networkErr;
    });
    await expect(
      validateLarkCredentials({
        appId: 'cli_x',
        appSecret: 'secret_x',
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/network \/ SDK error/);
    await expect(
      validateLarkCredentials({
        appId: 'cli_x',
        appSecret: 'secret_x',
        buildClient: () => ({
          auth: { v3: { tenantAccessToken: { internal } } },
        }),
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('forwards exact app_id + app_secret to SDK (no silent transform — caller trims)', async () => {
    const internal = vi.fn(async () => ({ code: 0, msg: 'ok', data: {} }));
    await validateLarkCredentials({
      appId: '  cli_with_padding  ',
      appSecret: '  secret_with_padding  ',
      buildClient: () => ({
        auth: { v3: { tenantAccessToken: { internal } } },
      }),
    });
    expect(internal).toHaveBeenCalledWith({
      data: {
        app_id: '  cli_with_padding  ',
        app_secret: '  secret_with_padding  ',
      },
    });
  });
});
