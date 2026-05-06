import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoginWechatCommand } from './login.js';

const mockLoginWechat = vi.hoisted(() => vi.fn());
vi.mock('@multi-cc-im/im-wechat', async () => {
  const actual = await vi.importActual<
    typeof import('@multi-cc-im/im-wechat')
  >('@multi-cc-im/im-wechat');
  return {
    ...actual,
    loginWechat: mockLoginWechat,
  };
});

beforeEach(() => {
  mockLoginWechat.mockReset();
});

describe('runLoginWechatCommand', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'login-cli-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('successful login → credential file written + exit 0', async () => {
    mockLoginWechat.mockImplementation(async ({ credentialStore }) => {
      const creds = { token: 'tok-abc', savedAt: '2026-05-04T00:00:00Z' };
      await credentialStore.save(creds);
      return creds;
    });

    const result = await runLoginWechatCommand({
      root,
      output: { renderQR: () => {}, println: () => {} },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const path = join(root, 'credentials', 'wechat.json');
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    expect(raw.token).toBe('tok-abc');
  });

  it('login failure → exit 1 + stderr contains error', async () => {
    mockLoginWechat.mockRejectedValue(
      new Error('wechat login failed: login timeout'),
    );
    const result = await runLoginWechatCommand({
      root,
      output: { renderQR: () => {}, println: () => {} },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/login timeout|login failed/);
  });

  it('forwards LoginOutput to im-wechat loginWechat', async () => {
    const renderedQR: string[] = [];
    const lines: string[] = [];
    mockLoginWechat.mockImplementation(async ({ output }) => {
      output.renderQR('https://example.com/qr');
      output.println('please scan QR');
      return { token: 't', savedAt: 'x' };
    });
    await runLoginWechatCommand({
      root,
      output: {
        renderQR: (u) => renderedQR.push(u),
        println: (m) => lines.push(m),
      },
    });
    expect(renderedQR).toEqual(['https://example.com/qr']);
    expect(lines).toContain('please scan QR');
  });
});
