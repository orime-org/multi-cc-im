#!/usr/bin/env node
/** Observe one existing Codex thread through its local App Server. */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { z } from 'zod';

const sessionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const planSchema = z.array(z.object({ step: z.string(), status: z.enum(['pending', 'inProgress', 'completed']) }));
const cachedPlanSchema = z.array(z.object({ step: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }));

/**
 * Subscribe to plan events over a local Unix socket without starting turns.
 * @param {object} options Observer settings; short timeouts are injectable for tests.
 * @param {string} options.sessionId Existing thread id, also the display-cache key.
 * @param {string} options.socketPath Absolute Unix socket path; network URLs are rejected.
 * @param {string} options.stateDir Private directory for atomic display snapshots.
 * @param {number} [options.retryMs=2000] Reconnect delay without filesystem watchers.
 * @param {number} [options.requestTimeoutMs=8000] Deadline for local RPC responses.
 * @returns {{stop: () => Promise<void>}} Stop only this observer and drain its writes.
 * @throws {Error} If the session id or local socket path is invalid.
 * @example
 * const observer = observePlan({sessionId, socketPath, stateDir});
 * await observer.stop();
 */
export function observePlan({ sessionId, socketPath, stateDir, retryMs = 2000, requestTimeoutMs = 8000 }) {
  sessionSchema.parse(sessionId);
  if (!isAbsolute(socketPath)) throw new Error('An absolute local Unix socket path is required');
  const abort = new AbortController();
  const path = join(stateDir, `${sessionId}.json`);
  let socket;
  let stopped = false;
  let nextId = 0;
  let writes = Promise.resolve();
  let snapshot = { title: 'Codex tasks', note: 'Connecting to local Codex', session_id: sessionId, plan: [] };

  function save(note, plan) {
    snapshot = { ...snapshot, note, ...(plan ? { plan, updated_at: new Date().toISOString() } : {}) };
    const text = `${JSON.stringify(snapshot)}\n`;
    writes = writes.then(async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await chmod(stateDir, 0o700);
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }).catch(error => {
      process.stderr.write(`[task-panel] display cache write failed: ${error.code ?? error.name}\n`);
    });
  }

  async function connect() {
    const pending = new Map();
    const client = new WebSocket('ws://localhost/', {
      createConnection: () => net.connect(socketPath),
      followRedirects: false,
      perMessageDeflate: false,
      handshakeTimeout: requestTimeoutMs,
    });
    socket = client;
    const closed = new Promise(resolve => client.once('close', resolve));
    client.on('error', () => client.terminate());
    client.on('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Local Codex connection closed'));
      }
      pending.clear();
    });
    client.on('message', raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        process.stderr.write(`[task-panel] invalid local JSON message: ${error.name}\n`);
        return;
      }
      if (message.method) {
        // Never answer server requests, including command/permission approvals.
        if (message.method === 'turn/plan/updated' && message.params?.threadId === sessionId) {
          const parsed = planSchema.safeParse(message.params.plan);
          if (parsed.success) {
            save(`Live | session ${sessionId.slice(0, 8)}`, parsed.data.map(item => ({
              step: item.step, status: item.status === 'inProgress' ? 'in_progress' : item.status,
            })));
          }
        } else if (message.method === 'thread/closed' && message.params?.threadId === sessionId) {
          client.close();
        }
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error('Local Codex rejected the observer request'));
      else entry.resolve(message.result);
    });
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Local Codex request timed out')); }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        client.send(JSON.stringify({ id, method, params }));
      });
    }
    try {
      await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
        client.once('close', () => reject(new Error('Local Codex unavailable')));
      });
      await request('initialize', { clientInfo: { name: 'multi_cc_im_task_panel', version: '0.1' }, capabilities: { experimentalApi: true } });
      client.send(JSON.stringify({ method: 'initialized' }));
      const current = await request('thread/read', { threadId: sessionId, includeTurns: false });
      if (!['active', 'idle'].includes(current?.thread?.status?.type)) {
        save('Waiting for this session to reopen | saved checklist');
        return;
      }
      // The thread is already loaded: resume attaches this observing client.
      // No configuration overrides or new input are supplied.
      await request('thread/resume', { threadId: sessionId, excludeTurns: true });
      snapshot.title = `${basename(current.thread.cwd || '') || 'Codex'} tasks`;
      save(snapshot.plan.length ? 'Connected | saved checklist until the next update' : 'Connected | waiting for the first plan update');
      await closed;
      if (!stopped) save('Local Codex disconnected | retrying; saved checklist');
    } finally {
      client.terminate();
    }
  }

  const running = (async () => {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8'));
      if (cached.session_id === sessionId) {
        const parsed = cachedPlanSchema.safeParse(cached.plan);
        if (parsed.success) snapshot.plan = parsed.data;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') process.stderr.write(`[task-panel] ignoring unreadable saved checklist: ${error.code ?? error.name}\n`);
    }
    while (!stopped) {
      try {
        await connect();
      } catch (error) {
        if (!stopped) {
          save('Local Codex disconnected | retrying; saved checklist');
          process.stderr.write(`[task-panel] local connection unavailable: ${error.code ?? error.message}\n`);
        }
      }
      if (!stopped) await delay(retryMs, undefined, { signal: abort.signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
  })();
  return {
    async stop() {
      stopped = true;
      abort.abort();
      socket?.terminate();
      await running;
      await writes;
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    session: { type: 'string', default: process.env.CODEX_THREAD_ID },
    socket: { type: 'string' },
    'state-dir': { type: 'string' },
  } });
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const observer = observePlan({ sessionId: values.session, socketPath: values.socket || join(home, 'app-server-control/app-server-control.sock'), stateDir: values['state-dir'] || join(home, 'task-panel') });
  const viewer = spawn('python3', [fileURLToPath(new URL('./task-panel.py', import.meta.url)), '--session', values.session, '--state-dir', values['state-dir'] || join(home, 'task-panel')], { stdio: 'inherit' });
  const stop = async () => { viewer.kill(); await observer.stop(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  viewer.once('error', async error => { process.stderr.write(`[task-panel] viewer failed: ${error.code ?? error.name}\n`); await observer.stop(); process.exitCode = 1; });
  viewer.once('exit', async code => { await observer.stop(); process.exitCode = code ?? 0; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`[task-panel] ${error.message}\n`); process.exitCode = 1; });
}
