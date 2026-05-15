/**
 * `@multi-cc-im/monitor` — local-only web dashboard showing daemon
 * health + cc session inventory + per-session cost.
 *
 * Per [DD 2026-05-15](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md):
 * stack = hono (web) + hono/jsx (SSR) + `@hono/node-server` (runtime).
 * No persistence, no client JS, no build step — full-page reload via
 * `<meta refresh>` every 5 seconds.
 *
 * JSX is confined to `./render.tsx` and `./views/*.tsx` so consumer
 * packages can import this entry point without enabling `--jsx` on
 * their own tsconfig.
 *
 * Wired by `apps/multi-cc-im/src/start.ts` at daemon start; URL logged
 * to stderr so user can click.
 */

import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { computeSessionCost, findRecentSessions } from './cost.js';
import { ErrorRingBuffer } from './metrics.js';
import { renderDashboard } from './render.js';
import type {
  DaemonStateSnapshot,
  SessionSnapshot,
} from './types.js';

export { ErrorRingBuffer, relativeTime } from './metrics.js';
export { computeSessionCost, findRecentSessions } from './cost.js';
export { computeUsd, priceForModel, CLAUDE_4_PRICES } from './prices.js';
export type {
  DaemonStateSnapshot,
  ErrorEntry,
  SessionCost,
  SessionSnapshot,
} from './types.js';

export const DEFAULT_MONITOR_PORT = 40719;

export interface MonitorOpts {
  /** TCP port to bind. Default {@link DEFAULT_MONITOR_PORT} (40719). */
  port?: number;
  /** Hostname / bind address. Default `127.0.0.1` (localhost-only). */
  hostname?: string;
  /**
   * Logger fed by the monitor (lifecycle events: bound to port, stopped).
   * Tests can pass a stub array push.
   */
  log: (line: string) => void;
  /** Synchronous getter: read daemon state right now. */
  getDaemonState: () => DaemonStateSnapshot;
  /** Async getter: list current cc panes via active terminal adapter. */
  getSessions: () => Promise<SessionSnapshot[]>;
  /**
   * Error ring buffer shared with the daemon's `onError` handler. Monitor
   * reads; daemon writes. Capacity bounded at construction (default 200
   * inside `ErrorRingBuffer`).
   */
  errorBuffer: ErrorRingBuffer;
  /**
   * Override the cc projects root for cost computation. Default
   * `<homedir>/.claude/projects`. Tests inject a fixture dir.
   */
  ccProjectsRoot?: string;
  /**
   * Max number of recent cc transcript jsonl files to read per cost
   * render. Default 20. Higher = more historical sessions but slower
   * render (each jsonl is full-file read).
   */
  maxCostSessions?: number;
}

export interface MonitorHandle {
  /** The actual bound port — equals `opts.port` in practice (D1 固定) but
   *  exposed for tests that pass port 0 to auto-allocate. */
  port: number;
  /** Full clickable URL, e.g. `http://127.0.0.1:40719`. */
  url: string;
  /** Stop the server. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Create + start the monitor web app. Returns a handle exposing the
 * bound port + a stop fn. Throws if the port is already in use (per
 * D1 固定 port — daemon caller is expected to surface this error to
 * the user with a clear message).
 */
export async function startMonitor(opts: MonitorOpts): Promise<MonitorHandle> {
  const port = opts.port ?? DEFAULT_MONITOR_PORT;
  const hostname = opts.hostname ?? '127.0.0.1';
  const maxCostSessions = opts.maxCostSessions ?? 20;
  const ccProjectsRoot =
    opts.ccProjectsRoot ?? `${process.env.HOME ?? ''}/.claude/projects`;

  const app = new Hono();

  app.get('/health', (c) => c.text('OK'));

  app.get('/api/state', (c) => c.json(opts.getDaemonState()));

  app.get('/api/sessions', async (c) =>
    c.json(await opts.getSessions()),
  );

  app.get('/api/errors', (c) => c.json(opts.errorBuffer.snapshot()));

  app.get('/api/cost', async (c) => {
    const paths = await findRecentSessions(ccProjectsRoot, maxCostSessions);
    const costs = await Promise.all(paths.map((p) => computeSessionCost(p)));
    return c.json(costs);
  });

  // SSR dashboard. Each request re-reads everything (DD §4 B0 pure-memory).
  app.get('/', async (c) => {
    const state = opts.getDaemonState();
    const sessions = await opts.getSessions();
    const errors = opts.errorBuffer.snapshot();
    const paths = await findRecentSessions(ccProjectsRoot, maxCostSessions);
    const costs = await Promise.all(paths.map((p) => computeSessionCost(p)));
    return c.html(
      renderDashboard({
        state,
        sessions,
        errors,
        costs,
        renderedAt: new Date().toISOString(),
      }),
    );
  });

  // Bind. Wrap @hono/node-server's `serve` in a Promise so we resolve
  // only after the OS actually owns the port (otherwise concurrent
  // shutdown races could let `stop()` fire before `listen` finishes).
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname, port }, (info) => {
      opts.log(
        `  ✓ monitor dashboard: http://${hostname}:${info.port}`,
      );
      resolve(s);
    });
    s.on('error', (err: Error) => reject(err));
  });

  return {
    port,
    url: `http://${hostname}:${port}`,
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      opts.log('  ✓ monitor dashboard stopped');
    },
  };
}
