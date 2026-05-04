import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWezTermPath } from './path-resolver.js';

/**
 * path-resolver enforces architecture.md「外部 CLI 工具路径策略」:
 *   1. PATH lookup (`which wezterm` semantics)
 *   2. Apple Silicon Homebrew (`/opt/homebrew/bin/wezterm`)
 *   3. Intel Homebrew (`/usr/local/bin/wezterm`)
 *   4. macOS .app bundle (`/Applications/WezTerm.app/Contents/MacOS/wezterm`)
 *
 * Tests inject candidate locations + PATH override to avoid touching the host's
 * real wezterm install.
 */

describe('resolveWezTermPath', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'wt-pathres-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeExecutable(filePath: string): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, '#!/bin/sh\nexit 0\n');
    await chmod(filePath, 0o755);
  }

  it('returns cached path when verifyOnly resolves an existing executable', async () => {
    const cached = join(tmpDir, 'cached', 'wezterm');
    await makeExecutable(cached);
    const result = await resolveWezTermPath({
      cachedPath: cached,
      pathDirs: [],
      bundleCandidates: [],
    });
    expect(result).toBe(cached);
  });

  it('re-discovers when cached path no longer exists (user uninstalled)', async () => {
    const stale = join(tmpDir, 'gone', 'wezterm');
    const fresh = join(tmpDir, 'pathdir', 'wezterm');
    await makeExecutable(fresh);
    const result = await resolveWezTermPath({
      cachedPath: stale,
      pathDirs: [join(tmpDir, 'pathdir')],
      bundleCandidates: [],
    });
    expect(result).toBe(fresh);
  });

  it('finds wezterm via pathDirs (PATH lookup) before bundle candidates', async () => {
    const onPath = join(tmpDir, 'a', 'wezterm');
    const inBundle = join(tmpDir, 'bundle', 'wezterm');
    await makeExecutable(onPath);
    await makeExecutable(inBundle);
    const result = await resolveWezTermPath({
      pathDirs: [join(tmpDir, 'a')],
      bundleCandidates: [inBundle],
    });
    expect(result).toBe(onPath);
  });

  it('falls back to bundle candidates in declared order when PATH misses', async () => {
    const c1 = join(tmpDir, 'opt', 'homebrew', 'bin', 'wezterm');
    const c2 = join(tmpDir, 'usr', 'local', 'bin', 'wezterm');
    const c3 = join(tmpDir, 'Applications', 'WezTerm.app', 'Contents', 'MacOS', 'wezterm');
    await makeExecutable(c2);
    await makeExecutable(c3);
    const result = await resolveWezTermPath({
      pathDirs: [],
      bundleCandidates: [c1, c2, c3],
    });
    expect(result).toBe(c2);
  });

  it('throws fail-fast with install hint when nothing is found', async () => {
    await expect(
      resolveWezTermPath({
        pathDirs: [join(tmpDir, 'no-such')],
        bundleCandidates: [join(tmpDir, 'also-no-such')],
      }),
    ).rejects.toThrow(/wezterm.*not found.*brew install/i);
  });

  it('skips non-executable matches (file exists but not chmod +x)', async () => {
    const notExec = join(tmpDir, 'p1', 'wezterm');
    const exec = join(tmpDir, 'p2', 'wezterm');
    await mkdir(join(notExec, '..'), { recursive: true });
    await writeFile(notExec, '#!/bin/sh\nexit 0\n');
    // No chmod — explicitly NOT executable (mode 0644 default).
    await chmod(notExec, 0o644);
    await makeExecutable(exec);
    const result = await resolveWezTermPath({
      pathDirs: [join(tmpDir, 'p1'), join(tmpDir, 'p2')],
      bundleCandidates: [],
    });
    expect(result).toBe(exec);
  });

  it('follows symlinks (Homebrew typically symlinks into /opt/homebrew/bin)', async () => {
    const target = join(tmpDir, 'cellar', 'wezterm');
    const link = join(tmpDir, 'bin', 'wezterm');
    await makeExecutable(target);
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(target, link);
    const result = await resolveWezTermPath({
      pathDirs: [join(tmpDir, 'bin')],
      bundleCandidates: [],
    });
    expect(result).toBe(link);
  });
});
