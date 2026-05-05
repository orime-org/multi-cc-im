import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSetupHooksCommand } from './setup-hooks.js';

describe('runSetupHooksCommand', () => {
  let home: string;
  let repoRoot: string;
  let ccSettings: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcim-setup-home-'));
    repoRoot = await mkdtemp(join(tmpdir(), 'mcim-setup-repo-'));
    ccSettings = join(home, '.claude', 'settings.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function run(): Promise<{
    exitCode: number;
    stderr: string;
    settings: { hooks?: unknown[] };
  }> {
    const result = await runSetupHooksCommand({
      ccSettingsPath: ccSettings,
      repoRoot,
      log: () => {},
    });
    let settings: { hooks?: unknown[] } = {};
    if (result.exitCode === 0) {
      settings = JSON.parse(await readFile(ccSettings, 'utf-8'));
    }
    return { exitCode: result.exitCode, stderr: result.stderr, settings };
  }

  it('settings.json missing → creates with 6 multi-cc-im hooks', async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.settings.hooks).toHaveLength(6);
    const events = (r.settings.hooks as Array<{ command: string }>).map((h) =>
      h.command.split(' ').pop(),
    );
    expect(events).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
  });

  it('all 6 hook commands use absolute path to bin/multi-cc-im', async () => {
    const r = await run();
    const hooks = r.settings.hooks as Array<{ command: string }>;
    for (const h of hooks) {
      expect(h.command.startsWith(`${repoRoot}/bin/multi-cc-im hook `)).toBe(true);
    }
  });

  it('settings.json exists but empty `{}` → adds 6 hooks', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(ccSettings, '{}\n', 'utf-8');
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.settings.hooks).toHaveLength(6);
  });

  it('settings.json with non-multi-cc-im hooks → preserves + appends 6', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      ccSettings,
      JSON.stringify({
        hooks: [
          { matcher: '*', type: 'command', command: '/usr/bin/some-other-tool log' },
        ],
      }),
      'utf-8',
    );
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.settings.hooks).toHaveLength(7); // 1 preserved + 6 added
    const cmds = (r.settings.hooks as Array<{ command: string }>).map((h) => h.command);
    expect(cmds[0]).toContain('some-other-tool');
  });

  it('settings.json with old multi-cc-im hooks (different ABS_PATH) → replaces them, total still 6', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      ccSettings,
      JSON.stringify({
        hooks: [
          {
            matcher: '*',
            type: 'command',
            command: '/old/path/multi-cc-im/bin/multi-cc-im hook SessionStart',
          },
          {
            matcher: '*',
            type: 'command',
            command: '/old/path/multi-cc-im/bin/multi-cc-im hook Stop',
          },
        ],
      }),
      'utf-8',
    );
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.settings.hooks).toHaveLength(6);
    const cmds = (r.settings.hooks as Array<{ command: string }>).map((h) => h.command);
    for (const c of cmds) {
      expect(c.startsWith(`${repoRoot}/bin/multi-cc-im hook `)).toBe(true);
    }
  });

  it('settings.json with mixed (other + old multi-cc-im) → preserves other, replaces multi-cc-im', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      ccSettings,
      JSON.stringify({
        otherSetting: 'preserve me',
        hooks: [
          { matcher: '*', type: 'command', command: '/usr/bin/foo' },
          {
            matcher: '*',
            type: 'command',
            command: '/old/path/bin/multi-cc-im hook Stop',
          },
          { matcher: '*', type: 'command', command: '/usr/bin/bar' },
        ],
      }),
      'utf-8',
    );
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.settings.hooks).toHaveLength(8); // 2 other + 6 fresh multi-cc-im
    expect((r.settings as { otherSetting?: string }).otherSetting).toBe('preserve me');
    const cmds = (r.settings.hooks as Array<{ command: string }>).map((h) => h.command);
    expect(cmds.filter((c) => c.includes('bin/multi-cc-im hook ')).length).toBe(6);
    expect(cmds.filter((c) => c.includes('foo') || c.includes('bar')).length).toBe(2);
  });

  it('idempotent — running twice yields same result', async () => {
    await run();
    const first = JSON.parse(await readFile(ccSettings, 'utf-8'));
    await run();
    const second = JSON.parse(await readFile(ccSettings, 'utf-8'));
    expect(second).toEqual(first);
  });

  it('malformed JSON in settings.json → exit 1 with helpful stderr', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(ccSettings, 'not-json{{{', 'utf-8');
    const r = await runSetupHooksCommand({
      ccSettingsPath: ccSettings,
      repoRoot,
      log: () => {},
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/parse|json/i);
  });

  it('creates ~/.claude directory when missing', async () => {
    // No ~/.claude dir at all
    const result = await runSetupHooksCommand({
      ccSettingsPath: ccSettings,
      repoRoot,
      log: () => {},
    });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await readFile(ccSettings, 'utf-8'));
    expect(written.hooks).toHaveLength(6);
  });

  it('logs progress lines (cc settings path / repo path / count)', async () => {
    const lines: string[] = [];
    await runSetupHooksCommand({
      ccSettingsPath: ccSettings,
      repoRoot,
      log: (l) => lines.push(l),
    });
    const joined = lines.join('\n');
    expect(joined).toContain('multi-cc-im setup-hooks');
    expect(joined).toContain(ccSettings);
    expect(joined).toContain(repoRoot);
    expect(joined).toContain('6 multi-cc-im hooks');
    expect(joined).toMatch(/total hooks now: \d+/);
  });

  describe('backup safety', () => {
    it('first run (no existing settings.json) → no backup made, exit 0', async () => {
      const r = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r.exitCode).toBe(0);
      expect(r.backupPath).toBeUndefined();
    });

    it('existing settings.json → timestamped backup created BEFORE write', async () => {
      const original = {
        someOtherTool: { token: 'preserve-me' },
        hooks: [{ matcher: '*', type: 'command', command: '/usr/bin/foo' }],
      };
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, JSON.stringify(original, null, 2), 'utf-8');

      const result = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.backupPath).toBeDefined();

      // Backup has the original content verbatim
      const backupContent = JSON.parse(await readFile(result.backupPath!, 'utf-8'));
      expect(backupContent).toEqual(original);

      // settings.json now has merged content (1 + 6)
      const newContent = JSON.parse(await readFile(ccSettings, 'utf-8'));
      expect(newContent.hooks).toHaveLength(7);
      expect(newContent.someOtherTool).toEqual({ token: 'preserve-me' });
    });

    it('multiple runs → multiple timestamped backups, none overwritten', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}', 'utf-8');

      // Run #1
      const r1 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r1.backupPath).toBeDefined();

      // Wait 10ms so timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      // Run #2 — should backup current state (which is post-r1)
      const r2 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r2.backupPath).toBeDefined();
      expect(r2.backupPath).not.toBe(r1.backupPath);

      // Both backup files still exist
      const backups = (await readdir(dirname(ccSettings))).filter((f) =>
        f.startsWith('settings.json.bak.'),
      );
      expect(backups).toHaveLength(2);
    });

    it('backup path follows <settings>.bak.<iso-timestamp> pattern', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}', 'utf-8');
      const result = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(result.backupPath).toMatch(
        new RegExp(
          `${ccSettings.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.bak\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d+Z$`,
        ),
      );
    });

    it('logs backup path so user can recover', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}', 'utf-8');
      const lines: string[] = [];
      await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes('backup:'))).toBe(true);
    });

    it('user can restore from backup with `cp <backup> <settings.json>`', async () => {
      const original = { hooks: [], userPref: 'something-precious' };
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, JSON.stringify(original), 'utf-8');

      const r = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      // simulate restore
      const { copyFile } = await import('node:fs/promises');
      await copyFile(r.backupPath!, ccSettings);
      const restored = JSON.parse(await readFile(ccSettings, 'utf-8'));
      expect(restored).toEqual(original);
    });
  });
});
