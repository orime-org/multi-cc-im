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
});
