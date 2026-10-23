import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import * as codex from './index.js';
import { resolveCodexSessionName } from './session-name.js';

const threadId = '019a15e0-329d-7343-9e8c-2d694c948237';
let home: string, methods: string[], errors: unknown[], readParams: unknown[];
let metadata: unknown, version: string, serverHome: string;
let initializationDelay: number, readDelay: number, rejectRead: boolean, disconnectRead: boolean;
let fault: string;

beforeEach(async () => {
  home = await mkdtemp(join(await realpath('/tmp'), 'msn-'));
  serverHome = home; version = '0.163.0';
  metadata = { thread: { id: threadId, name: 'Release review 会话', source: 'vscode' } };
  methods = []; errors = []; readParams = [];
  initializationDelay = 0; readDelay = 0; rejectRead = false; disconnectRead = false;
  fault = '';
  await writeFile(join(home, 'app-server'), `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const home = process.env.CODEX_HOME;
writeFileSync(home + '/started.json', JSON.stringify({ pid: process.pid, home, cwd: process.cwd(), args: process.argv.slice(2) }));
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  const msg = JSON.parse(line);
  appendFileSync(home + '/requests.jsonl', line + '\\n');
  if (!msg.id) return;
  const config = JSON.parse(readFileSync(home + '/fixture.json', 'utf8'));
  setTimeout(() => {
    if (msg.method === 'initialize' && config.fault === 'initialization-error') {
      console.log(JSON.stringify({ id: msg.id, error: { code: -32603 } })); return;
    }
    if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: {
      codexHome: config.serverHome, userAgent: 'codex_cli_rs/' + config.version, platformFamily: 'unix', platformOs: 'macos',
    } }));
    if (msg.method === 'thread/read') {
      if (config.disconnectRead) { process.exit(1); return; }
      if (config.fault === 'malformed-json') { console.log('{'); return; }
      if (config.fault === 'wrong-id') { console.log(JSON.stringify({ id: 99, result: config.metadata })); return; }
      if (config.fault === 'invalid-envelope') { console.log('null'); return; }
      if (config.fault === 'premature-eof') { process.stdout.end(); return; }
      if (config.fault === 'notification') console.log(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }));
      if (config.fault === 'stubborn-shutdown') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
      if (config.fault === 'failed-shutdown') process.exitCode = 17;
      console.log(JSON.stringify(config.rejectRead ? { id: msg.id, error: { code: -32603, message: 'Fixture failure' } }
        : { id: msg.id, result: config.metadata }));
    }
  }, msg.method === 'initialize' ? config.initializationDelay : config.readDelay);
});
`, { mode: 0o700 });
  await configure();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function configure(): Promise<void> {
  await writeFile(join(home, 'fixture.json'), JSON.stringify({ metadata, version, serverHome,
    initializationDelay, readDelay, rejectRead, disconnectRead, fault }));
}

async function lookup(timeoutMs = 800): Promise<string | undefined> {
  await configure();
  const result = await resolveCodexSessionName(threadId, { home, timeoutMs, executable: process.execPath, onError: err => errors.push(err) });
  const started = z.object({ pid: z.number(), home: z.string(), cwd: z.string(), args: z.array(z.string()) })
    .parse(JSON.parse(await readFile(join(home, 'started.json'), 'utf8')));
  expect(started.home).toBe(home); expect(started.cwd).toBe(home);
  expect(started.args).toEqual(['--listen', 'stdio://']);
  expect(() => process.kill(started.pid, 0)).toThrow(/ESRCH/);
  const raw = await readFile(join(home, 'requests.jsonl'), 'utf8');
  const messages = raw.trim().split('\n').filter(Boolean).map(line => z.object({ method: z.string(), params: z.unknown().optional() }).parse(JSON.parse(line)));
  methods = messages.map(message => message.method);
  readParams = messages.filter(message => message.method === 'thread/read').map(message => message.params);
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
    expect(await resolveCodexSessionName(threadId, { executable: process.execPath, onError: err => errors.push(err) })).toBe('Release review 会话');
    expect(errors).toEqual([]);
  });

  it('resolves a relative selected home before setting the subprocess environment', async () => {
    expect(await resolveCodexSessionName(threadId, { home: relative(process.cwd(), home),
      executable: process.execPath, onError: err => errors.push(err) })).toBe('Release review 会话');
    const started = z.object({ home: z.string() }).parse(JSON.parse(await readFile(join(home, 'started.json'), 'utf8')));
    expect(started.home).toBe(home);
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
    expect(methods).toEqual([]);
    expect(diagnostics()).toMatch(/thread id/);
  });

  it('diagnoses an inaccessible native home', async () => {
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

  it.each(['initialization-error', 'malformed-json', 'wrong-id', 'invalid-envelope', 'premature-eof'])('diagnoses protocol failure %s and reaps its child', async value => {
    fault = value;
    expect(await lookup()).toBeUndefined();
    expect(diagnostics()).toContain('codex app-server --help');
  });

  it('consumes native notifications while reading metadata', async () => {
    fault = 'notification';
    expect(await lookup()).toBe('Release review 会话');
    expect(errors).toEqual([]);
  });

  it.each(['failed-shutdown', 'stubborn-shutdown'])('preserves valid metadata after %s', async value => {
    fault = value;
    const started = Date.now();
    expect(await lookup()).toBe('Release review 会话');
    expect(Date.now() - started).toBeLessThan(800);
    expect(diagnostics()).toContain('metadata was received');
  });

  it('diagnoses an unavailable executable', async () => {
    expect(await resolveCodexSessionName(threadId, { home, executable: join(home, 'missing-codex'), onError: err => errors.push(err) })).toBeUndefined();
    expect(diagnostics()).toContain('ENOENT');
    expect(diagnostics()).toContain('codex --version');
  });

  it('bounds initialization and metadata with one deadline and reaps its child', async () => {
    initializationDelay = 350; readDelay = 400;
    const started = Date.now();
    expect(await lookup(700)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(methods).toContain('thread/read');
    expect(diagnostics()).toMatch(/timed out/);
  });

  it('times out while initialization is pending and reaps its child', async () => {
    initializationDelay = 800;
    expect(await lookup(400)).toBeUndefined();
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
