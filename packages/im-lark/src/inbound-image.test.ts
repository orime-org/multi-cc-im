import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadAttachment } from './inbound-image.js';
import type { TenantTokenStore } from './tenant-token.js';

function fakeStore(token: string): TenantTokenStore {
  return {
    async getToken() {
      return token;
    },
    clear() {},
  };
}

function okResponse(buf: Uint8Array, mimetype?: string): Response {
  const headers = new Headers();
  if (mimetype !== undefined) headers.set('content-type', mimetype);
  return new Response(buf, { status: 200, statusText: 'OK', headers });
}

describe('downloadAttachment', () => {
  it('happy path — fetches via Bearer auth, saves to <outDir>/<ts>-<safeName>', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let capturedUrl = '';
    let capturedAuth: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedAuth =
        (init?.headers as Record<string, string> | undefined)?.[
          'Authorization'
        ] ?? null;
      return okResponse(bytes, 'image/png');
    };
    const result = await downloadAttachment(
      'om_msg_001',
      'img_v3_abc',
      'image',
      undefined,
      {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('tt_xyz'),
        outDir,
        fetchImpl,
        now: () => 1700000000000,
      },
    );
    expect(capturedUrl).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_msg_001/resources/img_v3_abc?type=image',
    );
    expect(capturedAuth).toBe('Bearer tt_xyz');
    expect(result.localPath).toBe(join(outDir, '1700000000000-attachment.png'));
    expect(result.bytes).toBe(5);
    expect(result.mimetype).toBe('image/png');
    expect(Array.from(readFileSync(result.localPath))).toEqual([1, 2, 3, 4, 5]);
  });

  it('size > maxBytes → throws and does not write the file', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array(20);
    const fetchImpl: typeof fetch = async () => okResponse(bytes, 'image/png');
    await expect(
      downloadAttachment('om_big', 'img_big', 'image', undefined, {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
        maxBytes: 5,
      }),
    ).rejects.toThrow(/exceeds cap 5/);
  });

  it('HTTP non-2xx with non-JSON body → throws with status + raw body excerpt', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const fetchImpl: typeof fetch = async () =>
      new Response('forbidden — not your app', {
        status: 403,
        statusText: 'Forbidden',
      });
    await expect(
      downloadAttachment('om_403', 'img_403', 'image', undefined, {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 403.*body=forbidden — not your app/);
  });

  it('HTTP 400 with Feishu JSON body → throws with parsed code + msg (diagnoses 234XXX subcode)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ code: 234004, msg: 'app not in chat', data: {} }),
        {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        },
      );
    await expect(
      downloadAttachment('om_400', 'img_400', 'image', undefined, {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 400.*code=234004 msg="app not in chat"/);
  });

  it('HTTP non-2xx with empty body → throws with just status (no trailing junk)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const fetchImpl: typeof fetch = async () =>
      new Response('', { status: 500, statusText: 'Internal Server Error' });
    await expect(
      downloadAttachment('om_500', 'img_500', 'image', undefined, {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/^downloadAttachment om_500 image: HTTP 500 Internal Server Error$/);
  });

  it('name with unsafe chars → replaced with _, runs collapsed', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array([9]);
    const fetchImpl: typeof fetch = async () => okResponse(bytes);
    const result = await downloadAttachment(
      'om_1',
      'k',
      'file',
      'bad file  & name $.txt',
      {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
        now: () => 42,
      },
    );
    expect(result.localPath).toBe(join(outDir, '42-bad_file_name_.txt'));
  });

  it('name with path-traversal segments → basename strips dir, no /etc escape', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array([1]);
    const fetchImpl: typeof fetch = async () => okResponse(bytes);
    const result = await downloadAttachment(
      'om_1',
      'k',
      'file',
      '../../etc/passwd.txt',
      {
        appId: 'cli_app',
        appSecret: 'sec',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
        now: () => 7,
      },
    );
    expect(result.localPath).toBe(join(outDir, '7-passwd.txt'));
  });

  it('empty / fully-sanitized-away name → falls back to attachment[.png|]', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array([0]);
    const fetchImpl: typeof fetch = async () => okResponse(bytes);

    const r1 = await downloadAttachment('om_1', 'k', 'image', '', {
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeStore('t'),
      outDir,
      fetchImpl,
      now: () => 1,
    });
    expect(r1.localPath).toBe(join(outDir, '1-attachment.png'));

    const r2 = await downloadAttachment('om_2', 'k', 'file', '   ', {
      appId: 'a',
      appSecret: 's',
      tenantTokenStore: fakeStore('t'),
      outDir,
      fetchImpl,
      now: () => 2,
    });
    expect(r2.localPath).toBe(join(outDir, '2-attachment'));
  });

  it('creates outDir recursively when missing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const outDir = join(base, 'deep', 'nested', 'lark', 'images');
    const bytes = new Uint8Array([7, 7, 7]);
    const fetchImpl: typeof fetch = async () => okResponse(bytes);
    const result = await downloadAttachment(
      'om_1',
      'k',
      'image',
      undefined,
      {
        appId: 'a',
        appSecret: 's',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
        now: () => 99,
      },
    );
    expect(statSync(result.localPath).size).toBe(3);
  });

  it('saved file is mode 0600 (defense in depth — sensitive screenshots)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'inbox-img-'));
    const bytes = new Uint8Array([1]);
    const fetchImpl: typeof fetch = async () => okResponse(bytes);
    const result = await downloadAttachment(
      'om_1',
      'k',
      'image',
      undefined,
      {
        appId: 'a',
        appSecret: 's',
        tenantTokenStore: fakeStore('t'),
        outDir,
        fetchImpl,
        now: () => 1,
      },
    );
    const mode = statSync(result.localPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
