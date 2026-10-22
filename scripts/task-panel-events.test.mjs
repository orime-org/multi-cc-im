import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { observePlan } from './task-panel-events.mjs';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcim-plan-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const socketPath = join(root, 'codex.sock');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const requests = [];
  const state = { loaded: true, client: null };
  sockets.on('connection', client => {
    state.client = client;
    client.on('message', raw => {
      const message = JSON.parse(raw.toString());
      requests.push(message);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === 'thread/read') {
        result = { thread: { id: 'session-a', cwd: '/work/project', status: { type: state.loaded ? 'active' : 'notLoaded' } } };
      }
      if (message.method === 'thread/resume') {
        result = { thread: { id: 'session-a', cwd: '/work/project', status: { type: 'active' } } };
      }
      client.send(JSON.stringify({ id: message.id, result }));
    });
  });
  cleanups.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const cache = join(root, 'plans');
  const observer = observePlan({ sessionId: 'session-a', socketPath, stateDir: cache, retryMs: 20, requestTimeoutMs: 1000 });
  cleanups.push(() => observer.stop());
  const snapshot = () => readFile(join(cache, 'session-a.json'), 'utf8').then(JSON.parse);
  const sendPlan = (threadId = 'session-a', status = 'inProgress') => state.client.send(JSON.stringify({
    method: 'turn/plan/updated', params: { threadId, turnId: 'turn-a', plan: [{ step: 'Verify local delivery', status }] },
  }));
  await vi.waitFor(() => expect(requests.some(r => r.method === 'thread/resume')).toBe(true));
  return { root, requests, state, cache, observer, snapshot, sendPlan };
}

describe('local Codex plan events', () => {
  it('receives native plan events over a Unix socket and saves a private display snapshot', async () => {
    const f = await fixture();
    f.sendPlan();
    await vi.waitFor(async () => expect((await f.snapshot()).plan[0]).toEqual({ step: 'Verify local delivery', status: 'in_progress' }));
    expect((await stat(join(f.cache, 'session-a.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(f.cache)).mode & 0o777).toBe(0o700);
    expect(await readdir(f.cache)).toEqual(['session-a.json']);
    expect(f.requests.map(r => r.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/resume']);
  });

  it('ignores other sessions and malformed plans without replacing a valid checklist', async () => {
    const f = await fixture();
    f.sendPlan();
    await vi.waitFor(async () => expect((await f.snapshot()).plan).toHaveLength(1));
    f.sendPlan('session-b', 'completed');
    f.sendPlan('session-a', 'invalid');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await f.snapshot()).plan[0].status).toBe('in_progress');
  });

  it('never responds to command approval requests on the observing connection', async () => {
    const f = await fixture();
    f.state.client.send(JSON.stringify({ id: 'approval-a', method: 'item/commandExecution/requestApproval', params: { threadId: 'session-a' } }));
    f.sendPlan();
    await vi.waitFor(async () => expect((await f.snapshot()).plan).toHaveLength(1));
    expect(f.requests.some(r => r.id === 'approval-a')).toBe(false);
    expect(f.requests.some(r => r.method === 'turn/start' || r.method === 'config/batchWrite')).toBe(false);
  });

  it('retains the last checklist on disconnect and reattaches only after the session is loaded', async () => {
    const f = await fixture();
    f.sendPlan();
    await vi.waitFor(async () => expect((await f.snapshot()).plan).toHaveLength(1));
    f.state.loaded = false;
    f.state.client.terminate();
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'thread/read').length).toBeGreaterThan(1));
    expect(f.requests.filter(r => r.method === 'thread/resume')).toHaveLength(1);
    expect((await f.snapshot()).plan).toHaveLength(1);
    f.state.loaded = true;
    await vi.waitFor(() => expect(f.requests.filter(r => r.method === 'thread/resume')).toHaveLength(2));
    f.sendPlan('session-a', 'completed');
    await vi.waitFor(async () => expect((await f.snapshot()).plan[0].status).toBe('completed'));
  });

  it('rejects remote endpoints and unsafe session ids before connecting', () => {
    expect(() => observePlan({ sessionId: '../outside', socketPath: '/tmp/local.sock', stateDir: '/tmp' })).toThrow();
    expect(() => observePlan({ sessionId: 'session-a', socketPath: 'wss://example.com', stateDir: '/tmp' })).toThrow();
  });

  it('restores the saved checklist when the panel process starts again', async () => {
    const f = await fixture();
    f.sendPlan('session-a', 'completed');
    await vi.waitFor(async () => expect((await f.snapshot()).plan[0].status).toBe('completed'));
    await f.observer.stop();
    const observer = observePlan({ sessionId: 'session-a', socketPath: join(f.root, 'codex.sock'), stateDir: f.cache, retryMs: 20 });
    cleanups.push(() => observer.stop());
    await vi.waitFor(async () => expect((await f.snapshot()).note).toContain('saved checklist until the next update'));
    expect((await f.snapshot()).plan[0]).toEqual({ step: 'Verify local delivery', status: 'completed' });
  });
});
