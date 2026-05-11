import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { fieldKeyToFlag, fieldKeyToEnvVar, runLoginCommand } from './login.js';
import type { AdapterRegistryEntry } from './adapters.js';

/**
 * W7 contract — `runLoginCommand` is the non-interactive shortcut.
 * Routes through the same `entry.setupSchema.validate + entry.persist`
 * the W4 wizard uses, so the on-disk JSON is bit-for-bit identical
 * regardless of entry point. Per
 * [DD §10.1 W7](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 */

function makeFakeLarkEntry(opts?: {
  validate?: (values: Record<string, unknown>) => Promise<void>;
  persist?: (
    values: Record<string, unknown>,
    paths: { credentialFor: (id: string) => string },
  ) => Promise<void>;
}): AdapterRegistryEntry {
  return {
    id: 'lark',
    setupSchema: {
      id: 'lark',
      displayName: 'Lark / 飞书',
      fields: [
        {
          key: 'appId',
          label: 'App ID',
          secret: false,
          schema: z.string().trim().min(1).startsWith('cli_'),
        },
        {
          key: 'appSecret',
          label: 'App Secret',
          secret: true,
          schema: z.string().trim().min(1),
        },
      ],
      validate: opts?.validate,
    },
    buildPersistShape: (v) => ({ ...v, savedAt: 'fixed-ts-for-tests' }),
    persist: opts?.persist ?? (async () => {}),
    buildAdapterRuntime: () => {
      throw new Error('buildAdapterRuntime not exercised by login tests');
    },
  };
}

describe('runLoginCommand (W7 — adapter-generic non-interactive shortcut)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'login-cmd-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('unknown adapter → exit 2 + available list', async () => {
    const result = await runLoginCommand({
      adapter: 'wechat',
      values: {},
      root,
      registry: [makeFakeLarkEntry()],
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("'wechat'");
    expect(result.stderr).toContain('Available: lark');
  });

  it('missing required field → exit 2 + flag/env hint', async () => {
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'cli_x' /* appSecret missing */ },
      root,
      registry: [makeFakeLarkEntry()],
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('App Secret');
    expect(result.stderr).toContain('--app-secret');
    expect(result.stderr).toContain('LARK_APP_SECRET');
  });

  it('field-level zod fail (cli_ prefix missing) → exit 2 + field label + zod message', async () => {
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'not_prefixed', appSecret: 'sec' },
      root,
      registry: [makeFakeLarkEntry()],
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('App ID');
    expect(result.stderr).toContain('cli_');
  });

  it('adapter validate rejects → exit 1 + propagates error message', async () => {
    const validate = vi.fn(async () => {
      throw new Error('Feishu rejected credentials (code=10003, msg=app id not exist)');
    });
    const persist = vi.fn(async () => {});
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'cli_bad', appSecret: 'bad' },
      root,
      registry: [makeFakeLarkEntry({ validate, persist })],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('code=10003');
    expect(result.stderr).toContain('app id not exist');
    expect(persist).not.toHaveBeenCalled();
  });

  it('happy path → validate + persist called with trimmed values; exit 0', async () => {
    const validate = vi.fn(async (_v: Record<string, unknown>) => {});
    const persist = vi.fn(
      async (
        _values: Record<string, unknown>,
        _paths: { credentialFor: (id: string) => string },
      ) => {},
    );
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: '  cli_test  ', appSecret: '\tsecret_xyz\n' },
      root,
      registry: [makeFakeLarkEntry({ validate, persist })],
    });
    expect(result).toEqual({ exitCode: 0, stderr: '', adapter: 'lark' });
    expect(validate).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith({
      appId: 'cli_test',
      appSecret: 'secret_xyz',
    });
    expect(persist).toHaveBeenCalledOnce();
    const persistArgs = persist.mock.calls[0]!;
    expect(persistArgs[0]).toEqual({
      appId: 'cli_test',
      appSecret: 'secret_xyz',
    });
  });

  it('persist failure → exit 1 + diagnostic', async () => {
    const validate = vi.fn(async () => {});
    const persist = vi.fn(async () => {
      throw new Error('EACCES: permission denied writing credentials file');
    });
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'cli_x', appSecret: 'sec' },
      root,
      registry: [makeFakeLarkEntry({ validate, persist })],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('persist failed');
    expect(result.stderr).toContain('EACCES');
  });

  it('no adapter.validate (optional callback) → skips API check, persists directly', async () => {
    const persist = vi.fn(async () => {});
    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'cli_x', appSecret: 'sec' },
      root,
      registry: [makeFakeLarkEntry({ /* no validate */ persist })],
    });
    expect(result.exitCode).toBe(0);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('W7 invariant: persisted JSON shape matches what the wizard would write (round-trip via real lark entry)', async () => {
    // Use the REAL lark registry entry — same one wizard/W5 uses — so this
    // test catches any future divergence between CLI shortcut and wizard
    // persist paths. Stub only the adapter validate (Feishu network).
    const { adapters: realAdapters } = await import('./adapters.js');
    const realLark = realAdapters.find((a) => a.id === 'lark')!;
    const patchedLark: AdapterRegistryEntry = {
      ...realLark,
      setupSchema: {
        ...realLark.setupSchema,
        validate: async () => {},  // skip live Feishu auth ping
      },
    };

    const result = await runLoginCommand({
      adapter: 'lark',
      values: { appId: 'cli_invariant', appSecret: 'sec_invariant_xyz' },
      root,
      registry: [patchedLark],
    });
    expect(result.exitCode).toBe(0);

    // Inspect the on-disk JSON — this is exactly what the wizard would write
    // because both flows end at `entry.persist(values, paths)`.
    const credFile = join(root, 'credentials', 'lark.json');
    const onDisk = JSON.parse(await readFile(credFile, 'utf-8')) as {
      appId: string;
      appSecret: string;
      savedAt: string;
    };
    expect(onDisk.appId).toBe('cli_invariant');
    expect(onDisk.appSecret).toBe('sec_invariant_xyz');
    expect(typeof onDisk.savedAt).toBe('string');
    expect(() => new Date(onDisk.savedAt).toISOString()).not.toThrow();

    // File permission: 0600 (owner read/write only — secret hygiene).
    const stats = await stat(credFile);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe('field-key naming helpers', () => {
  it('camelCase → kebab-case flag suffix (no leading dashes — caller adds "--")', () => {
    expect(fieldKeyToFlag('appId')).toBe('app-id');
    expect(fieldKeyToFlag('appSecret')).toBe('app-secret');
    expect(fieldKeyToFlag('botToken')).toBe('bot-token');
    expect(fieldKeyToFlag('apiBaseUrl')).toBe('api-base-url');
    expect(fieldKeyToFlag('token')).toBe('token');
  });

  it('adapter id + camelCase key → SCREAMING_SNAKE env var', () => {
    expect(fieldKeyToEnvVar('lark', 'appId')).toBe('LARK_APP_ID');
    expect(fieldKeyToEnvVar('lark', 'appSecret')).toBe('LARK_APP_SECRET');
    expect(fieldKeyToEnvVar('tg', 'botToken')).toBe('TG_BOT_TOKEN');
    expect(fieldKeyToEnvVar('wechat', 'token')).toBe('WECHAT_TOKEN');
  });
});
