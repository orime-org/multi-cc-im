import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock crypto for deterministic headers
vi.mock("node:crypto", () => ({
  default: {
    randomBytes: vi.fn(() => ({
      readUInt32BE: () => 12345,
      toString: () => "deadbeef",
    })),
  },
}));

import { getUpdates, getUploadUrl, sendMessage, getConfig, sendTyping } from "./api.js";

function mockResponse(body: object | string, status = 200, ok = true): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(text),
    headers: new Headers(),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUpdates", () => {
  it("returns parsed response on success", async () => {
    const resp = { ret: 0, msgs: [{ seq: 1 }], get_updates_buf: "buf" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "old-buf",
      token: "tok",
    });
    expect(result.ret).toBe(0);
    expect(result.msgs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("ilink/bot/getupdates");
    expect(opts.method).toBe("POST");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("err", 500, false));
    await expect(getUpdates({ baseUrl: "https://api.example.com" })).rejects.toThrow("getUpdates 500");
  });

  it("returns empty response on abort/timeout", async () => {
    const abortErr = new Error("AbortError");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortErr);
    const result = await getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "buf",
      timeoutMs: 100,
    });
    expect(result.ret).toBe(0);
    expect(result.get_updates_buf).toBe("buf");
  });

  it("re-throws non-abort errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    await expect(getUpdates({ baseUrl: "https://api.example.com" })).rejects.toThrow("network error");
  });

  it("adds trailing slash to baseUrl", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await getUpdates({ baseUrl: "https://api.example.com" });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("https://api.example.com/ilink/bot/getupdates");
  });
});

describe("getUploadUrl", () => {
  it("returns parsed response on success", async () => {
    const resp = { upload_param: "param", thumb_upload_param: "tparam" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getUploadUrl({
      baseUrl: "https://api.example.com/",
      filekey: "fk",
      media_type: 1,
      to_user_id: "user1",
      rawsize: 100,
      rawfilemd5: "md5",
      filesize: 112,
    });
    expect(result.upload_param).toBe("param");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("fail", 400, false));
    await expect(
      getUploadUrl({ baseUrl: "https://api.example.com/" }),
    ).rejects.toThrow("getUploadUrl 400");
  });
});

describe("sendMessage", () => {
  it("succeeds on ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("") } as Response);
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: { to_user_id: "u" } } }),
    ).resolves.toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("error", 403, false));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow("sendMessage 403");
  });
});

describe("getConfig", () => {
  it("returns parsed response", async () => {
    const resp = { ret: 0, typing_ticket: "ticket" };
    mockFetch.mockResolvedValueOnce(mockResponse(resp));
    const result = await getConfig({
      baseUrl: "https://api.example.com/",
      ilinkUserId: "user1",
    });
    expect(result.typing_ticket).toBe("ticket");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("fail", 500, false));
    await expect(
      getConfig({ baseUrl: "https://api.example.com/", ilinkUserId: "u" }),
    ).rejects.toThrow("getConfig 500");
  });
});

describe("sendTyping", () => {
  it("succeeds on ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendTyping({
        baseUrl: "https://api.example.com/",
        body: { ilink_user_id: "u", typing_ticket: "t", status: 1 },
      }),
    ).resolves.toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("err", 500, false));
    await expect(
      sendTyping({ baseUrl: "https://api.example.com/", body: {} }),
    ).rejects.toThrow("sendTyping 500");
  });
});

describe("apiPostFetch transient retry (PR-F: ECONNRESET / undici socket errors)", () => {
  /**
   * Build an Error mimicking what Node 22 fetch surfaces on TCP-level
   * network failures: outer is a generic `fetch failed` Error with the
   * underlying TypeError (or NodeError) on `.cause`, which itself carries
   * the `.code` like 'ECONNRESET'.
   */
  function makeTransientFetchError(code: string): Error {
    const cause = new Error(`Client network socket disconnected before secure TLS connection was established`);
    (cause as Error & { code?: string }).code = code;
    const outer = new Error("fetch failed");
    (outer as Error & { cause?: unknown }).cause = cause;
    return outer;
  }

  it("ECONNRESET on first attempt → retries, second attempt succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: { to_user_id: "u" } } }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("ECONNRESET twice → retries again, third attempt succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("ECONNRESET 3 times in a row → gives up, throws original error with cause", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow("fetch failed");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("HTTP 500 → does NOT retry (deterministic server answer)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("server bad", 500, false));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow("sendMessage 500");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("HTTP 4xx → does NOT retry", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse("forbidden", 403, false));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow("sendMessage 403");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("AbortError (caller-side timeout) → does NOT retry", async () => {
    const abort = new Error("AbortError");
    abort.name = "AbortError";
    // No .code → not transient.
    mockFetch.mockRejectedValueOnce(abort);
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retry reuses same body (idempotent — caller's client_id stays stable across retries)", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("ECONNRESET"))
      .mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await sendMessage({
      baseUrl: "https://api.example.com/",
      body: { msg: { client_id: "stable-client-id-12345", to_user_id: "u" } },
    });
    const [, opts1] = mockFetch.mock.calls[0];
    const [, opts2] = mockFetch.mock.calls[1];
    // Both attempts send the SAME body — server can dedupe by client_id.
    expect(opts1.body).toBe(opts2.body);
    expect(opts1.body).toContain("stable-client-id-12345");
  });

  it("retry uses fresh AbortController (slow server gets full timeoutMs per attempt, not split)", async () => {
    // First attempt's signal is aborted by the test (simulating mid-flight RST).
    // The retry's fetch must receive a NEW signal, not the already-aborted one.
    const signals: AbortSignal[] = [];
    mockFetch.mockImplementation((url, opts) => {
      signals.push(opts.signal);
      if (signals.length === 1) {
        return Promise.reject(makeTransientFetchError("ECONNRESET"));
      }
      return Promise.resolve(mockResponse({ ret: 0 }));
    });
    await sendMessage({
      baseUrl: "https://api.example.com/",
      body: { msg: {} },
    });
    expect(signals).toHaveLength(2);
    // Second attempt's signal is fresh — not yet aborted.
    expect(signals[1].aborted).toBe(false);
  });

  it("undici-specific UND_ERR_SOCKET → also retried", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("UND_ERR_SOCKET"))
      .mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("ETIMEDOUT (connect-level) → retried", async () => {
    mockFetch
      .mockRejectedValueOnce(makeTransientFetchError("ETIMEDOUT"))
      .mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await expect(
      sendMessage({ baseUrl: "https://api.example.com/", body: { msg: {} } }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Forbidden request headers (per fetch spec). undici 8 / Node 22 native fetch
// strictly reject any user-set Content-Length / Host / Connection / etc.
// (`UND_ERR_INVALID_ARG: invalid content-length header`). Vendor upstream
// (Tencent OpenClaw v2.1.7) historically set Content-Length manually — this
// regressed under Node 22 and broke long-poll outright. See VENDOR.md
// "Downstream patches".
// ============================================================================

describe("buildHeaders — forbidden request headers", () => {
  function getOutgoingHeaders(): Record<string, string> {
    expect(mockFetch).toHaveBeenCalled();
    const [, opts] = mockFetch.mock.calls[0]!;
    return (opts as { headers: Record<string, string> }).headers;
  }

  it("getUpdates POST: outgoing headers MUST NOT contain Content-Length", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0, msgs: [] }));
    await getUpdates({
      baseUrl: "https://api.example.com",
      get_updates_buf: "buf",
      token: "tok",
    });
    const headers = getOutgoingHeaders();
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
  });

  it("sendMessage POST: outgoing headers MUST NOT contain Content-Length", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await sendMessage({
      baseUrl: "https://api.example.com/",
      body: { msg: { content: "hi" } },
    });
    const headers = getOutgoingHeaders();
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
  });

  it("getConfig POST: outgoing headers MUST NOT contain Content-Length", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ret: 0, typing_ticket: "t", reply_ticket_v2: "r" }),
    );
    await getConfig({
      baseUrl: "https://api.example.com/",
      ilinkUserId: "uid",
    });
    const headers = getOutgoingHeaders();
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
  });

  it("sendTyping POST: outgoing headers MUST NOT contain Content-Length", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await sendTyping({
      baseUrl: "https://api.example.com/",
      body: { typing_ticket: "t", to_user_id: "u", typing: true },
    });
    const headers = getOutgoingHeaders();
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["content-length"]).toBeUndefined();
  });

  it("Content-Type still set to application/json (fetch-allowed header)", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ret: 0 }));
    await sendMessage({
      baseUrl: "https://api.example.com/",
      body: { msg: { content: "hi" } },
    });
    const headers = getOutgoingHeaders();
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
