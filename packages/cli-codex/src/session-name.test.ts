import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import * as codex from './index.js';
import { resolveCodexSessionName } from './session-name.js';

const threadId = '019a15e0-329d-7343-9e8c-2d694c948237';
let home: string, server: Server, wss: WebSocketServer;
let peers: WebSocket[], methods: string[], errors: unknown[];
let readParams: unknown[];
let metadata: unknown, version: string, serverHome: string;
let initializationDelay: number, readDelay: number, rejectRead: boolean, disconnectRead: boolean;
let timers: NodeJS.Timeout[];

beforeEach(async () => {
  home = await mkdtemp(join(await realpath('/tmp'), 'msn-'));
  await mkdir(join(home, 'app-server-control'));
  serverHome = home; version = '0.163.0';
  metadata = { thread: { id: threadId, name: 'Release review 会话', source: 'vscode' } };
  peers = []; methods = []; errors = []; timers = []; readParams = [];
  initializationDelay = 0; readDelay = 0; rejectRead = false; disconnectRead = false;
  server = createServer(); wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    peers.push(ws);
    ws.on('message', raw => {
      const msg = z.object({ id: z.string().optional(), method: z.string(), params: z.unknown().optional() }).parse(JSON.parse(raw.toString()));
      methods.push(msg.method);
      if (!msg.id) return;
      const reply = (): void => {
        if (msg.method === 'thread/read') {
          readParams.push(msg.params);
          if (disconnectRead) { ws.terminate(); return; }
          ws.send(JSON.stringify(rejectRead ? { id: msg.id, error: { code: -32603, message: 'Fixture failure' } }
            : { id: msg.id, result: metadata }));
        } else if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ id: msg.id, result: { codexHome: serverHome,
            userAgent: `codex_cli_rs/${version}`, platformFamily: 'unix', platformOs: 'macos' } }));
        }
      };
      const wait = msg.method === 'initialize' ? initializationDelay : readDelay;
      if (wait > 0) timers.push(setTimeout(reply, wait));
      else reply();
    });
  });
  await new Promise<void>(resolve => server.listen(join(home, 'app-server-control/app-server-control.sock'), resolve));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const timer of timers) clearTimeout(timer);
  for (const peer of peers) peer.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

async function lookup(timeoutMs = 200): Promise<string | undefined> {
  const result = await resolveCodexSessionName(threadId, { home, timeoutMs, onError: err => errors.push(err) });
  const deadline = Date.now() + 500;
  while (peers.some(peer => peer.readyState !== 3) && Date.now() < deadline) await delay(5);
  expect(peers.every(peer => peer.readyState === 3)).toBe(true);
  expect(methods.every(method => ['initialize', 'initialized', 'thread/read'].includes(method))).toBe(true);
  for (const params of readParams) expect(params).toEqual({ threadId, includeTurns: false });
  return result;
}

function diagnostics(): string { return errors.map(String).join('\n'); }

describe('native Codex session name', () => {
  it('exposes the native session name lookup capability', () => {
    expect(codex).toHaveProperty('resolveCodexSessionName', expect.any(Function));
  });

  it('reads the exact native name independently of project or terminal metadata', async () => {
    expect(await lookup()).toBe('Release review 会话');
    expect(methods).toEqual(['initialize', 'initialized', 'thread/read']);
    expect(errors).toEqual([]);
  });

  it('uses the selected CODEX_HOME when no explicit home is supplied', async () => {
    vi.stubEnv('CODEX_HOME', home);
    expect(await resolveCodexSessionName(threadId, { onError: err => errors.push(err) })).toBe('Release review 会话');
    expect(errors).toEqual([]);
  });

  it.each(['cli', 'vscode', 'exec', 'appServer', 'unknown', { custom: 'integration' }])('accepts root source %j', async source => {
    metadata = { thread: { id: threadId, name: '  exact name  ', source } };
    expect(await lookup()).toBe('  exact name  ');
    expect(errors).toEqual([]);
  });

  it.each([undefined, null, '', '  \t '])('diagnoses an unnamed thread: %j', async name => {
    metadata = { thread: { id: threadId, name, source: 'cli' } };
    expect(await lookup()).toBeUndefined();
    expect(diagnostics()).toContain('/rename <session-name>');
  });

  it.each([
    { subAgent: 'review' }, { subAgent: 'compact' }, { subAgent: 'memory_consolidation' },
    { subAgent: { other: 'fixture' } },
    { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1 } } },
  ])('excludes native subagent source %j', async source => {
    metadata = { thread: { id: threadId, name: 'Internal task', source } };
    expect(await lookup()).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it.each([
    {}, null, { thread: null },
    { thread: { id: '019a15e1-329d-7343-9e8c-2d694c948237', name: 'Other', source: 'cli' } },
    { thread: { id: threadId, name: 42, source: 'cli' } },
    ...[undefined, null, 'new-source', {}, { custom: 1 }, { custom: 'x', subAgent: 'review' },
      { subAgent: null }, { subAgent: 'new-source' }].map(source => ({ thread: { id: threadId, name: 'Work', source } })),
  ])('rejects malformed or mismatched native metadata %j', async value => {
    metadata = value;
    expect(await lookup()).toBeUndefined();
    expect(diagnostics()).toMatch(/Codex.*App Server/);
  });

  it.each(['../unsafe', '', 'not-a-uuid'])('rejects invalid thread id %j before connecting', async value => {
    expect(await resolveCodexSessionName(value, { home, onError: err => errors.push(err) })).toBeUndefined();
    expect(peers).toEqual([]);
    expect(diagnostics()).toMatch(/thread id/);
  });

  it('diagnoses an unavailable local server', async () => {
    expect(await resolveCodexSessionName(threadId, { home: join(home, 'missing'), onError: err => errors.push(err) })).toBeUndefined();
    expect(diagnostics()).toMatch(/Codex.*App Server/);
  });

  it.each(['version', 'home'])('preserves the native %s guard', async kind => {
    if (kind === 'version') version = '0.1.0';
    else serverHome = join(home, 'other');
    expect(await lookup()).toBeUndefined();
    expect(diagnostics()).toMatch(/version or home/);
    expect(methods).not.toContain('thread/read');
  });

  it.each(['rejection', 'disconnect'])('diagnoses native request %s', async kind => {
    rejectRead = kind === 'rejection'; disconnectRead = kind === 'disconnect';
    expect(await lookup()).toBeUndefined();
    expect(diagnostics()).toMatch(/Codex.*App Server/);
  });

  it('bounds initialization and metadata with one deadline and closes the socket', async () => {
    initializationDelay = 45; readDelay = 60;
    const started = Date.now();
    expect(await lookup(80)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(350);
    expect(methods).toContain('thread/read');
    expect(diagnostics()).toMatch(/timed out/);
  });

  it('times out while initialization is pending and closes the socket', async () => {
    initializationDelay = 100;
    expect(await lookup(30)).toBeUndefined();
    expect(methods).not.toContain('thread/read');
    expect(diagnostics()).toMatch(/timed out/);
  });

  it('caps the total default metadata deadline at 800ms', async () => {
    readDelay = 1500;
    const started = Date.now();
    expect(await lookup(5000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1200);
    expect(diagnostics()).toMatch(/timed out/);
  });
});
