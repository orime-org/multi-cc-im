import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockLoginLark = vi.hoisted(() => vi.fn());
vi.mock('@multi-cc-im/im-lark', async (importActual) => {
  const actual = await importActual<typeof import('@multi-cc-im/im-lark')>();
  return { ...actual, loginLark: mockLoginLark };
});

const { runLoginLarkCommand } = await import('./login.js');

describe('runLoginLarkCommand', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'login-lark-cli-'));
    mockLoginLark.mockReset();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('happy path: validates + persists credentials, exit 0', async () => {
    mockLoginLark.mockImplementation(async (opts) => {
      const creds = {
        appId: opts.appId,
        appSecret: opts.appSecret,
        savedAt: '2026-05-09T12:00:00.000Z',
      };
      // Simulate the real loginLark behavior — write through the
      // store the runner constructed.
      await opts.credentialStore.save(creds);
      return creds;
    });

    const result = await runLoginLarkCommand({
      root,
      appId: 'cli_test123',
      appSecret: 'secret_abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.credentials).toEqual({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      savedAt: '2026-05-09T12:00:00.000Z',
    });

    // File on disk
    const credFile = join(root, 'credentials', 'lark.json');
    const content = await readFile(credFile, 'utf-8');
    expect(JSON.parse(content)).toEqual({
      appId: 'cli_test123',
      appSecret: 'secret_abc',
      savedAt: '2026-05-09T12:00:00.000Z',
    });
    // mode 0600 (owner read/write only — secret hygiene)
    const stats = await stat(credFile);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('missing app_id → exit 2 with usage message', async () => {
    const result = await runLoginLarkCommand({
      root,
      appId: '',
      appSecret: 'whatever',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/missing app_id/);
    expect(result.stderr).toMatch(/--app-id/);
    expect(result.stderr).toMatch(/LARK_APP_ID/);
    expect(mockLoginLark).not.toHaveBeenCalled();
  });

  it('missing app_secret → exit 2 with usage message', async () => {
    const result = await runLoginLarkCommand({
      root,
      appId: 'cli_x',
      appSecret: '   ', // whitespace-only counts as missing
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/missing app_secret/);
    expect(mockLoginLark).not.toHaveBeenCalled();
  });

  it('Feishu rejects credentials → exit 1 with formatted error', async () => {
    mockLoginLark.mockRejectedValueOnce(
      new Error(
        'lark login failed: Feishu rejected credentials (code=10003, msg=app id not exist)',
      ),
    );

    const result = await runLoginLarkCommand({
      root,
      appId: 'cli_bad',
      appSecret: 'secret',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/code=10003/);
    expect(result.stderr).toMatch(/multi-cc-im login lark:/);
  });

  it('network error → exit 1 with cause-chain message', async () => {
    mockLoginLark.mockRejectedValueOnce(
      new Error(
        'lark login failed (network / SDK error): fetch failed (cause: connect ECONNREFUSED [code=ECONNREFUSED])',
      ),
    );

    const result = await runLoginLarkCommand({
      root,
      appId: 'cli_x',
      appSecret: 'secret',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ECONNREFUSED/);
  });

  it('trims whitespace from inputs before forwarding', async () => {
    mockLoginLark.mockImplementation(async (opts) => {
      const creds = {
        appId: opts.appId,
        appSecret: opts.appSecret,
        savedAt: '2026-05-09T12:00:00.000Z',
      };
      await opts.credentialStore.save(creds);
      return creds;
    });

    const result = await runLoginLarkCommand({
      root,
      appId: '  cli_padded  ',
      appSecret: '\tsecret_padded\n',
    });
    expect(result.exitCode).toBe(0);
    // Verify the SDK got the trimmed strings — the user might paste with
    // trailing whitespace from a copy-paste, which would silently fail
    // Feishu validation otherwise.
    expect(mockLoginLark).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_padded',
        appSecret: 'secret_padded',
      }),
    );
  });

  it('respects MULTI_CC_IM_HOME via root override', async () => {
    mockLoginLark.mockImplementation(async (opts) => {
      const creds = {
        appId: opts.appId,
        appSecret: opts.appSecret,
        savedAt: '2026-05-09T12:00:00.000Z',
      };
      await opts.credentialStore.save(creds);
      return creds;
    });

    const result = await runLoginLarkCommand({
      root,
      appId: 'cli_x',
      appSecret: 'secret',
    });
    expect(result.exitCode).toBe(0);
    // Saved file lives under the sandbox root, not the real home dir.
    const credFile = join(root, 'credentials', 'lark.json');
    await expect(readFile(credFile, 'utf-8')).resolves.toContain('cli_x');
  });
});
