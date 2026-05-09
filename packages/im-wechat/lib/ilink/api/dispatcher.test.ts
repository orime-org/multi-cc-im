import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHealthProbedDispatcher } from "./dispatcher.js";

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const HOSTNAME = "ilinkai.weixin.qq.com";
const FOUR_IPS = [
  "43.137.175.32",
  "43.137.191.185",
  "43.171.116.194",
  "43.171.124.85",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createHealthProbedDispatcher", () => {
  it("initial probe: 2 healthy + 2 dead — snapshot reflects state", async () => {
    const probe = vi.fn().mockImplementation((ip: string) =>
      Promise.resolve(
        ip === "43.137.175.32" || ip === "43.137.191.185" ? true : false,
      ),
    );
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe,
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999, // never fire during test
    });
    const snap = d.snapshot();
    expect(snap.healthy.sort()).toEqual([
      "43.137.175.32",
      "43.137.191.185",
    ]);
    expect(snap.dead.sort()).toEqual(["43.171.116.194", "43.171.124.85"]);
    expect(snap.degraded).toBe(false);
    expect(probe).toHaveBeenCalledTimes(4);
    await d.stop();
  });

  it("ALL dead → degrades to all-IPs-as-healthy + warn (apiPostFetch retry compensates)", async () => {
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe: async () => false, // all dead
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    const snap = d.snapshot();
    expect(snap.healthy.sort()).toEqual([...FOUR_IPS].sort());
    expect(snap.dead.length).toBe(0);
    expect(snap.degraded).toBe(true);
    await d.stop();
  });

  it("re-probe: dead IP coming back to life → moves to healthy", async () => {
    let pass1 = true;
    const probe = vi.fn().mockImplementation((ip: string) => {
      if (pass1) {
        // First pass: 43.171.* are dead
        return Promise.resolve(!ip.startsWith("43.171"));
      }
      // Second pass: all alive
      return Promise.resolve(true);
    });
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe,
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    expect(d.snapshot().dead.sort()).toEqual([
      "43.171.116.194",
      "43.171.124.85",
    ]);

    pass1 = false;
    await d.reprobeNow();

    const snap = d.snapshot();
    expect(snap.healthy.sort()).toEqual([...FOUR_IPS].sort());
    expect(snap.dead.length).toBe(0);
    await d.stop();
  });

  it("re-probe: healthy IP suddenly dead → moves to dead", async () => {
    let pass1 = true;
    const probe = vi.fn().mockImplementation((ip: string) => {
      if (pass1) {
        return Promise.resolve(true); // all alive
      }
      // 43.137.175.32 dies
      return Promise.resolve(ip !== "43.137.175.32");
    });
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe,
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    expect(d.snapshot().healthy.length).toBe(4);

    pass1 = false;
    await d.reprobeNow();

    expect(d.snapshot().dead).toContain("43.137.175.32");
    expect(d.snapshot().healthy.length).toBe(3);
    await d.stop();
  });

  it("DNS resolve failure → throws", async () => {
    await expect(
      createHealthProbedDispatcher({
        hostname: HOSTNAME,
        probe: async () => true,
        resolve: async () => {
          throw new Error("EAI_AGAIN");
        },
      }),
    ).rejects.toThrow(/EAI_AGAIN/);
  });

  it("empty A records → throws (no IPs to route to)", async () => {
    await expect(
      createHealthProbedDispatcher({
        hostname: HOSTNAME,
        probe: async () => true,
        resolve: async () => [],
      }),
    ).rejects.toThrow(/no A records/);
  });

  it("stop() is idempotent", async () => {
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe: async () => true,
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    await d.stop();
    await expect(d.stop()).resolves.toBeUndefined();
  });

  it("probe function rejecting (not just resolving false) → treated as dead, not crash", async () => {
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe: async (ip) => {
        if (ip === "43.171.116.194") throw new Error("connection refused");
        return true;
      },
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    expect(d.snapshot().dead).toEqual(["43.171.116.194"]);
    expect(d.snapshot().healthy.length).toBe(3);
    await d.stop();
  });

  it("dispatcher exposes undici Agent instance", async () => {
    const d = await createHealthProbedDispatcher({
      hostname: HOSTNAME,
      probe: async () => true,
      resolve: async () => FOUR_IPS,
      reprobeIntervalMs: 99_999_999,
    });
    // Quick sanity check: undici Agent has dispatch / close methods.
    expect(typeof d.agent.close).toBe("function");
    expect(typeof d.agent.dispatch).toBe("function");
    await d.stop();
  });

  // ==========================================================================
  // undici 8 dispatch-time contract: `connect.lookup` callback must use the
  // array form `(err, [{address, family}])`. The triple form `(err, ip, fam)`
  // silently fails with `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`
  // because undici 8 indexes `[0].address` on what it expects to be an array.
  // This codifies the contract via a real fetch through the Agent (mocking
  // `connect` would skip the failure mode entirely).
  // ==========================================================================
  it("undici 8 contract: fetch through Agent reaches connect (no ERR_INVALID_IP_ADDRESS)", async () => {
    // Pick a routable IP we expect TLS handshake to fail on (any public IP
    // unrelated to our test host); we only care that we get past `lookup` →
    // `connect`. ERR_INVALID_IP_ADDRESS would mean lookup-stage failure.
    const d = await createHealthProbedDispatcher({
      hostname: "ilinkai.test.invalid",
      probe: async () => true,
      resolve: async () => ["127.0.0.1"], // localhost — connect refused, but past lookup
      reprobeIntervalMs: 99_999_999,
    });
    const { fetch } = await import("undici");
    let caughtCode: string | undefined;
    try {
      await fetch("https://ilinkai.test.invalid/", {
        dispatcher: d.agent,
        signal: AbortSignal.timeout(2_000),
      });
    } catch (err) {
      caughtCode = (err as Error & { cause?: { code?: string } }).cause?.code;
    }
    // Accept any post-lookup failure (ECONNREFUSED, ETIMEDOUT, EPROTO, etc.)
    // but specifically NOT ERR_INVALID_IP_ADDRESS — that's the lookup-shape bug.
    expect(caughtCode).not.toBe("ERR_INVALID_IP_ADDRESS");
    await d.stop();
  });
});
