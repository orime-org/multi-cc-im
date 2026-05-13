import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePython3Path } from './path-resolver.js';

/**
 * resolvePython3Path mirrors `resolveWezTermPath` semantics: PATH dir
 * scan with optional cache-first short-circuit, fail-fast with install
 * hint when nothing works. Tests inject `pathDirs` override + sandboxed
 * tmp dirs to avoid touching the host's real python3 install.
 */

describe('resolvePython3Path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'py3-pathres-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeExecutable(filePath: string): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, '#!/bin/sh\nexit 0\n');
    await chmod(filePath, 0o755);
  }

  it('returns cachedPath when it is still executable', async () => {
    const cached = join(tmpDir, 'python3-cached');
    await makeExecutable(cached);

    const result = await resolvePython3Path({
      cachedPath: cached,
      pathDirs: [], // forbid PATH discovery — must come from cache
    });
    expect(result).toBe(cached);
  });

  it('falls through to pathDirs when cachedPath is stale (file removed)', async () => {
    const stale = join(tmpDir, 'python3-stale');
    // Never created — cachedPath verification should fail.
    const pathDir = join(tmpDir, 'bin');
    await makeExecutable(join(pathDir, 'python3'));

    const result = await resolvePython3Path({
      cachedPath: stale,
      pathDirs: [pathDir],
    });
    expect(result).toBe(join(pathDir, 'python3'));
  });

  it('falls through to pathDirs when cachedPath is non-executable', async () => {
    const nonExec = join(tmpDir, 'python3-noexec');
    await writeFile(nonExec, ''); // exists but no x bit
    await chmod(nonExec, 0o644);

    const pathDir = join(tmpDir, 'bin');
    await makeExecutable(join(pathDir, 'python3'));

    const result = await resolvePython3Path({
      cachedPath: nonExec,
      pathDirs: [pathDir],
    });
    expect(result).toBe(join(pathDir, 'python3'));
  });

  it('returns first matching pathDir in order', async () => {
    const dir1 = join(tmpDir, 'a');
    const dir2 = join(tmpDir, 'b');
    await makeExecutable(join(dir1, 'python3'));
    await makeExecutable(join(dir2, 'python3'));

    const result = await resolvePython3Path({ pathDirs: [dir1, dir2] });
    expect(result).toBe(join(dir1, 'python3'));
  });

  it('skips pathDirs that do not contain python3', async () => {
    const empty = join(tmpDir, 'empty');
    const real = join(tmpDir, 'real');
    await mkdir(empty, { recursive: true });
    await makeExecutable(join(real, 'python3'));

    const result = await resolvePython3Path({ pathDirs: [empty, real] });
    expect(result).toBe(join(real, 'python3'));
  });

  it('throws with install hint when nothing matches', async () => {
    await expect(
      resolvePython3Path({ pathDirs: [join(tmpDir, 'nowhere')] }),
    ).rejects.toThrow(/python3 not found/);
  });

  it('install hint mentions brew and xcode-select', async () => {
    try {
      await resolvePython3Path({ pathDirs: [] });
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('brew install python3');
      expect(msg).toContain('xcode-select --install');
    }
  });
});
