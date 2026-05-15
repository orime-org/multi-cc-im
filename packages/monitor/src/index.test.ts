import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startMonitor,
  ErrorRingBuffer,
  type DaemonStateSnapshot,
  type SessionSnapshot,
  type MonitorHandle,
} from './index.js';

const STATE: DaemonStateSnapshot = {
  pid: 12345,
  startedAt: 'Thu May 15 12:00:00 2026',
  uptimeSeconds: 60,
  activeTerminal: 'wezterm',
  imAdapter: 'lark',
  imConnection: 'connected',
  imLastReconnectAt: null,
  imReconnectAttempts: 0,
};

const SESSIONS: SessionSnapshot[] = [
  {
    paneId: '42',
    title: 'frontend',
    cwd: '/tmp/proj',
    hasRenamed: true,
    addressable: true,
  },
];

async function pickFreePort(): Promise<number> {
  // Bind ephemeral, immediately close, return the assigned port.
  // Lets tests run concurrently without colliding on a fixed port.
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

describe('startMonitor', () => {
  let projectsRoot: string;
  let handle: MonitorHandle | null = null;
  let port: number;

  beforeEach(async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), 'monitor-test-'));
    port = await pickFreePort();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    await rm(projectsRoot, { recursive: true, force: true });
  });

  it('starts + responds to /health with OK', async () => {
    const logs: string[] = [];
    handle = await startMonitor({
      port,
      log: (l) => logs.push(l),
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('OK');
    expect(logs.some((l) => l.includes('monitor dashboard:'))).toBe(true);
  });

  it('GET / renders HTML containing daemon state', async () => {
    handle = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/html/);
    const body = await r.text();
    expect(body).toContain('multi-cc-im monitor');
    expect(body).toContain('frontend');
    expect(body).toContain('12345');                        // pid
    expect(body).toContain('meta http-equiv="refresh"');    // 5s auto-refresh
  });

  it('GET /api/state returns daemon state JSON', async () => {
    handle = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/state`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(STATE);
  });

  it('GET /api/errors returns error ring buffer snapshot', async () => {
    const buf = new ErrorRingBuffer({ now: () => 'fixed-ts' });
    buf.push('imAdapter', 'lark went sideways');
    handle = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: buf,
      ccProjectsRoot: projectsRoot,
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/errors`);
    const got = (await r.json()) as Array<{ message: string; phase: string }>;
    expect(got).toEqual([
      { timestamp: 'fixed-ts', phase: 'imAdapter', message: 'lark went sideways' },
    ]);
  });

  it('GET /api/cost returns [] when projects root has no jsonls', async () => {
    handle = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    const r = await fetch(`http://127.0.0.1:${port}/api/cost`);
    expect(await r.json()).toEqual([]);
  });

  it('stop() releases the port (subsequent listen on same port succeeds)', async () => {
    handle = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    await handle.stop();
    handle = null;

    // Same port should be available immediately.
    const h2 = await startMonitor({
      port,
      log: () => {},
      getDaemonState: () => STATE,
      getSessions: async () => SESSIONS,
      errorBuffer: new ErrorRingBuffer(),
      ccProjectsRoot: projectsRoot,
    });
    await h2.stop();
  });
});
