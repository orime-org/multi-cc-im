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
import { z } from 'zod';
import { runSetupHooksCommand } from './setup-hooks.js';

/**
 * Schema mirror of cc upstream `~/.claude/settings.json` `hooks` field.
 * https://code.claude.com/docs/en/hooks
 *
 * `hooks` is an object keyed by event name; each event holds an array of
 * matcher groups; each group's inner `hooks` array holds handler entries.
 * cc's Settings Warning ("hooks must be an object mapping event names to
 * matcher arrays; received array") proved that a flat-array shape is not
 * accepted — this schema codifies the working shape so a regression won't
 * pass tests again.
 */
const handlerSchema = z
  .object({
    type: z.string(),
    command: z.string().optional(),
  })
  .passthrough();
const matcherGroupSchema = z.object({
  matcher: z.string(),
  hooks: z.array(handlerSchema).min(1),
});
const ccHooksSchema = z.record(z.string(), z.array(matcherGroupSchema));

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
    settings: { hooks?: Record<string, unknown[]> };
  }> {
    const result = await runSetupHooksCommand({
      ccSettingsPath: ccSettings,
      repoRoot,
      log: () => {},
    });
    let settings: { hooks?: Record<string, unknown[]> } = {};
    if (result.exitCode === 0) {
      settings = JSON.parse(await readFile(ccSettings, 'utf-8'));
    }
    return { exitCode: result.exitCode, stderr: result.stderr, settings };
  }

  describe('schema (cc upstream compatibility)', () => {
    it('produced settings.json conforms to cc nested-object hooks schema', async () => {
      const r = await run();
      expect(r.exitCode).toBe(0);
      // This is the regression guard for the bug fixed in this PR — flat
      // array hooks would throw a ZodError here.
      expect(() => ccHooksSchema.parse(r.settings.hooks)).not.toThrow();
    });

    it('hooks is an object keyed by event name (NOT a flat array)', async () => {
      const r = await run();
      expect(Array.isArray(r.settings.hooks)).toBe(false);
      expect(typeof r.settings.hooks).toBe('object');
      expect(r.settings.hooks).not.toBeNull();
    });

    it('all 6 event keys present, each with exactly one matcher group containing one command handler', async () => {
      const r = await run();
      const hooks = r.settings.hooks!;
      const expectedEvents = [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'SessionEnd',
      ];
      expect(Object.keys(hooks).sort()).toEqual([...expectedEvents].sort());
      for (const event of expectedEvents) {
        const groups = hooks[event] as Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
        expect(groups).toHaveLength(1);
        expect(groups[0]!.hooks).toHaveLength(1);
        expect(groups[0]!.hooks[0]!.type).toBe('command');
        expect(groups[0]!.hooks[0]!.command).toBe(
          `${repoRoot}/bin/multi-cc-im hook ${event}`,
        );
      }
    });

    it('PreToolUse / PostToolUse use matcher "*" (match all tools), other events use ""', async () => {
      const r = await run();
      const hooks = r.settings.hooks as Record<
        string,
        Array<{ matcher: string }>
      >;
      expect(hooks.PreToolUse![0]!.matcher).toBe('*');
      expect(hooks.PostToolUse![0]!.matcher).toBe('*');
      expect(hooks.SessionStart![0]!.matcher).toBe('');
      expect(hooks.UserPromptSubmit![0]!.matcher).toBe('');
      expect(hooks.Stop![0]!.matcher).toBe('');
      expect(hooks.SessionEnd![0]!.matcher).toBe('');
    });
  });

  describe('basic flows', () => {
    it('settings.json missing → creates with 6 multi-cc-im hooks', async () => {
      const r = await run();
      expect(r.exitCode).toBe(0);
      const hooks = r.settings.hooks!;
      expect(Object.keys(hooks)).toHaveLength(6);
    });

    it('settings.json exists but empty `{}` → adds 6 hooks', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}\n', 'utf-8');
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(Object.keys(r.settings.hooks!)).toHaveLength(6);
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
      const result = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(result.exitCode).toBe(0);
      const written = JSON.parse(await readFile(ccSettings, 'utf-8'));
      expect(Object.keys(written.hooks)).toHaveLength(6);
    });

    it('logs progress lines (cc settings path / repo path / handler count)', async () => {
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
      expect(joined).toMatch(/total handlers now: \d+/);
    });
  });

  describe('preservation', () => {
    it('settings.json with non-multi-cc-im hooks under same event → preserves them, appends our matcher group', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { type: 'command', command: '/usr/bin/some-other-tool block-rm' },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      expect(r.exitCode).toBe(0);
      const groups = r.settings.hooks!.PreToolUse as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      expect(groups).toHaveLength(2);
      expect(groups[0]!.matcher).toBe('Bash');
      expect(groups[0]!.hooks[0]!.command).toContain('some-other-tool');
      expect(groups[1]!.matcher).toBe('*');
      expect(groups[1]!.hooks[0]!.command).toContain('multi-cc-im hook PreToolUse');
    });

    it('settings.json with non-multi-cc-im event → preserves event verbatim', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            Notification: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: '/usr/bin/notify-send hi' }],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const hooks = r.settings.hooks!;
      expect(Object.keys(hooks).sort()).toEqual(
        [
          'Notification',
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
          'SessionEnd',
        ].sort(),
      );
      const notification = hooks.Notification as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      expect(notification[0]!.hooks[0]!.command).toBe('/usr/bin/notify-send hi');
    });

    it('top-level fields like mcpServers are preserved', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo-mcp' } },
          model: 'claude-opus-4-7',
        }),
        'utf-8',
      );
      const r = await run();
      const settings = r.settings as Record<string, unknown>;
      expect(settings.mcpServers).toEqual({ foo: { command: 'foo-mcp' } });
      expect(settings.model).toBe('claude-opus-4-7');
    });
  });

  describe('stale multi-cc-im replacement', () => {
    it('settings.json with old multi-cc-im hooks (different ABS_PATH) → replaces them', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/multi-cc-im/bin/multi-cc-im hook SessionStart',
                  },
                ],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/multi-cc-im/bin/multi-cc-im hook Stop',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      expect(r.exitCode).toBe(0);
      const hooks = r.settings.hooks as Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook SessionStart`,
      );
      expect(hooks.Stop).toHaveLength(1);
      expect(hooks.Stop![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook Stop`,
      );
    });

    it('mixed (other tool + stale multi-cc-im in same event) → preserves other, replaces multi-cc-im', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: '/usr/bin/foo' }],
              },
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook PreToolUse',
                  },
                ],
              },
              {
                matcher: 'Edit',
                hooks: [{ type: 'command', command: '/usr/bin/bar' }],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const groups = r.settings.hooks!.PreToolUse as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      // 2 preserved (Bash → foo, Edit → bar) + 1 fresh multi-cc-im
      expect(groups).toHaveLength(3);
      const allCommands = groups.flatMap((g) => g.hooks.map((h) => h.command));
      expect(allCommands).toContain('/usr/bin/foo');
      expect(allCommands).toContain('/usr/bin/bar');
      expect(
        allCommands.filter((c) => c.includes('multi-cc-im hook PreToolUse')),
      ).toHaveLength(1);
      expect(
        allCommands.filter((c) => c.includes('/old/path')),
      ).toHaveLength(0);
    });

    it('stale multi-cc-im handler in a matcher group with no others → entire group is dropped (no empty-hooks group)', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook PreToolUse',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const groups = r.settings.hooks!.PreToolUse as Array<{
        matcher: string;
        hooks: Array<unknown>;
      }>;
      // Old multi-cc-im group dropped, only the fresh one remains.
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBe('*');
      expect(groups[0]!.hooks).toHaveLength(1);
    });
  });

  describe('legacy flat-array migration (PR #31/#32 buggy schema)', () => {
    it('settings.json with flat-array hooks (cc was rejecting these) → discarded, replaced with correct nested-object schema', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: [
            {
              matcher: '*',
              type: 'command',
              command: '/some/path/bin/multi-cc-im hook SessionStart',
            },
            {
              matcher: '*',
              type: 'command',
              command: '/some/path/bin/multi-cc-im hook Stop',
            },
          ],
        }),
        'utf-8',
      );
      const r = await run();
      expect(r.exitCode).toBe(0);
      // schema validates: nested-object form, not array
      expect(() => ccHooksSchema.parse(r.settings.hooks)).not.toThrow();
      const hooks = r.settings.hooks!;
      expect(Object.keys(hooks)).toHaveLength(6);
    });

    it('legacy migration logs the cleanup count so user knows it happened', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: [
            { matcher: '*', type: 'command', command: '/x/bin/multi-cc-im hook SessionStart' },
            { matcher: '*', type: 'command', command: '/x/bin/multi-cc-im hook Stop' },
          ],
        }),
        'utf-8',
      );
      const lines: string[] = [];
      await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: (l) => lines.push(l),
      });
      const joined = lines.join('\n');
      expect(joined).toMatch(/legacy flat-array/i);
      expect(joined).toMatch(/2 legacy/);
    });
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
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: '/usr/bin/foo' }],
            },
          ],
        },
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

      const backupContent = JSON.parse(await readFile(result.backupPath!, 'utf-8'));
      expect(backupContent).toEqual(original);

      const newContent = JSON.parse(await readFile(ccSettings, 'utf-8'));
      expect(newContent.someOtherTool).toEqual({ token: 'preserve-me' });
      // schema is now valid
      expect(() => ccHooksSchema.parse(newContent.hooks)).not.toThrow();
    });

    it('multiple runs → multiple timestamped backups, none overwritten', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}', 'utf-8');

      const r1 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r1.backupPath).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const r2 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r2.backupPath).toBeDefined();
      expect(r2.backupPath).not.toBe(r1.backupPath);

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
      const original = {
        userPref: 'something-precious',
        hooks: {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/bin/own' }] }],
        },
      };
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, JSON.stringify(original), 'utf-8');

      const r = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      const { copyFile } = await import('node:fs/promises');
      await copyFile(r.backupPath!, ccSettings);
      const restored = JSON.parse(await readFile(ccSettings, 'utf-8'));
      expect(restored).toEqual(original);
    });
  });
});
