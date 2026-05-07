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

    it('all 4 event keys present, each with exactly one matcher group containing one command handler', async () => {
      const r = await run();
      const hooks = r.settings.hooks!;
      const expectedEvents = ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd'];
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

    it('matcher per event: PreToolUse uses "*", others use empty matcher', async () => {
      // PreToolUse re-added per DD #51/#52 (IM permission gate) carries a tool
      // concept, so it uses `matcher: "*"` (match all tools). The other 3
      // events have no tool concept and use `matcher: ""` (matches every
      // invocation).
      const r = await run();
      const hooks = r.settings.hooks as Record<
        string,
        Array<{ matcher: string }>
      >;
      const expectedMatcher: Record<string, string> = {
        SessionStart: '',
        PreToolUse: '*',
        Stop: '',
        SessionEnd: '',
      };
      for (const [event, matcher] of Object.entries(expectedMatcher)) {
        expect(hooks[event]![0]!.matcher).toBe(matcher);
      }
    });

    it('PreToolUse hook entry includes timeout: 30 (IM permission gate RTT budget)', async () => {
      // Per DD #51/#52: 30s gives enough headroom for IM round-trip + user
      // reply; longer would block cc TUI for too long when the user is
      // unreachable; shorter would defeat IM RTT.
      const r = await run();
      const hooks = r.settings.hooks as Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
      >;
      expect(hooks.PreToolUse![0]!.hooks[0]!.timeout).toBe(30);
    });

    it('SessionStart / Stop / SessionEnd hook entries do NOT include timeout field', async () => {
      // Only PreToolUse needs a custom timeout (IM RTT). The other 3 events
      // are local-only and rely on cc's default timeout — emitting an explicit
      // timeout there would be noise and could mask a future cc default change.
      const r = await run();
      const hooks = r.settings.hooks as Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
      >;
      for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
        expect(hooks[event]![0]!.hooks[0]).not.toHaveProperty('timeout');
      }
    });

    it('UserPromptSubmit / PostToolUse are NOT subscribed (intentionally absent)', async () => {
      // Locks in the refactor: UserPromptSubmit / PostToolUse were dropped
      // because cc's own transcript jsonl already records the same data, so
      // multi-cc-im was duplicating storage with no consumer. PreToolUse was
      // re-added (per DD #51/#52, IM permission gate) — see the dedicated
      // PreToolUse-subscription test for that. If a future change accidentally
      // reintroduces UserPromptSubmit / PostToolUse, this assertion fails
      // loudly.
      const r = await run();
      const eventKeys = Object.keys(r.settings.hooks!);
      expect(eventKeys).not.toContain('UserPromptSubmit');
      expect(eventKeys).not.toContain('PostToolUse');
    });

    it('PreToolUse IS subscribed (re-added per DD #51/#52 for IM permission gate)', async () => {
      // After the IM-permission-forward refactor, PreToolUse is a managed
      // event again. The hook subprocess writes a PermissionRequest pending
      // file, the daemon forwards it to IM, the IM user replies allow/deny,
      // and the hook subprocess emits the decision back to cc. This guard
      // ensures the re-add doesn't silently get rolled back by a future merge.
      const r = await run();
      expect(Object.keys(r.settings.hooks!)).toContain('PreToolUse');
      const groups = r.settings.hooks!.PreToolUse as Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string; timeout?: number }>;
      }>;
      expect(groups).toHaveLength(1);
      expect(groups[0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook PreToolUse`,
      );
    });
  });

  describe('basic flows', () => {
    it('settings.json missing → creates with 4 multi-cc-im hooks', async () => {
      const r = await run();
      expect(r.exitCode).toBe(0);
      const hooks = r.settings.hooks!;
      expect(Object.keys(hooks)).toHaveLength(4);
    });

    it('settings.json exists but empty `{}` → adds 4 hooks', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}\n', 'utf-8');
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(Object.keys(r.settings.hooks!)).toHaveLength(4);
    });

    it('settings.json exists but is 0-byte empty file → treats as {}, adds 4 hooks', async () => {
      // Common when a previous tool truncated the file (e.g. `> ~/.claude/settings.json`).
      // Pre-fix this would JSON.parse('') and exit 1 with "Unexpected end of JSON input".
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '', 'utf-8');
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(Object.keys(r.settings.hooks!)).toHaveLength(4);
    });

    it('settings.json with only whitespace → treats as {}, adds 4 hooks', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '  \n\t\n  ', 'utf-8');
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(Object.keys(r.settings.hooks!)).toHaveLength(4);
    });

    it('empty file logs "is empty, treating as {}" hint', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '', 'utf-8');
      const lines: string[] = [];
      await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: (l) => lines.push(l),
      });
      expect(lines.some((l) => l.includes('is empty, treating as {}'))).toBe(true);
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
      expect(Object.keys(written.hooks)).toHaveLength(4);
    });

    it('logs progress lines (cc settings path / repo path / handler count) on first write', async () => {
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
      // The setup-hooks log includes a "added N multi-cc-im hooks" line; we
      // assert the shape is present rather than the literal count to stay
      // robust to source-side count tweaks (the count is also covered by
      // the "added N" regex below and the structural assertions above).
      expect(joined).toMatch(/added \d+ multi-cc-im hooks/);
      expect(joined).toMatch(/total handlers now: \d+/);
    });
  });

  describe('no-op when already up-to-date', () => {
    async function listBackups(): Promise<string[]> {
      const all = await readdir(dirname(ccSettings));
      return all.filter((f) => f.startsWith('settings.json.bak.'));
    }

    it('second run with unchanged content makes no backup file', async () => {
      await run();
      expect(await listBackups()).toHaveLength(0); // first run created file from scratch
      await run();
      expect(await listBackups()).toHaveLength(0); // second run is no-op, still 0
    });

    it('second run returns backupPath undefined', async () => {
      await run();
      const r = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r.exitCode).toBe(0);
      expect(r.backupPath).toBeUndefined();
    });

    it('second run logs "already up-to-date" instead of "removed ... stale"', async () => {
      await run();
      const lines: string[] = [];
      await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: (l) => lines.push(l),
      });
      const joined = lines.join('\n');
      expect(joined).toContain('already up-to-date');
      expect(joined).not.toMatch(/removed \d+ stale/);
      expect(joined).not.toMatch(/added \d+ multi-cc-im hooks/);
    });

    it('settings.json with other-tool hooks already merged → re-run is no-op', async () => {
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            Notification: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: '/bin/notify' }],
              },
            ],
          },
        }),
        'utf-8',
      );
      await run(); // merges multi-cc-im 4 in alongside Notification entry
      const afterFirst = await readFile(ccSettings, 'utf-8');
      const backupsAfterFirst = await listBackups();

      const r2 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r2.exitCode).toBe(0);
      expect(r2.backupPath).toBeUndefined();
      const afterSecond = await readFile(ccSettings, 'utf-8');
      expect(afterSecond).toBe(afterFirst);
      expect(await listBackups()).toEqual(backupsAfterFirst);
    });

    it('changed ABS_PATH (user moved repo) → re-run is NOT a no-op (writes + backs up)', async () => {
      await run();
      const newRepoRoot = await mkdtemp(join(tmpdir(), 'mcim-setup-newrepo-'));
      try {
        const r = await runSetupHooksCommand({
          ccSettingsPath: ccSettings,
          repoRoot: newRepoRoot, // simulate moved repo
          log: () => {},
        });
        expect(r.exitCode).toBe(0);
        expect(r.backupPath).toBeDefined(); // backup taken because content changes
      } finally {
        await rm(newRepoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('preservation', () => {
    it('settings.json with non-multi-cc-im hooks under same event → preserves them, appends our matcher group', async () => {
      // Use SessionStart (a multi-cc-im-managed event) so the merge actually
      // appends our group — exercises the "preserve + append" path. A
      // non-managed event like UserPromptSubmit would be untouched and
      // wouldn't exercise the append side of this code path.
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  { type: 'command', command: '/usr/bin/some-other-tool announce' },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      expect(r.exitCode).toBe(0);
      const groups = r.settings.hooks!.SessionStart as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      expect(groups).toHaveLength(2);
      expect(groups[0]!.matcher).toBe('startup');
      expect(groups[0]!.hooks[0]!.command).toContain('some-other-tool');
      expect(groups[1]!.matcher).toBe('');
      expect(groups[1]!.hooks[0]!.command).toContain('multi-cc-im hook SessionStart');
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
        ['Notification', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop'].sort(),
      );
      const notification = hooks.Notification as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      expect(notification[0]!.hooks[0]!.command).toBe('/usr/bin/notify-send hi');
    });

    it('non-multi-cc-im hooks under a non-managed event (UserPromptSubmit) → preserved verbatim, multi-cc-im NOT appended there', async () => {
      // UserPromptSubmit is not one of the 4 events multi-cc-im subscribes to,
      // so a user's existing UserPromptSubmit entry should be left completely
      // alone (no fresh multi-cc-im group appended). This test guards against
      // a regression where the loop accidentally treats every event as managed.
      // (PreToolUse was previously the canonical "dropped event" for this
      // test, but it's been re-added per DD #51/#52 — UserPromptSubmit is the
      // current example of a genuinely non-managed event.)
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: '/usr/bin/some-other-tool log-prompt' },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      expect(r.exitCode).toBe(0);
      const groups = r.settings.hooks!.UserPromptSubmit as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBe('');
      expect(groups[0]!.hooks[0]!.command).toContain('some-other-tool');
      // No multi-cc-im command should have been added under UserPromptSubmit.
      expect(groups[0]!.hooks[0]!.command).not.toContain('multi-cc-im hook');
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
      // Use SessionStart (a multi-cc-im-managed event) so the stale path
      // gets pruned AND a fresh multi-cc-im group gets re-appended in the
      // same event — exercises the full prune+append cycle. A non-managed
      // event like UserPromptSubmit would only exercise pruning.
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{ type: 'command', command: '/usr/bin/foo' }],
              },
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook SessionStart',
                  },
                ],
              },
              {
                matcher: 'late',
                hooks: [{ type: 'command', command: '/usr/bin/bar' }],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const groups = r.settings.hooks!.SessionStart as Array<{
        matcher: string;
        hooks: Array<{ command: string }>;
      }>;
      // 2 preserved (startup → foo, late → bar) + 1 fresh multi-cc-im
      expect(groups).toHaveLength(3);
      const allCommands = groups.flatMap((g) => g.hooks.map((h) => h.command));
      expect(allCommands).toContain('/usr/bin/foo');
      expect(allCommands).toContain('/usr/bin/bar');
      expect(
        allCommands.filter((c) => c.includes('multi-cc-im hook SessionStart')),
      ).toHaveLength(1);
      expect(
        allCommands.filter((c) => c.includes('/old/path')),
      ).toHaveLength(0);
    });

    it('stale multi-cc-im handler in a matcher group with no others (under managed event) → entire group is dropped, fresh one takes its place', async () => {
      // Set the stale group under SessionStart (still managed) so we exercise
      // the "drop empty group, then add fresh" path end-to-end.
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
                    command: '/old/path/bin/multi-cc-im hook SessionStart',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const groups = r.settings.hooks!.SessionStart as Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string }>;
      }>;
      // Old multi-cc-im group dropped, only the fresh one remains.
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBe('');
      expect(groups[0]!.hooks).toHaveLength(1);
      expect(groups[0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook SessionStart`,
      );
    });

    it('stale multi-cc-im handler under a non-managed event (UserPromptSubmit) → group fully removed, event key pruned (NOT re-added)', async () => {
      // Migration path: a user upgrading from the 6-event version of
      // multi-cc-im has stale `UserPromptSubmit`/`PostToolUse` entries in
      // their settings.json. The prune logic should detect them via the
      // `bin/multi-cc-im hook ` substring and drop them. Since
      // UserPromptSubmit is not managed by the current 4-event version, no
      // fresh group is added, and the empty event key gets pruned out —
      // leaving only the 4 current events.
      // (PreToolUse was the canonical "dropped event" for this test before
      // it was re-added per DD #51/#52 — UserPromptSubmit is the current
      // example of a non-managed event with stale entries.)
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(
        ccSettings,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook UserPromptSubmit',
                  },
                ],
              },
            ],
          },
        }),
        'utf-8',
      );
      const r = await run();
      const hooks = r.settings.hooks!;
      expect(Object.keys(hooks).sort()).toEqual([
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
      ]);
      expect(hooks.UserPromptSubmit).toBeUndefined();
    });

    it('migration: full 6-event multi-cc-im settings (old version) → all 6 stale lines pruned, 4 fresh lines written', async () => {
      // End-to-end migration scenario: user previously ran setup-hooks under
      // the 6-event version. Running the new 4-event version should detect
      // every old multi-cc-im hook line via the `bin/multi-cc-im hook `
      // substring, prune them all, and write only the 4 current events
      // (SessionStart / PreToolUse / Stop / SessionEnd — PreToolUse re-added
      // per DD #51/#52 for the IM permission gate). The 2 truly dropped
      // events (UserPromptSubmit / PostToolUse) should NOT appear in the
      // output at all.
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
                    command: '/old/path/bin/multi-cc-im hook SessionStart',
                  },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook UserPromptSubmit',
                  },
                ],
              },
            ],
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
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook PostToolUse',
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
                    command: '/old/path/bin/multi-cc-im hook Stop',
                  },
                ],
              },
            ],
            SessionEnd: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: '/old/path/bin/multi-cc-im hook SessionEnd',
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
        Array<{ matcher: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>
      >;
      // Only the 4 current events remain — the 2 truly dropped events
      // (UserPromptSubmit / PostToolUse) were pruned entirely (their groups
      // had only the multi-cc-im command, which got dropped, leaving the
      // groups empty, which got pruned, leaving the event keys empty, which
      // got pruned). PreToolUse stale line was also dropped, then a fresh
      // PreToolUse group was re-added under the new repoRoot.
      expect(Object.keys(hooks).sort()).toEqual([
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
      ]);
      // No `/old/path` substring anywhere — every stale line cleanly removed.
      const allCommands = Object.values(hooks).flatMap((groups) =>
        groups.flatMap((g) => g.hooks.map((h) => h.command)),
      );
      expect(allCommands.filter((c) => c.includes('/old/path'))).toHaveLength(0);
      // All 4 current events point at the new repoRoot.
      expect(hooks.SessionStart![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook SessionStart`,
      );
      expect(hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook PreToolUse`,
      );
      expect(hooks.Stop![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook Stop`,
      );
      expect(hooks.SessionEnd![0]!.hooks[0]!.command).toBe(
        `${repoRoot}/bin/multi-cc-im hook SessionEnd`,
      );
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
      expect(Object.keys(hooks)).toHaveLength(4);
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

    it('multiple runs that actually change content → multiple timestamped backups, none overwritten', async () => {
      // Force two real writes by changing repoRoot between runs (simulates
      // user moving the multi-cc-im checkout). Same-content re-runs no-op
      // and don't create a backup — covered separately by the no-op tests.
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(ccSettings, '{}', 'utf-8');

      const r1 = await runSetupHooksCommand({
        ccSettingsPath: ccSettings,
        repoRoot,
        log: () => {},
      });
      expect(r1.backupPath).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));

      const newRepoRoot = await mkdtemp(join(tmpdir(), 'mcim-setup-newrepo-'));
      try {
        const r2 = await runSetupHooksCommand({
          ccSettingsPath: ccSettings,
          repoRoot: newRepoRoot,
          log: () => {},
        });
        expect(r2.backupPath).toBeDefined();
        expect(r2.backupPath).not.toBe(r1.backupPath);

        const backups = (await readdir(dirname(ccSettings))).filter((f) =>
          f.startsWith('settings.json.bak.'),
        );
        expect(backups).toHaveLength(2);
      } finally {
        await rm(newRepoRoot, { recursive: true, force: true });
      }
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
