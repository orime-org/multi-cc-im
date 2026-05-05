import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolvePreferredOpenClawTmpDir,
  withFileLock,
} from './infra-runtime.js';

describe('resolvePreferredOpenClawTmpDir', () => {
  it('returns /tmp/openclaw and ensures the directory exists', () => {
    const dir = resolvePreferredOpenClawTmpDir();
    expect(dir).toBe('/tmp/openclaw');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('is idempotent across repeated calls', () => {
    const a = resolvePreferredOpenClawTmpDir();
    const b = resolvePreferredOpenClawTmpDir();
    expect(a).toBe(b);
  });
});

describe('withFileLock', () => {
  it('runs fn while holding the lock and returns its result', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-lock-'));
    const filePath = path.join(tmpDir, 'lock-target');
    try {
      const result = await withFileLock<number>(filePath, undefined, async () => 42);
      expect(result).toBe(42);
      // After fn returns, the lock must be released — a second acquisition should succeed.
      await withFileLock(filePath, undefined, async () => {});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent fn invocations on the same path', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-lock-'));
    const filePath = path.join(tmpDir, 'lock-target');
    let active = 0;
    let maxActive = 0;
    async function critical(): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
    }
    try {
      await Promise.all([
        withFileLock(filePath, { retries: { retries: 50, minTimeout: 20 } }, critical),
        withFileLock(filePath, { retries: { retries: 50, minTimeout: 20 } }, critical),
        withFileLock(filePath, { retries: { retries: 50, minTimeout: 20 } }, critical),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates the lock target file if it does not yet exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-lock-'));
    const filePath = path.join(tmpDir, 'nested', 'does-not-exist.json');
    try {
      expect(fs.existsSync(filePath)).toBe(false);
      await withFileLock(filePath, undefined, async () => {});
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('releases the lock even when fn throws', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-lock-'));
    const filePath = path.join(tmpDir, 'lock-target');
    try {
      await expect(
        withFileLock(filePath, undefined, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // Lock should have been released — re-acquire must succeed.
      await withFileLock(filePath, undefined, async () => {});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
