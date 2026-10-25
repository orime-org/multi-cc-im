import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { z } from 'zod';
import { CodexEnvelope, codexInitializeParams, codexRuntimeError, getCodexVersion, parseCodexRpcError, validateCodexInitialization } from './app-server-protocol.js';

const Loaded = z.object({ data: z.array(z.string().uuid()), nextCursor: z.string().nullable().optional() });

/** Local socket lifecycle; only this cooperating client's connection is owned. */
export interface CodexLocalClient {
  /** Observed initialize metadata, never used for version admission. */
  readonly version: string;
  ready: Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): Promise<void>;
  close(): void;
}

/**
 * Resolve the one configured native home without scanning private directories.
 * @param env Host environment or isolated fixture environment.
 * @returns Absolute native home used by the local App Server.
 * @example const home = codexHome();
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEX_HOME || join(homedir(), '.codex'));
}

/**
 * Connect to the native UDS WebSocket; never connects to a network host.
 * @param opts Home, bounded RPC waits and event/diagnostic callbacks.
 * @returns Initialized RPC transport, native response writer and local close.
 * @throws The ready promise rejects on invalid initialization or disconnect.
 * @example const peer = connectCodexLocal({ home, onError }); await peer.ready;
 */
export function connectCodexLocal(opts: {
  home: string; timeoutMs?: number;
  onEvent?(id: string | number | undefined, method: string, params: unknown): void;
  onDisconnect?(): void;
  onError(err: unknown): void;
}): CodexLocalClient {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const ws = new WebSocket('ws://localhost/', { createConnection: () => connect(join(opts.home, 'app-server-control/app-server-control.sock')),
    handshakeTimeout: timeoutMs, followRedirects: false, perMessageDeflate: false });
  const calls = new Map<string, { method: string; resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
  let sequence = 0, closed = false, version = 'unknown';
  function disconnect(): void {
    if (closed) return;
    closed = true;
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(codexRuntimeError(call.method, version, new Error('Codex local socket disconnected'))); }
    calls.clear(); opts.onDisconnect?.();
  }
  function send(message: unknown): Promise<void> {
    return new Promise((accept, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) { reject(new Error('Codex local socket is unavailable')); return; }
      ws.send(JSON.stringify(message), err => err ? reject(err) : accept());
    });
  }
  function call(method: string, params: unknown): Promise<unknown> {
    return new Promise((accept, reject) => {
      const id = `multi-cc-im:${++sequence}`;
      const timer = setTimeout(() => { calls.delete(id); reject(codexRuntimeError(method, version, new Error(`Codex ${method} timed out`))); }, timeoutMs);
      calls.set(id, { method, resolve: accept, reject, timer });
      void send({ id, method, params }).catch(err => { clearTimeout(timer); calls.delete(id); reject(codexRuntimeError(method, version, err)); });
    });
  }
  ws.on('message', raw => {
    let value: unknown;
    try { value = JSON.parse(raw.toString()); }
    catch (err) { opts.onError(codexRuntimeError('receive', version, err)); return; }
    const parsed = CodexEnvelope.safeParse(value);
    if (!parsed.success) { opts.onError(codexRuntimeError('receive', version, new Error('Invalid Codex local protocol envelope'))); return; }
    const msg = parsed.data;
    if (msg.method) { opts.onEvent?.(msg.id, msg.method, msg.params); return; }
    if (typeof msg.id !== 'string') return;
    const pending = calls.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer); calls.delete(msg.id);
    if (msg.error !== undefined) pending.reject(codexRuntimeError(pending.method, version, parseCodexRpcError(msg.error)));
    else pending.resolve(msg.result);
  });
  ws.on('close', disconnect);
  ws.on('error', err => { opts.onError(codexRuntimeError('local connection', version, err)); disconnect(); });
  const ready = (async () => {
    await new Promise<void>((accept, reject) => {
      ws.once('open', accept); ws.once('error', reject);
      ws.once('close', () => reject(new Error('Codex socket closed during initialization')));
    });
    const initialized = await call('initialize', codexInitializeParams);
    version = getCodexVersion(initialized);
    validateCodexInitialization(initialized, opts.home);
    await send({ method: 'initialized' });
  })().catch(err => { ws.terminate(); disconnect(); throw codexRuntimeError('initialize', version, err); });
  return { get version() { return version; }, ready, call,
    respond: (id, result) => send({ id, result }).catch(err => { throw codexRuntimeError('question response', version, err); }),
    close() { ws.terminate(); disconnect(); } };
}

/**
 * Read all currently loaded ids without resuming or starting any thread.
 * @param client Initialized native transport.
 * @returns Deduplicated full thread ids, including all pagination pages.
 * @throws Invalid native schema or repeated pagination cursor.
 * @example const loadedIds = await listLoadedCodexThreads(peer);
 */
export async function listLoadedCodexThreads(client: CodexLocalClient): Promise<readonly string[]> {
  try {
    const ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = Loaded.parse(await client.call('thread/loaded/list', cursor ? { cursor } : {}));
      for (const id of page.data) ids.add(id);
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Codex loaded-thread pagination repeated a cursor');
        cursors.add(cursor);
      }
    } while (cursor);
    return [...ids];
  } catch (err) { throw codexRuntimeError('thread/loaded/list', client.version, err); }
}
