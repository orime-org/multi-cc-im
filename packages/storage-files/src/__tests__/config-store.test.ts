import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigStore } from '../config-store.js';
import { ConfigSchema } from '@multi-cc-im/shared';

describe('ConfigStore', () => {
  let tmpDir: string;
  let cfgPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcim-cf-'));
    cfgPath = join(tmpDir, 'config.toml');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns default config when file does not exist', async () => {
    const store = createConfigStore({ filePath: cfgPath });
    const cfg = await store.load();
    expect(cfg.acl.owners).toEqual([]);
    expect(cfg.external_paths).toEqual({});
  });

  it('persists and reloads full config', async () => {
    const store = createConfigStore({ filePath: cfgPath });
    const input = ConfigSchema.parse({
      acl: { owners: ['me'] },
      external_paths: { wezterm: '/opt/homebrew/bin/wezterm' },
    });
    await store.save(input);

    const reloaded = await store.load();
    expect(reloaded.acl.owners).toEqual(['me']);
    expect(reloaded.external_paths.wezterm).toBe('/opt/homebrew/bin/wezterm');
  });

  it('writes valid TOML readable by anything', async () => {
    const store = createConfigStore({ filePath: cfgPath });
    await store.save(
      ConfigSchema.parse({
        acl: { owners: ['me'] },
        external_paths: {},
      }),
    );
    const text = await readFile(cfgPath, 'utf8');
    expect(text).toMatch(/(acl|external_paths)/);
  });

  it('rejects loading malformed TOML file', async () => {
    await writeFile(cfgPath, 'this is not [[ valid toml');
    const store = createConfigStore({ filePath: cfgPath });
    await expect(store.load()).rejects.toThrow();
  });

  it('rejects saving config that violates schema', async () => {
    const store = createConfigStore({ filePath: cfgPath });
    await expect(
      store.save({
        acl: { owners: [42] },
        external_paths: {},
      } as unknown as Parameters<typeof store.save>[0]),
    ).rejects.toThrow();
  });

  it('round-trip preserves nothing-but-defaults config', async () => {
    const store = createConfigStore({ filePath: cfgPath });
    const empty = ConfigSchema.parse({});
    await store.save(empty);
    const reloaded = await store.load();
    expect(reloaded).toEqual(empty);
  });
});
