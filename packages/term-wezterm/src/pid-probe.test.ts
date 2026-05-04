import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultPidProbe } from './pid-probe.js';

describe('defaultPidProbe.isAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for own process pid (always alive)', () => {
    expect(defaultPidProbe.isAlive(process.pid)).toBe(true);
  });

  it('returns false for ESRCH (no such process — pid 999999)', () => {
    // pid 999999 is virtually never a real process on test hosts; if collision
    // ever happens, picking a high pid keeps false-positive risk negligible.
    expect(defaultPidProbe.isAlive(999_999_999)).toBe(false);
  });

  it('returns true for EPERM (process exists but signal not permitted)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM');
      (err as NodeJS.ErrnoException).code = 'EPERM';
      throw err;
    });
    expect(defaultPidProbe.isAlive(1)).toBe(true);
    spy.mockRestore();
  });

  it('returns false for unexpected error codes (conservative dead)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EINVAL');
      (err as NodeJS.ErrnoException).code = 'EINVAL';
      throw err;
    });
    expect(defaultPidProbe.isAlive(1)).toBe(false);
    spy.mockRestore();
  });
});

describe('defaultPidProbe.getLstart', () => {
  it('returns lstart string for own process pid', async () => {
    const lstart = await defaultPidProbe.getLstart(process.pid);
    expect(lstart.length).toBeGreaterThan(0);
  });

  it('rejects for non-existent pid (ps exits non-zero)', async () => {
    await expect(defaultPidProbe.getLstart(999_999_999)).rejects.toThrow(
      /ps -o lstart=.*failed/,
    );
  });
});
