import dns from "node:dns/promises";
import { lookup as dnsLookupCallback } from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { logger } from "../util/logger.js";

/**
 * Health-probed undici Dispatcher for iLink endpoints. Per
 * [DD: iLink dispatcher health probe](../../../../docs/superpowers/specs/2026-05-08-ilink-dispatcher-health-probe-dd.md).
 *
 * **Why**: Tencent's iLink LB's 4 backend IPs intermittently include 1-2
 * dead instances (confirmed by user's diagnostic curl tests). Node fetch
 * (undici) default `dns.lookup` picks a single IP and has no IP-rotation
 * fallback — hitting a dead IP costs 5s TLS handshake timeout per attempt.
 *
 * **What**: At adapter start, DNS-resolve all A records, TCP-probe each
 * (port 443, short timeout) to build a healthy IP set. The custom undici
 * Agent's `connect.lookup` picks from healthy IPs in round-robin. A 5min
 * setInterval re-probes both healthy + dead sets so backend revival /
 * failure is reflected over time.
 *
 * **Lifecycle**: created in adapter.start(), torn down in adapter.stop()
 * (clearInterval + agent.close()).
 *
 * **Fallback when all IPs dead** (rare — server-wide outage / local network
 * partition): degrade to all IPs in healthy set so default fetch behavior
 * + apiPostFetch transient retry can still try; not strictly worse than the
 * pre-DD baseline. Logged as warn.
 */

export interface IPHealthProbedDispatcherOpts {
  /** Hostname to resolve + probe (e.g. `ilinkai.weixin.qq.com`). */
  hostname: string;
  /** Re-probe interval in ms. Default 5min. */
  reprobeIntervalMs?: number;
  /** Per-probe TCP connect timeout in ms. Default 2000ms. */
  probeTimeoutMs?: number;
  /** Port for TCP probes. Default 443. */
  port?: number;
  /**
   * Test seam: override the probe function. Default uses `net.createConnection`
   * to (ip, port) with `probeTimeoutMs` timeout; resolves to true on connect,
   * false on timeout / error.
   */
  probe?: (ip: string) => Promise<boolean>;
  /**
   * Test seam: override DNS resolution. Default uses `dns.resolve4()`.
   * Returns the list of IPv4 addresses for the given hostname.
   */
  resolve?: (hostname: string) => Promise<readonly string[]>;
}

export interface DispatcherSnapshot {
  /** IPs that passed the most recent probe — undici Agent will route to these. */
  healthy: readonly string[];
  /** IPs that failed the most recent probe — eligible for re-probe but not routed to. */
  dead: readonly string[];
  /** True when all IPs were dead at the most recent probe; healthy = all (degraded mode). */
  degraded: boolean;
}

export interface HealthProbedDispatcher {
  /** undici Dispatcher to pass to `fetch(url, { dispatcher })`. */
  agent: Dispatcher;
  /** Tear down: clear interval timer + close agent. Idempotent. */
  stop(): Promise<void>;
  /** For tests: trigger a fresh probe now and wait for completion. */
  reprobeNow(): Promise<void>;
  /** Inspector: current healthy + dead state. */
  snapshot(): DispatcherSnapshot;
}

const DEFAULT_REPROBE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_PORT = 443;

/**
 * Create a health-probed dispatcher for the given hostname.
 *
 * Performs an initial DNS resolve + concurrent TCP probe (blocking until
 * complete) so that the returned Agent immediately has a curated healthy
 * IP set. Caller (adapter.start) should `await` this.
 *
 * Throws if DNS resolution fails (no A records / network down at startup).
 * Caller decides how to handle (probably: log + start in degraded mode by
 * not creating a dispatcher; default fetch + retry takes over).
 */
export async function createHealthProbedDispatcher(
  opts: IPHealthProbedDispatcherOpts,
): Promise<HealthProbedDispatcher> {
  const reprobeIntervalMs = opts.reprobeIntervalMs ?? DEFAULT_REPROBE_INTERVAL_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const port = opts.port ?? DEFAULT_PORT;
  const probe = opts.probe ?? ((ip) => probeTcp(ip, port, probeTimeoutMs));
  const resolve = opts.resolve ?? defaultResolve;

  const allIPs: readonly string[] = await resolve(opts.hostname);
  if (allIPs.length === 0) {
    throw new Error(
      `createHealthProbedDispatcher: no A records for ${opts.hostname}`,
    );
  }

  const healthy = new Set<string>();
  const dead = new Set<string>();
  let degraded = false;

  async function probeAll(): Promise<void> {
    const results = await Promise.all(
      allIPs.map(async (ip) => ({ ip, ok: await probe(ip).catch(() => false) })),
    );
    healthy.clear();
    dead.clear();
    for (const { ip, ok } of results) {
      (ok ? healthy : dead).add(ip);
    }
    if (healthy.size === 0) {
      // All dead — degrade so default fetch / undici can still try.
      // Move all from dead → healthy (snapshot.dead = [] in degraded mode).
      degraded = true;
      dead.clear();
      for (const ip of allIPs) healthy.add(ip);
      logger.warn(
        `dispatcher[${opts.hostname}]: ALL ${allIPs.length} IPs failed probe, degrading to fallback (apiPostFetch retry will compensate)`,
      );
    } else {
      degraded = false;
      logger.info(
        `dispatcher[${opts.hostname}]: ${healthy.size}/${allIPs.length} healthy (${[...healthy].join(",")}); ${dead.size} dead${dead.size > 0 ? ` (${[...dead].join(",")})` : ""}`,
      );
    }
  }

  await probeAll();

  // Round-robin pointer — separate from set order so we don't depend on
  // Set iteration order across re-probes.
  let nextIndex = 0;
  function pickHealthyIP(): string {
    const list = [...healthy];
    // safety: degraded fallback ensures list.length > 0 by construction
    const ip = list[nextIndex % list.length]!;
    nextIndex = (nextIndex + 1) % Math.max(list.length, 1);
    return ip;
  }

  // Custom DNS lookup callback used by undici Agent's `connect` builder.
  // undici 8 (matched by our `undici@^8.2.0` dep) passes a callback that
  // expects the **array form** `(err, [{ address, family }])` — the older
  // `(err, address, family)` triple-form silently fails with
  // `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` because undici
  // 8 indexes `[0].address` on what it thinks is an array. Verified with
  // live `Agent` smoke against ilinkai.weixin.qq.com.
  //
  // The Node `LookupFunction` type only declares the triple-form; the cast
  // sidesteps that. Fallback path (other hosts) keeps the triple-form via
  // `dnsLookupCallback` because Node's own `dns.lookup` handles both shapes
  // depending on `options.all`.
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== opts.hostname) {
      // Not our host — fall back to OS DNS so we don't accidentally break
      // any sibling fetch (e.g. CDN media upload uses a different host).
      dnsLookupCallback(hostname, options, callback);
      return;
    }
    const ip = pickHealthyIP();
    (callback as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(
      null,
      [{ address: ip, family: 4 }],
    );
  };

  const agent = new Agent({
    // keepAlive long so once we lock onto a healthy socket we don't waste
    // round-trips re-probing.
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    connect: {
      lookup,
    },
  });

  let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
    probeAll().catch((err) =>
      logger.warn(
        `dispatcher[${opts.hostname}]: re-probe failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }, reprobeIntervalMs);
  // Don't keep Node event loop alive for re-probe alone (daemon's main loop
  // does that via the iLink long-poll fetch).
  interval.unref?.();

  let stopped = false;
  return {
    agent,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      await agent.close();
    },
    async reprobeNow() {
      await probeAll();
    },
    snapshot() {
      return {
        healthy: [...healthy],
        dead: [...dead],
        degraded,
      };
    },
  };
}

/**
 * Default TCP probe: open a socket to (ip, port), resolve true on `connect`,
 * false on `error` / timeout. Socket is destroyed in all cases (no leak).
 */
async function probeTcp(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: ip, port, timeout: timeoutMs });
    let resolved = false;
    const done = (ok: boolean): void => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  return dns.resolve4(hostname);
}
