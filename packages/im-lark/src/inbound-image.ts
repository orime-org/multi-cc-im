import { writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { TenantTokenStore } from './tenant-token.js';

/**
 * Default cap on a single downloaded resource. Matches Feishu's per-message
 * upload limit so a saturated upload is the largest legitimate inbound;
 * anything above this is treated as a transport bug and rejected.
 */
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;

function resourceUrl(messageId: string, key: string, type: 'image' | 'file'): string {
  return (
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
    `/resources/${encodeURIComponent(key)}?type=${type}`
  );
}

export interface DownloadAttachmentOpts {
  /** Lark `app_id` — fed to {@link tenantTokenStore} for Bearer token resolution. */
  appId: string;
  /** Lark `app_secret` — fed to {@link tenantTokenStore}. */
  appSecret: string;
  /**
   * Shared tenant-token cache (typically the same instance the cardkit
   * client uses) — keeps both auth paths riding one rotation window.
   */
  tenantTokenStore: TenantTokenStore;
  /**
   * Absolute directory the file will be saved to. Created (recursive,
   * mode 0700) if missing. Daemon resolves this from `inboundFor('lark')`
   * + `/images`.
   */
  outDir: string;
  /** Override `fetch` (tests inject a stub matching the standard signature). */
  fetchImpl?: typeof fetch;
  /** Override `Date.now()` — tests use a deterministic clock to assert filenames. */
  now?: () => number;
  /** Override the 30 MB ceiling — tests use a low value to assert rejection. */
  maxBytes?: number;
}

export interface DownloadedAttachment {
  /** Absolute path of the saved file (`<outDir>/<ts>-<safeName>`). */
  localPath: string;
  /** Byte count of the saved file. */
  bytes: number;
  /** Server-supplied `Content-Type` (e.g. `image/png`); undefined when header is missing. */
  mimetype?: string;
}

/**
 * Download a Feishu message resource (image / file) to local disk.
 *
 * `GET /open-apis/im/v1/messages/{messageId}/resources/{key}?type={type}` with
 * `Authorization: Bearer <tenant_access_token>` (resolved via shared
 * {@link TenantTokenStore}), then saves the body to
 * `<outDir>/<timestamp>-<safeName>`. The 30 MB ceiling shields the bridge
 * from accidental large uploads — Feishu's own per-message cap is 30 MB so
 * this matches upstream.
 *
 * Filename safety: when callers provide a `name` we keep `basename(name)` and
 * replace any char outside `[A-Za-z0-9._-]` with `_`. Empty after sanitization
 * falls back to `attachment.png` (image) or `attachment` (file). The
 * timestamp prefix prevents collisions across rapid sends.
 *
 * Per [DD: IM image to cc §2.B](../../../docs/superpowers/specs/2026-05-19-im-image-to-cc-dd.md)
 * — pattern adapted from lodestar `feishu.ts:324-348` (MIT) but rewritten
 * with strict TS + DI so tests can drive without a real Feishu app.
 */
export async function downloadAttachment(
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  name: string | undefined,
  opts: DownloadAttachmentOpts,
): Promise<DownloadedAttachment> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  await mkdir(opts.outDir, { recursive: true, mode: 0o700 });

  const token = await opts.tenantTokenStore.getToken(opts.appId, opts.appSecret);
  const res = await fetchImpl(resourceUrl(messageId, fileKey, type), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      `downloadAttachment ${messageId} ${type}: HTTP ${res.status} ${res.statusText || '?'}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(
      `downloadAttachment ${messageId} ${type}: size ${buf.length} bytes exceeds cap ${maxBytes}`,
    );
  }
  const mimeRaw = res.headers.get('content-type');
  const mimetype = mimeRaw === null ? undefined : mimeRaw;
  const safeName = sanitizeName(name) ?? defaultName(type);
  const localPath = join(opts.outDir, `${now()}-${safeName}`);
  await writeFile(localPath, buf, { mode: 0o600 });
  return { localPath, bytes: buf.length, mimetype };
}

function sanitizeName(name: string | undefined): string | undefined {
  if (name === undefined || name.length === 0) return undefined;
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  return base.length > 0 && base !== '_' && base !== '.' && base !== '..' ? base : undefined;
}

function defaultName(type: 'image' | 'file'): string {
  return type === 'image' ? 'attachment.png' : 'attachment';
}
