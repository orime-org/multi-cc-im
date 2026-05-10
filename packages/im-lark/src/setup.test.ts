import { describe, expect, it, vi } from 'vitest';
import { buildLarkSetupSchema, larkSetupSchema } from './setup.js';

/**
 * W3 contract test — covers the lark-specific setup schema that adapts
 * `validateLarkCredentials` into the W2 `AdapterSetupSchema` interface
 * the generic wizard (W4) consumes.
 *
 * Per [DD §10.1 W3](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 */
describe('larkSetupSchema (W3)', () => {
  it('schema id is the adapter file-name root used by ~/.multi-cc-im/credentials/<id>.json', () => {
    expect(larkSetupSchema.id).toBe('lark');
  });

  it('schema displayName mentions both Lark and 飞书 so the menu is unambiguous in either locale', () => {
    expect(larkSetupSchema.displayName).toContain('Lark');
    expect(larkSetupSchema.displayName).toContain('飞书');
  });

  it('exposes appId field — non-secret, validates `cli_` prefix', () => {
    const appId = larkSetupSchema.fields.find((f) => f.key === 'appId');
    expect(appId).toBeDefined();
    expect(appId?.secret).toBe(false);
    expect(appId?.label).toContain('App ID');
    expect(appId?.schema.safeParse('cli_abc123').success).toBe(true);
    expect(appId?.schema.safeParse('not_cli_prefixed').success).toBe(false);
    expect(appId?.schema.safeParse('').success).toBe(false);
  });

  it('exposes appSecret field — secret, requires non-empty string', () => {
    const appSecret = larkSetupSchema.fields.find((f) => f.key === 'appSecret');
    expect(appSecret).toBeDefined();
    expect(appSecret?.secret).toBe(true);
    expect(appSecret?.label).toContain('App Secret');
    expect(appSecret?.schema.safeParse('any-non-empty-secret').success).toBe(true);
    expect(appSecret?.schema.safeParse('').success).toBe(false);
  });

  it('field order is appId then appSecret (wizard prompts in this order)', () => {
    expect(larkSetupSchema.fields.map((f) => f.key)).toEqual([
      'appId',
      'appSecret',
    ]);
  });

  it('validate callback resolves when Feishu accepts credentials', async () => {
    const internal = vi.fn(async () => ({ code: 0, msg: 'ok' }));
    const schema = buildLarkSetupSchema({
      buildClient: () => ({
        auth: { v3: { tenantAccessToken: { internal } } },
      }),
    });
    await expect(
      schema.validate?.({ appId: 'cli_test', appSecret: 'secret_xyz' }),
    ).resolves.toBeUndefined();
    expect(internal).toHaveBeenCalledWith({
      data: { app_id: 'cli_test', app_secret: 'secret_xyz' },
    });
  });

  it('validate callback rejects with Feishu code+msg when credentials are wrong', async () => {
    const schema = buildLarkSetupSchema({
      buildClient: () => ({
        auth: {
          v3: {
            tenantAccessToken: {
              internal: async () => ({ code: 10003, msg: 'app id not exist' }),
            },
          },
        },
      }),
    });
    await expect(
      schema.validate?.({ appId: 'cli_bad', appSecret: 'secret_bad' }),
    ).rejects.toThrow(/app id not exist/);
  });

  it('validate callback rejects on SDK / network error with cause chain preserved', async () => {
    const networkErr = new Error('fetch failed');
    (networkErr as Error & { cause?: unknown }).cause = new Error('ENOTFOUND open.feishu.cn');
    const schema = buildLarkSetupSchema({
      buildClient: () => ({
        auth: {
          v3: {
            tenantAccessToken: {
              internal: async () => {
                throw networkErr;
              },
            },
          },
        },
      }),
    });
    await expect(
      schema.validate?.({ appId: 'cli_any', appSecret: 'any' }),
    ).rejects.toThrow(/network \/ SDK error/);
  });

  it('validate callback does NOT persist anything (W4 wizard owns persistence)', async () => {
    // The W2 contract for AdapterSetupSchema.validate is verification only;
    // any credential-store side-effect would be a leak. Since this is a
    // shape contract (no store passed in), the only check is that validate
    // accepts a `Record<string, unknown>` and returns void on success.
    const schema = buildLarkSetupSchema({
      buildClient: () => ({
        auth: {
          v3: {
            tenantAccessToken: {
              internal: async () => ({ code: 0, msg: 'ok' }),
            },
          },
        },
      }),
    });
    const ret = await schema.validate?.({
      appId: 'cli_x',
      appSecret: 'y',
    });
    expect(ret).toBeUndefined();
  });
});
