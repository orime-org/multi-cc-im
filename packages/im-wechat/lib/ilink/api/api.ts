import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Dispatcher } from "undici";

import { loadConfigRouteTag } from "../auth/accounts.js";
import { logger } from "../util/logger.js";
import { redactBody, redactUrl } from "../util/redact.js";

import type {
  BaseInfo,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Long-poll timeout for getUpdates (server may hold the request up to this). */
  longPollTimeoutMs?: number;
  /**
   * Optional undici Dispatcher for IP health-probed routing.
   * Per [DD: iLink dispatcher health probe](../../../../docs/superpowers/specs/2026-05-08-ilink-dispatcher-health-probe-dd.md):
   * use `createHealthProbedDispatcher()` from `./dispatcher.js` to bind only
   * to healthy LB backend IPs (avoids 5s TLS hang on Tencent's known-dead
   * `43.171.*` IPs). When omitted, falls back to global fetch (relies on
   * `apiPostFetch` transient retry as backstop).
   */
  dispatcher?: Dispatcher;
};

// ---------------------------------------------------------------------------
// BaseInfo — attached to every outgoing CGI request
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

function readPackageJson(): PackageJson {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    return {};
  }
}

const pkg = readPackageJson();

const CHANNEL_VERSION = pkg.version ?? "unknown";

/** iLink-App-Id: 直接读取 package.json 顶层 ilink_appid 字段。 */
const ILINK_APP_ID: string = pkg.ilink_appid ?? "";

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(pkg.version ?? "0.0.0");

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  const routeTag = loadConfigRouteTag();
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  logger.debug(
    `requestHeaders: ${JSON.stringify({ ...headers, Authorization: headers.Authorization ? "Bearer ***" : undefined })}`,
  );
  return headers;
}

/**
 * GET fetch wrapper: send a GET request to a Weixin API endpoint.
 * When `timeoutMs` is set, the request is aborted after that many milliseconds.
 * Query parameters should already be encoded in `endpoint`.
 * Returns the raw response text on success; throws on HTTP error or (if used) timeout abort.
 */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
  dispatcher?: Dispatcher;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  logger.debug(`GET ${redactUrl(url.toString())}`);

  const timeoutMs = params.timeoutMs;
  const controller =
    timeoutMs != null && timeoutMs > 0 ? new AbortController() : undefined;
  const t =
    controller != null && timeoutMs != null
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
      ...(params.dispatcher ? { dispatcher: params.dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });
    if (t !== undefined) clearTimeout(t);
    const rawText = await res.text();
    logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    if (t !== undefined) clearTimeout(t);
    throw err;
  }
}

/**
 * Transient TCP/network error codes worth retrying. These come from
 * undici / Node's net layer; they typically mean "connection didn't even
 * complete TLS handshake" or "server reset us mid-flight" — either way
 * the request never reached server-side application logic, so retrying
 * the same body is safe (idempotent at the protocol level).
 *
 * HTTP-level errors (4xx / 5xx response bodies) are NOT retried — the
 * server actually saw the request and gave a deterministic answer.
 */
const TRANSIENT_NET_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET", // undici-specific socket error
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Walk the error chain (undici nests the underlying network error in
 * `.cause`) and return the first transient code encountered, or undefined.
 */
function extractTransientCode(err: unknown): string | undefined {
  let cur: unknown = err;
  let depth = 0;
  while (cur instanceof Error && depth < 5) {
    const code = (cur as Error & { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NET_CODES.has(code)) {
      return code;
    }
    cur = (cur as Error & { cause?: unknown }).cause;
    depth++;
  }
  return undefined;
}

/** Backoff delays for retries: 200ms, 500ms (total max extra ~700ms). */
const RETRY_DELAYS_MS = [200, 500] as const;

/** Sleep helper that does not depend on `node:timers/promises` (kept simple). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint with timeout + abort.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 *
 * **Transient retry** (DD doc: PR-F):
 * - Retries up to 2 times on `ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` /
 *   `ENOTFOUND` / `ENETUNREACH` / `EHOSTUNREACH` / `EPIPE` /
 *   `UND_ERR_SOCKET` / `UND_ERR_CONNECT_TIMEOUT`. Backoff 200ms / 500ms.
 * - HTTP 4xx / 5xx are NOT retried (deterministic server answer; retry would
 *   yield the same response and waste time).
 * - AbortController timeout is reset per attempt so a slow server still gets
 *   the full `timeoutMs` budget per try (not split across retries).
 * - Idempotent against duplicate sends: callers (sendMessage / sendImage /
 *   sendFile) generate `client_id` once per outer call before reaching here,
 *   so retries reuse the same `client_id` and the iLink server can dedupe.
 */
async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  dispatcher?: Dispatcher;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });
  logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);

  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: hdrs,
        body: params.body,
        signal: controller.signal,
        ...(params.dispatcher ? { dispatcher: params.dispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher });
      clearTimeout(t);
      const rawText = await res.text();
      logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
      if (!res.ok) {
        // HTTP error — server-side deterministic, do not retry.
        throw new Error(`${params.label} ${res.status}: ${rawText}`);
      }
      return rawText;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      const code = extractTransientCode(err);
      if (code === undefined) {
        // Non-transient (HTTP error / abort / unknown) — bail immediately.
        throw err;
      }
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) {
        logger.warn(
          `${params.label}: ${code} after ${maxAttempts} attempts — giving up`,
        );
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt]!;
      logger.debug(
        `${params.label}: transient ${code}, retry ${attempt + 1}/${maxAttempts - 1} in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  // Unreachable — loop either returns or throws — but TS can't see that.
  throw lastErr;
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    dispatcher?: Dispatcher;
  },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiPostFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      dispatcher: params.dispatcher,
    });
    const resp: GetUpdatesResp = JSON.parse(rawText);
    return resp;
  } catch (err) {
    // Long-poll timeout is normal; return empty response so caller can retry
    if (err instanceof Error && err.name === "AbortError") {
      logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
    dispatcher: params.dispatcher,
  });
  const resp: GetUploadUrlResp = JSON.parse(rawText);
  return resp;
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
    dispatcher: params.dispatcher,
  });
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
    dispatcher: params.dispatcher,
  });
  const resp: GetConfigResp = JSON.parse(rawText);
  return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
    dispatcher: params.dispatcher,
  });
}
