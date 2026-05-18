/**
 * Feishu Card Kit v1 client — raw REST wrapper for sending and
 * mutating interactive cards over WebSocket-delivered events.
 *
 * Endpoints used (base = `https://open.feishu.cn/open-apis/cardkit/v1`):
 *
 * | Method | Path | Purpose |
 * | --- | --- | --- |
 * | POST   | `/cards/id_convert`                                     | message_id → card_id |
 * | POST   | `/cards`                                                | create card entity from card JSON |
 * | PUT    | `/cards/:card_id/elements/:element_id/content`          | stream text content (typewriter on prefix match) |
 * | POST   | `/cards/:card_id/elements`                              | add element (append / insert_before / insert_after) |
 * | PUT    | `/cards/:card_id/elements/:element_id`                  | replace element |
 * | DELETE | `/cards/:card_id/elements/:element_id`                  | remove element |
 * | PATCH  | `/cards/:card_id/settings`                              | toggle streaming_mode etc. |
 *
 * **Invariants per `card_id`**:
 * - `sequence` is monotonically increasing per card; Feishu rejects
 *   out-of-order writes with code `300317` ("sequence number compare
 *   failed"). We use a per-card counter and allocate the seq at
 *   execution time inside a Promise queue (NOT at enqueue time —
 *   mixing leads to interleaving bugs; see `patchSettings` JSDoc).
 * - All writes for a given `card_id` are serialized through that
 *   per-card queue so concurrent callers can't race the seq.
 * - Text-streaming PUTs are batched on a 120ms timer + 32-char delta
 *   heuristic to stay under Card Kit's per-card rate ceiling.
 *
 * **Streaming TTL** (10 minutes from `streaming_mode=true` settings
 * patch): Feishu silently closes the streaming session after 10 min
 * regardless of activity. Writes after close return code `300309`
 * "streaming mode is closed" or `200850` "card streaming timeout".
 * We catch both, reopen `streaming_mode` inline, and retry the failed
 * op exactly once before giving up (logged + onFailure callback if
 * provided — never throws back into the caller, since cardkit ops are
 * fire-and-forget from the bridge's perspective).
 *
 * Pattern adapted from [lodestar](https://github.com/leviyuan/lodestar)
 * (MIT) `src/cardkit.ts` — rewritten TS-strict with factory + DI so
 * tests don't share module state. Per
 * [β.MVP P1](../../../docs/superpowers/specs/2026-05-18-multi-cc-im-vs-lodestar-strategic-dd.md)
 * (DD 2026-05-18).
 */

import type { TenantTokenStore } from './tenant-token.js';

const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis/cardkit/v1';
const DEFAULT_FLUSH_INTERVAL_MS = 120;
const DEFAULT_FLUSH_MIN_DELTA = 32;
const DEFAULT_SUMMARY_FLUSH_MS = 1500;

/** Feishu error codes that indicate the streaming session has closed and
 * should be reopened. */
const STREAMING_CLOSED_CODES = new Set([300309, 200850]);

/**
 * Card Kit element insertion mode. `append` is default and most common
 * (add to end); `insert_before` / `insert_after` are for inserting
 * relative to a sibling identified by `targetElementId`.
 */
export type AddElementMode = 'append' | 'insert_before' | 'insert_after';

interface CardState {
  sequence: number;
  queue: Promise<void>;
  /** Latest full text per element_id (the streaming target). */
  buffer: Map<string, string>;
  /** Last text actually PUT — used to skip no-op writes. */
  lastSent: Map<string, string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface SummaryState {
  latest: string;
  lastSent: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CreateCardKitClientOpts {
  /** Lark `app_id` — fed to `tenantTokenStore` for token resolution. */
  appId: string;
  /** Lark `app_secret`. */
  appSecret: string;
  /** Tenant token cache (typically shared across cardkit + other raw REST). */
  tenantTokenStore: TenantTokenStore;
  /**
   * Override the HTTP transport. Tests pass a stub matching `fetch`.
   * Default = global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /**
   * Override the diagnostic logger. Default = no-op so unit tests stay
   * silent. Production daemon injects its dual-write stderr+file sink.
   */
  log?: (line: string) => void;
  /**
   * Override the Card Kit base URL. Default
   * `https://open.feishu.cn/open-apis/cardkit/v1`. Tests point at a
   * stub server.
   */
  baseUrl?: string;
  /** Text-streaming flush interval (ms). Default 120. */
  flushIntervalMs?: number;
  /** Text-streaming flush delta threshold (chars). Default 32. */
  flushMinDelta?: number;
  /** Summary patch coalesce window (ms). Default 1500. */
  summaryFlushMs?: number;
}

export interface CardKitClient {
  /** Convert a sent interactive message into a card entity (gives us a card_id). */
  convertMessageToCard(messageId: string): Promise<string>;
  /** Create a card entity from raw schema-2.0 card JSON. */
  createCardEntity(card: object): Promise<string>;
  /** PUT element content (full text) — triggers typewriter on prefix-match. */
  streamText(cardId: string, elementId: string, content: string): Promise<void>;
  /** Buffered streaming: auto-flushes on timer or delta-threshold. */
  streamTextThrottled(cardId: string, elementId: string, fullContent: string): void;
  /** Force flush any buffered streams for this card. */
  flush(cardId: string): Promise<void>;
  /** Add an element to the card body (or relative to a sibling). */
  addElement(
    cardId: string,
    element: object,
    opts?: { type?: AddElementMode; targetElementId?: string },
    onFailure?: () => void,
  ): Promise<void>;
  /** Replace an entire element (e.g. swap a tool placeholder with its result). */
  replaceElement(cardId: string, elementId: string, element: object): Promise<void>;
  /** Delete an element by id. */
  deleteElement(cardId: string, elementId: string): Promise<void>;
  /** Patch card settings (toggle streaming_mode etc.). */
  patchSettings(cardId: string, settings: object): Promise<void>;
  /** Throttled card-summary update (the chat-list preview text). */
  patchSummaryThrottled(cardId: string, content: string): void;
  /** Cancel pending throttled summary write (call before emitting terminal summary). */
  cancelSummary(cardId: string): void;
  /** Drop in-memory bookkeeping for a finished card. */
  dispose(cardId: string): Promise<void>;
}

/**
 * Factory — creates a fresh `CardKitClient` with isolated state.
 * Unit tests get their own client per test; production daemon owns
 * one client for the whole process lifetime.
 */
export function createCardKitClient(opts: CreateCardKitClientOpts): CardKitClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const flushMinDelta = opts.flushMinDelta ?? DEFAULT_FLUSH_MIN_DELTA;
  const summaryFlushMs = opts.summaryFlushMs ?? DEFAULT_SUMMARY_FLUSH_MS;

  const cards = new Map<string, CardState>();
  const summaryStates = new Map<string, SummaryState>();

  function state(cardId: string): CardState {
    let s = cards.get(cardId);
    if (!s) {
      s = {
        sequence: 0,
        queue: Promise.resolve(),
        buffer: new Map(),
        lastSent: new Map(),
        flushTimer: null,
      };
      cards.set(cardId, s);
    }
    return s;
  }

  function nextSeq(cardId: string): number {
    const s = state(cardId);
    s.sequence += 1;
    return s.sequence;
  }

  async function call(method: string, path: string, body?: object): Promise<unknown> {
    const token = await opts.tenantTokenStore.getToken(opts.appId, opts.appSecret);
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as { code?: number; msg?: string; data?: unknown };
    if (json.code != null && json.code !== 0) {
      const err = new Error(
        `cardkit ${method} ${path}: code=${json.code} msg=${json.msg ?? '?'}`,
      ) as Error & { code: number };
      err.code = json.code;
      throw err;
    }
    return json.data;
  }

  function isStreamingClosed(e: unknown): boolean {
    if (typeof e !== 'object' || e === null) return false;
    const code = (e as { code?: unknown }).code;
    return typeof code === 'number' && STREAMING_CLOSED_CODES.has(code);
  }

  async function reopenStreaming(cardId: string): Promise<void> {
    const seq = nextSeq(cardId);
    await call('PATCH', `/cards/${cardId}/settings`, {
      settings: JSON.stringify({ config: { streaming_mode: true } }),
      sequence: seq,
    });
  }

  async function withReopenOnStreamingClosed(
    cardId: string,
    label: string,
    op: () => Promise<void>,
    onFailure?: () => void,
  ): Promise<void> {
    try {
      await op();
      return;
    } catch (e) {
      if (!isStreamingClosed(e)) {
        log(`cardkit ${label} ${cardId}: ${e instanceof Error ? e.message : String(e)}`);
        if (onFailure) onFailure();
        return;
      }
      log(`cardkit ${label} ${cardId}: streaming closed — reopening`);
    }
    try {
      await reopenStreaming(cardId);
    } catch (re) {
      log(
        `cardkit STREAMING_REOPEN_FAILED ${cardId}: ${re instanceof Error ? re.message : String(re)}`,
      );
      if (onFailure) onFailure();
      return;
    }
    try {
      await op();
    } catch (e2) {
      log(
        `cardkit ${label} ${cardId} retry-after-reopen: ${e2 instanceof Error ? e2.message : String(e2)}`,
      );
      if (onFailure) onFailure();
    }
  }

  async function convertMessageToCard(messageId: string): Promise<string> {
    const data = (await call('POST', '/cards/id_convert', {
      message_id: messageId,
    })) as { card_id: string };
    return data.card_id;
  }

  async function createCardEntity(card: object): Promise<string> {
    const data = (await call('POST', '/cards', {
      type: 'card_json',
      data: JSON.stringify(card),
    })) as { card_id: string };
    return data.card_id;
  }

  function streamText(cardId: string, elementId: string, content: string): Promise<void> {
    if (!content || !content.trim()) return Promise.resolve();
    const s = state(cardId);
    s.queue = s.queue.then(() =>
      withReopenOnStreamingClosed(cardId, `streamText ${elementId}`, async () => {
        const seq = nextSeq(cardId);
        await call('PUT', `/cards/${cardId}/elements/${elementId}/content`, {
          content,
          sequence: seq,
        });
        s.lastSent.set(elementId, content);
      }),
    );
    return s.queue;
  }

  function streamTextThrottled(cardId: string, elementId: string, fullContent: string): void {
    if (!fullContent || !fullContent.trim()) return;
    const s = state(cardId);
    s.buffer.set(elementId, fullContent);

    const last = s.lastSent.get(elementId) ?? '';
    const delta = fullContent.length - last.length;
    if (delta >= flushMinDelta) {
      flush(cardId).catch((e) =>
        log(`cardkit flush(min-delta) ${cardId}: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    if (!s.flushTimer) {
      s.flushTimer = setTimeout(() => {
        flush(cardId).catch((e) =>
          log(`cardkit flush(timer) ${cardId}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }, flushIntervalMs);
    }
  }

  async function flush(cardId: string): Promise<void> {
    const s = cards.get(cardId);
    if (!s) return;
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    const pending = [...s.buffer.entries()];
    s.buffer.clear();
    for (const [eid, text] of pending) {
      if (s.lastSent.get(eid) === text) continue;
      await streamText(cardId, eid, text);
    }
  }

  function addElement(
    cardId: string,
    element: object,
    elemOpts: { type?: AddElementMode; targetElementId?: string } = {},
    onFailure?: () => void,
  ): Promise<void> {
    const s = state(cardId);
    s.queue = s.queue.then(() =>
      withReopenOnStreamingClosed(
        cardId,
        'addElement',
        async () => {
          const seq = nextSeq(cardId);
          await call('POST', `/cards/${cardId}/elements`, {
            type: elemOpts.type ?? 'append',
            ...(elemOpts.targetElementId
              ? { target_element_id: elemOpts.targetElementId }
              : {}),
            elements: JSON.stringify([element]),
            sequence: seq,
          });
        },
        onFailure,
      ),
    );
    return s.queue;
  }

  function replaceElement(cardId: string, elementId: string, element: object): Promise<void> {
    const s = state(cardId);
    s.queue = s.queue.then(() =>
      withReopenOnStreamingClosed(cardId, `replaceElement ${elementId}`, async () => {
        const seq = nextSeq(cardId);
        await call('PUT', `/cards/${cardId}/elements/${elementId}`, {
          element: JSON.stringify(element),
          sequence: seq,
        });
      }),
    );
    return s.queue;
  }

  function deleteElement(cardId: string, elementId: string): Promise<void> {
    const s = state(cardId);
    s.queue = s.queue.then(() =>
      withReopenOnStreamingClosed(cardId, `deleteElement ${elementId}`, async () => {
        const seq = nextSeq(cardId);
        await call('DELETE', `/cards/${cardId}/elements/${elementId}`, {
          sequence: seq,
        });
      }),
    );
    return s.queue;
  }

  /**
   * Patch settings — used to flip `streaming_mode` off when a turn
   * finishes. `nextSeq` is allocated inside the queued task (not at
   * enqueue time) to match all other queued writes — mixing call-time
   * and execution-time seq allocation interleaves badly. Concrete bug:
   * a `patchSettings` enqueued right after a `replaceElement` would
   * grab the smaller seq at enqueue, but `replaceElement`'s then-block
   * would grab the larger one when it ran first, so `patchSettings`
   * lands with a stale seq and Feishu rejects 300317. Execution-time
   * allocation keeps seq order = queue order.
   */
  function patchSettings(cardId: string, settings: object): Promise<void> {
    const s = state(cardId);
    s.queue = s.queue.then(async () => {
      try {
        const seq = nextSeq(cardId);
        await call('PATCH', `/cards/${cardId}/settings`, {
          settings: JSON.stringify(settings),
          sequence: seq,
        });
      } catch (e) {
        log(
          `cardkit patchSettings ${cardId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
    return s.queue;
  }

  function patchSummaryThrottled(cardId: string, content: string): void {
    const trimmed = (content ?? '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    let s = summaryStates.get(cardId);
    if (!s) {
      s = { latest: trimmed, lastSent: '', timer: null };
      summaryStates.set(cardId, s);
    } else {
      s.latest = trimmed;
    }
    if (s.timer) return;
    s.timer = setTimeout(() => {
      const st = summaryStates.get(cardId);
      if (!st) return;
      st.timer = null;
      if (st.latest === st.lastSent) return;
      const toSend = st.latest;
      st.lastSent = toSend;
      void patchSettings(cardId, { config: { summary: { content: toSend } } });
    }, summaryFlushMs);
  }

  function cancelSummary(cardId: string): void {
    const s = summaryStates.get(cardId);
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    summaryStates.delete(cardId);
  }

  async function dispose(cardId: string): Promise<void> {
    const s = cards.get(cardId);
    if (!s) return;
    await flush(cardId);
    await s.queue;
    cards.delete(cardId);
    cancelSummary(cardId);
  }

  return {
    convertMessageToCard,
    createCardEntity,
    streamText,
    streamTextThrottled,
    flush,
    addElement,
    replaceElement,
    deleteElement,
    patchSettings,
    patchSummaryThrottled,
    cancelSummary,
    dispose,
  };
}
