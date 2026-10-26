import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { CLIHandler, CLIQuestionRequest, PaneId } from '@multi-cc-im/shared';
import { resolveCodexHookOrigin } from './hook-origin.js';
import { connectCodexLocal, listLoadedCodexThreads } from './local-client.js';
import { createCodexQuestionClient } from './question-client.js';

const paneId = 7 as PaneId;
const params = { threadId: '019a15e0-329d-7343-9e8c-2d694c948237', turnId: 'turn-a', itemId: 'item-a', isBlocking: true,
  questions: [{ id: 'choice', header: 'Choice', question: 'Which path?', isOther: true,
    options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] };
let dir: string, server: Server, wss: WebSocketServer;
let peers: WebSocket[], methods: string[], responses: unknown[], seen: CLIQuestionRequest[], closed: string[];
let status: string, source: unknown, pending: boolean, userAgent: unknown;
let rejectedMethod: string | undefined;
let resultOverrides: Map<string, unknown>;
let loaded: Set<string>;
let panes: { paneId: PaneId; title: string; cwd: string; terminalTitle?: string }[];
let requestIds: Map<string, number>;
let pages: Map<string, { data: string[]; nextCursor: string | null }> | undefined;
let stallMethod: string | undefined;
let client: ReturnType<typeof createCodexQuestionClient>;
const errors: unknown[] = [];
const listPanes = vi.fn();

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture wait timed out'); await delay(10); }
}
function emit(method: string, value: unknown, id?: number): void {
  for (const ws of peers.filter(p => p.readyState === WebSocket.OPEN)) ws.send(JSON.stringify({ method, params: value, ...(id === undefined ? {} : { id }) }));
}
async function register(threadId = '019a15e0-329d-7343-9e8c-2d694c948237', ended = false, _at = 100): Promise<void> {
  if (ended) { loaded.delete(threadId); return; }
  loaded.add(threadId);
  panes[0]!.terminalTitle = `project · ${threadId.slice(0, 29)}... ⠋`;
}
const handler: CLIHandler = { async onStop() {}, async onPreToolUse() {},
  async onQuestion(q) { seen.push(q); }, async onQuestionClosed(ref) { closed.push(ref); } };

beforeEach(async () => {
  dir = await mkdtemp(join(await realpath('/tmp'), 'mq-'));
  await mkdir(join(dir, 'app-server-control'));
  peers = []; methods = []; responses = []; seen = []; closed = []; errors.length = 0;
  status = 'active'; source = 'cli'; pending = true; userAgent = 'codex_cli_rs/0.163.0'; rejectedMethod = undefined;
  pages = undefined; stallMethod = undefined;
  resultOverrides = new Map();
  loaded = new Set(); panes = [{ paneId, title: 'work', cwd: '/tmp' }]; requestIds = new Map();
  listPanes.mockReset().mockImplementation(async () => panes);
  server = createServer(); wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    peers.push(ws);
    ws.on('message', raw => {
      const msg = z.object({ method: z.string().optional(), id: z.union([z.string(), z.number()]).optional(),
        params: z.object({ threadId: z.string().optional(), cursor: z.string().optional() }).passthrough().optional() }).passthrough().parse(JSON.parse(raw.toString()));
      const threadId = msg.params?.threadId;
      if (!msg.method) { responses.push(msg); return; }
      methods.push(msg.method);
      if (msg.method === stallMethod) return;
      if (msg.id === undefined) return;
      if (msg.method === rejectedMethod) {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Fixture method unavailable' } })); return;
      }
      let result: unknown = {};
      if (msg.method === 'initialize') result = { codexHome: dir, userAgent, platformFamily: 'unix', platformOs: 'macos' };
      if (msg.method === 'thread/loaded/list') result = pages?.get(msg.params?.cursor ?? '') ?? { data: [...loaded], nextCursor: null };
      if (threadId && (msg.method === 'thread/read' || msg.method === 'thread/resume')) result = { thread: { id: threadId, source, status: { type: status } } };
      if (msg.method === 'thread/resume' && pending && threadId) {
        if (!requestIds.has(threadId)) requestIds.set(threadId, 901 + requestIds.size);
        ws.send(JSON.stringify({ id: requestIds.get(threadId), method: 'item/tool/requestUserInput', params: { ...params, threadId: threadId } }));
      }
      ws.send(JSON.stringify({ id: msg.id, result: resultOverrides.has(msg.method) ? resultOverrides.get(msg.method) : result }));
    });
  });
  await new Promise<void>(resolve => server.listen(join(dir, 'app-server-control/app-server-control.sock'), resolve));
  client = createCodexQuestionClient({ home: dir, terminalId: 'wezterm', intervalMs: 20, rpcTimeoutMs: 200,
    listPanes, onError: err => errors.push(err) });
});
afterEach(async () => {
  await client.stop();
  for (const ws of peers) ws.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('native Codex question client', () => {
  it('skips terminal IO while no native thread is loaded and discovers a later thread', async () => {
    await client.start(handler);
    await until(() => methods.filter(method => method === 'thread/loaded/list').length >= 2);
    expect(listPanes).not.toHaveBeenCalled(); expect(errors).toEqual([]);
    await register(); await until(() => seen.length === 1);
    expect(listPanes).toHaveBeenCalled(); expect(seen[0]!.paneId).toBe(paneId);
  });

  it('reconciles unloaded threads without requiring terminal IO', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const ref = seen[0]!.reference;
    loaded.clear();
    listPanes.mockRejectedValue(new Error('Fixture terminal unavailable'));
    await until(() => methods.includes('thread/unsubscribe'));
    expect(client.listPending()).toEqual([]); expect(closed).toContain(ref);
    expect(await client.answer(ref, { choice: ['One'] })).toBe('resolved');
    expect(errors.map(String).join('\n')).not.toContain('Fixture terminal unavailable');
  });

  it('reports distinct terminal causes when their outer diagnostic is identical', async () => {
    await register();
    let calls = 0;
    listPanes.mockImplementation(async () => {
      throw new Error('Fixture pane lookup is unavailable', { cause: new Error(calls++ === 0 ? 'Fixture timeout' : 'Fixture connection refused') });
    });
    await client.start(handler); await until(() => errors.length === 2);
    expect(errors).toHaveLength(2);
  });

  it('attaches only a uniquely title-associated loaded thread and sends the native response, never a prompt', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const q = seen[0]!;
    expect(q).toMatchObject({ ...params, requestId: 901, termId: 'wezterm', paneId });
    expect(await client.answer(q.reference, { choice: ['Two'] })).toBe('submitted');
    await until(() => responses.length === 1);
    expect(responses).toEqual([{ id: 901, result: { answers: { choice: { answers: ['Two'] } } } }]);
    expect(methods.every(m => ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/resume'].includes(m))).toBe(true);
    emit('serverRequest/resolved', { threadId: '019a15e0-329d-7343-9e8c-2d694c948237', requestId: 901 });
    await until(() => closed.includes(q.reference));
    expect(await client.answer(q.reference, { choice: ['One'] })).toBe('resolved');
  });

  it.each(['notLoaded', 'systemError'])('does not revive %s threads', async type => {
    status = type; await register(); await client.start(handler); await delay(80);
    expect(seen).toEqual([]); expect(methods).not.toContain('thread/resume');
  });

  it('does not attach when the title is missing or belongs to an unloaded thread', async () => {
    await register(); panes[0]!.terminalTitle = undefined;
    await client.start(handler); await delay(80);
    expect(methods).not.toContain('thread/resume');
    panes[0]!.terminalTitle = '019a15e2-329d-7343-9e8c-2d694c948237';
    await delay(80); expect(methods).not.toContain('thread/resume');
  });

  it.each(['vscode', 'exec', 'appServer', 'unknown', { custom: 'fixture' }])('accepts title-associated root sessions with historical source %j', async historical => {
    source = historical; await register(); await client.start(handler); await until(() => seen.length === 1);
    expect(seen[0]!.paneId).toBe(paneId);
  });

  it('isolates simultaneous same-project sessions and native request ids', async () => {
    panes.push({ paneId: 8 as PaneId, title: 'other', cwd: '/tmp' });
    await register();
    loaded.add('019a15e1-329d-7343-9e8c-2d694c948237'); panes[1]!.terminalTitle = '019a15e1-329d-7343-9e8c-2d694c948237';
    await client.start(handler); await until(() => seen.length === 2);
    const [a, b] = seen;
    expect(a!.reference).not.toBe(b!.reference);
    await client.answer(a!.reference, { choice: ['One'] });
    await client.answer(b!.reference, { choice: ['Two'] });
    await until(() => responses.length === 2);
    expect(responses).toEqual(expect.arrayContaining([
      { id: a!.requestId, result: { answers: { choice: { answers: ['One'] } } } },
      { id: b!.requestId, result: { answers: { choice: { answers: ['Two'] } } } },
    ]));
  });

  it('invalidates a previous binding when the pane switches to an unknown native title', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const ref = seen[0]!.reference;
    panes[0]!.terminalTitle = '019a15e2-329d-7343-9e8c-2d694c948237';
    expect(await client.answer(ref, { choice: ['One'] })).not.toBe('submitted');
    expect(responses).toEqual([]);
  });

  it('removes answerability when the pane closes', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const ref = seen[0]!.reference; panes = [];
    expect(await client.answer(ref, { choice: ['One'] })).not.toBe('submitted');
    expect(responses).toEqual([]);
  });

  it('rejects subagents without answering', async () => {
    source = { subAgent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } };
    await register(); await client.start(handler); await delay(80);
    expect(seen).toEqual([]); expect(methods).not.toContain('thread/resume');
  });

  it.each(['codex_cli_rs/0.164.0', 'client/0.1.0', 'client/future-build', 'unfamiliar', undefined, 42])('forwards and answers with runtime metadata %j', async value => {
    userAgent = value;
    await register(); await client.start(handler); await until(() => seen.length === 1);
    expect(await client.answer(seen[0]!.reference, { choice: ['Two'] })).toBe('submitted');
    await until(() => responses.length === 1);
    expect(errors).toEqual([]);
  });

  it.each(['initialize', 'thread/loaded/list', 'thread/read', 'thread/resume'])('reports actual %s rejection with runtime context', async method => {
    userAgent = 'client/0.164.0'; rejectedMethod = method;
    await register(); await client.start(handler); await until(() => errors.length > 0);
    const message = errors.map(String).join('\n');
    expect(message).toContain(method);
    expect(message).toContain(`version: ${method === 'initialize' ? 'unknown' : '0.164.0'}`);
    expect(message).toContain('RPC -32601: Fixture method unavailable');
    expect(message).toContain('codex app-server --help');
    expect(seen).toEqual([]);
  });

  it.each(['thread/loaded/list', 'thread/read', 'thread/resume'])('retains the runtime when %s returns an invalid result', async method => {
    userAgent = 'client/0.164.0'; resultOverrides.set(method, { broken: true });
    await register(); await client.start(handler); await until(() => errors.length > 0);
    const message = errors.map(String).join('\n');
    expect(message).toContain(method);
    expect(message).toContain('version: 0.164.0');
    expect(message).toContain('codex app-server --help');
    expect(seen).toEqual([]);
  });

  it('retains the observed runtime when initialization reports a different home', async () => {
    resultOverrides.set('initialize', { codexHome: join(dir, 'other'), userAgent: 'client/0.164.0', platformFamily: 'unix', platformOs: 'macos' });
    await client.start(handler); await until(() => errors.length > 0);
    expect(errors.map(String).join('\n')).toContain('version: 0.164.0');
    expect(methods).not.toContain('thread/loaded/list');
  });

  it('reports the actual connection failure with unknown runtime before initialize', async () => {
    const peer = connectCodexLocal({ home: join(dir, 'absent'), onError: err => errors.push(err) });
    try {
      await expect(peer.ready).rejects.toThrow(/version: unknown/);
      expect(errors.map(String).join('\n')).toContain('ENOENT');
      expect(errors.map(String).join('\n')).toContain('codex app-server --help');
    } finally { peer.close(); }
  });

  it('validates completeness, exact question ids, option bounds and single selection', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const ref = seen[0]!.reference;
    const invalid: Record<string, string[]>[] = [{}, { wrong: ['One'] }, { choice: [] }, { choice: ['One', 'Two'] }, { choice: [''] }];
    for (const answer of invalid) {
      expect(await client.answer(ref, answer)).toBe('invalid');
    }
    expect(responses).toEqual([]);
    const results = await Promise.all([client.answer(ref, { choice: ['One'] }), client.answer(ref, { choice: ['Two'] })]);
    expect(results.filter(r => r === 'submitted')).toHaveLength(1);
    await until(() => responses.length === 1);
  });

  it('reconciles pending replay on reconnect with stable reference; terminal-first completion stays stale', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const ref = seen[0]!.reference;
    peers[0]!.terminate(); await until(() => closed.includes(ref));
    await until(() => seen.length === 2);
    expect(seen[1]!.reference).toBe(ref);
    pending = false;
    emit('turn/completed', { threadId: '019a15e0-329d-7343-9e8c-2d694c948237', turn: { id: 'turn-a' } });
    await until(() => client.listPending().length === 0);
    expect(await client.answer(ref, { choice: ['One'] })).toBe('resolved');
  });

  it('handles restart, native title replacement and old thread closure without delivering to the old request', async () => {
    await register(); await client.start(handler); await until(() => seen.length === 1);
    const old = seen[0]!.reference;
    await client.stop(); await client.start(handler); await until(() => seen.length === 2);
    expect(seen[1]!.reference).toBe(old);
    await register('019a15e1-329d-7343-9e8c-2d694c948237', false, 200); await register('019a15e0-329d-7343-9e8c-2d694c948237', true, 300);
    await until(() => seen.some(q => q.threadId === '019a15e1-329d-7343-9e8c-2d694c948237'));
    expect(await client.answer(old, { choice: ['One'] })).toBe('resolved');
    await register('019a15e1-329d-7343-9e8c-2d694c948237', true, 400);
    await until(() => client.listPending().length === 0);
  });

  it('ignores other approval families, malformed/secret questions and supports nonblocking free text', async () => {
    pending = false; await register(); await client.start(handler); await until(() => methods.includes('thread/resume'));
    emit('item/commandExecution/requestApproval', { threadId: '019a15e0-329d-7343-9e8c-2d694c948237' }, 12);
    emit('item/tool/requestUserInput', { ...params, questions: [{ ...params.questions[0], isSecret: true }] }, 13);
    emit('item/tool/requestUserInput', { ...params, questions: [params.questions[0], params.questions[0]] }, 14);
    emit('item/tool/requestUserInput', { ...params, questions: [] }, 15);
    await until(() => seen.length === 1); expect(seen[0]!.questions[0]?.isSecret).toBe(true);
    expect(await client.answer(seen[0]!.reference, { choice: ['private'] })).toBe('invalid');
    emit('serverRequest/resolved', { threadId: '019a15e0-329d-7343-9e8c-2d694c948237', requestId: 13 });
    await until(() => client.listPending().length === 0); seen = [];
    expect(responses).toEqual([]);
    emit('item/tool/requestUserInput', { ...params, isBlocking: false, questions: [{ id: 'text', header: 'Text', question: 'Your text', options: null }] }, 16);
    await until(() => seen.length === 1);
    expect(seen[0]!.isBlocking).toBe(false);
    expect(await client.answer(seen[0]!.reference, { text: ['actual user text'] })).toBe('submitted');
  });
});


describe('native hook origin shares official title identity', () => {
  it('reads every native loaded-id page and rejects repeated pagination cursors', async () => {
    const a = '019a15e0-329d-7343-9e8c-2d694c948237';
    const b = '019a15e1-329d-7343-9e8c-2d694c948237';
    pages = new Map([['', { data: [a], nextCursor: 'next' }], ['next', { data: [b], nextCursor: null }]]);
    const peer = connectCodexLocal({ home: dir, onError: e => errors.push(e) });
    try {
      await peer.ready;
      expect(await listLoadedCodexThreads(peer)).toEqual([a, b]);
      pages.set('next', { data: [b], nextCursor: 'next' });
      await expect(listLoadedCodexThreads(peer)).rejects.toThrow('repeated a cursor');
    } finally { peer.close(); }
  });
  it('times out a stalled native RPC and reports malformed wire messages', async () => {
    stallMethod = 'thread/loaded/list';
    const peer = connectCodexLocal({ home: dir, timeoutMs: 40, onError: e => errors.push(e) });
    try {
      await peer.ready;
      peers.at(-1)!.send('not-json');
      await expect(listLoadedCodexThreads(peer)).rejects.toThrow('timed out');
      expect(errors.length).toBeGreaterThan(0);
    } finally { peer.close(); }
  });
  it('ignores server pane environment and never resumes or subscribes a thread', async () => {
    await register();
    const origin = await resolveCodexHookOrigin('019a15e0-329d-7343-9e8c-2d694c948237', { home: dir, terminalId: 'wezterm', listPanes: async () => panes, onError: e => errors.push(e) });
    expect(origin).toEqual({ termId: 'wezterm', paneId });
    expect(methods).toEqual(['initialize', 'initialized', 'thread/loaded/list']);
  });
  it('pauses on ambiguous title prefixes and emits actionable diagnostics', async () => {
    await register(); loaded.add('019a15e0-329d-7343-9e8c-2d694c94ffff');
    expect(await resolveCodexHookOrigin('019a15e0-329d-7343-9e8c-2d694c948237', { home: dir, terminalId: 'wezterm', listPanes: async () => panes, onError: e => errors.push(e) })).toBeUndefined();
    expect(errors.some(e => String(e).includes('/terminal-title'))).toBe(true);
  });
  it('bounds an unavailable terminal API without answering or reviving anything', async () => {
    await register();
    const started = Date.now();
    expect(await resolveCodexHookOrigin('019a15e0-329d-7343-9e8c-2d694c948237', { home: dir, terminalId: 'iterm2', timeoutMs: 40,
      listPanes: () => new Promise(() => {}), onError: e => errors.push(e) })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(methods).not.toContain('thread/resume');
  });
});
