import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  runCodexSetupHooks,
  mergeCodexHooks,
  buildMultiCcImHookGroups,
  defaultCodexConfigPath,
  CODEX_HOOK_REVIEW_GUIDANCE,
  type CodexHooksMap,
} from './setup-hooks.js';

const BIN = '/opt/homebrew/bin/multi-cc-im';

let sandboxRoot: string;

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), 'cli-codex-setup-hooks-'));
});

afterEach(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe('defaultCodexConfigPath', () => {
  it('appends thread-id while preserving title order, hook trust and unrelated TUI settings', async () => {
    const path = join(sandboxRoot, 'config.toml');
    const config = { tui: { terminal_title: ['project-name', 'activity'], notifications: false },
      hooks: { ...buildMultiCcImHookGroups(BIN, 600), state: { review: { enabled: false, trusted_hash: 'owner-reviewed' } } } };
    const original = stringifyToml(config);
    await writeFile(path, original);
    const result = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(result.changed).toBe(true);
    expect(await readFile(result.backupPath!, 'utf8')).toBe(original);
    expect(parseToml(await readFile(path, 'utf8'))).toMatchObject({ ...config,
      tui: { ...config.tui, terminal_title: ['project-name', 'activity', 'thread-id'] } });
    expect((await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot })).changed).toBe(false);
  });
  it('preserves an explicitly empty title and adds only thread-id', async () => {
    const path = join(sandboxRoot, 'config.toml');
    await writeFile(path, stringifyToml({ tui: { terminal_title: [] } }));
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(parseToml(await readFile(path, 'utf8'))).toMatchObject({ tui: { terminal_title: ['thread-id'] } });
  });
  it('uses explicit override when provided', () => {
    const p = defaultCodexConfigPath('/custom/codex/home');
    expect(p).toBe('/custom/codex/home/config.toml');
  });

  it('falls back to ~/.codex/config.toml when no override', () => {
    const orig = process.env['CODEX_HOME'];
    delete process.env['CODEX_HOME'];
    try {
      const p = defaultCodexConfigPath();
      expect(p.endsWith('/.codex/config.toml')).toBe(true);
    } finally {
      if (orig !== undefined) process.env['CODEX_HOME'] = orig;
    }
  });
});

describe('buildMultiCcImHookGroups', () => {
  it('emits the 4 subscribed events with correct matchers', () => {
    const groups = buildMultiCcImHookGroups(BIN, 600);
    expect(Object.keys(groups).sort()).toEqual([
      'PermissionRequest',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
    expect(groups['SessionStart']?.[0]?.matcher).toBe('^startup$');
    expect(groups['PreToolUse']?.[0]?.matcher).toBe('.*');
    expect(groups['PermissionRequest']?.[0]?.matcher).toBe('.*');
    // Stop intentionally has no matcher per codex docs
    expect(groups['Stop']?.[0]?.matcher).toBeUndefined();
  });

  it('embeds binary path via JSON.stringify quoting (handles spaces)', () => {
    const groups = buildMultiCcImHookGroups('/path with space/multi-cc-im', 600);
    const cmd = groups['Stop']?.[0]?.hooks[0]?.command;
    expect(cmd).toBe('node "/path with space/multi-cc-im" hook-receiver-codex');
  });

  it('tags every handler with statusMessage containing "multi-cc-im hook"', () => {
    const groups = buildMultiCcImHookGroups(BIN, 600);
    for (const event of Object.keys(groups)) {
      const sm = groups[event]?.[0]?.hooks[0]?.statusMessage;
      expect(sm).toMatch(/^multi-cc-im hook \(/);
    }
  });
});

describe('mergeCodexHooks', () => {
  it('treats missing or non-table input as an empty hooks table', () => {
    expect(mergeCodexHooks(null, {})).toEqual({});
    expect(mergeCodexHooks('invalid', {})).toEqual({});
  });

  it('preserves state, group metadata, and complete third-party definitions without moving entries', () => {
    const input = {
      state: { 'config:PreToolUse:0:1': { enabled: false, trusted_hash: 'reviewed-hash' } },
      PreToolUse: [{
        matcher: 'Bash',
        description: 'User-owned group metadata',
        hooks: [
          { type: 'command', command: 'audit', async: true, additionalContextLimit: 4096 },
          { type: 'prompt', prompt: 'Review', custom: { enabled: true } },
          { type: 'command', command: 'old', statusMessage: 'multi-cc-im hook (PreToolUse)' },
        ],
      }],
      FutureEvent: [{ custom: true }],
      EmptyEvent: [],
    };
    const before = structuredClone(input);
    const desired = buildMultiCcImHookGroups(BIN, 600)['PreToolUse']!;
    expect(mergeCodexHooks(input, { PreToolUse: desired })).toEqual({
      ...before,
      PreToolUse: [{ ...before.PreToolUse[0], hooks: [...before.PreToolUse[0]!.hooks.slice(0, 2), desired[0]!.hooks[0]] }],
    });
    expect(input).toEqual(before);
  });

  it('appends missing handlers without claiming a third-party status mentioning multi-cc-im', () => {
    const input = { Stop: [{ hooks: [{ type: 'command', command: 'notify', statusMessage: 'Notify multi-cc-im observer' }] }] };
    const desired = buildMultiCcImHookGroups(BIN, 600)['Stop']!;
    expect(mergeCodexHooks(input, { Stop: desired })).toEqual({ Stop: [...input.Stop, ...desired] });
  });
});

describe('runCodexSetupHooks', () => {
  it('creates config.toml from scratch when none exists', async () => {
    const result = await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
    });
    expect(result.changed).toBe(true);
    expect(result.handlerCount).toBe(4);
    expect(result.backupPath).toBeUndefined();
    const raw = await readFile(result.configPath, 'utf8');
    const parsed = parseToml(raw) as unknown as { hooks: CodexHooksMap };
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      'PermissionRequest',
      'PreToolUse',
      'SessionStart',
      'Stop',
    ]);
  });

  it('idempotent: second run reports no change + no new backup', async () => {
    const first = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(first.changed).toBe(true);

    const second = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
  });

  it('preserves non-hooks tables verbatim across round-trip', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    const userToml = `model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.example]
command = "uvx"
args = ["mcp-server-example"]
`;
    await writeFile(configPath, userToml, 'utf8');

    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });

    const raw = await readFile(configPath, 'utf8');
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed['model']).toBe('gpt-5-codex');
    expect(parsed['approval_policy']).toBe('on-request');
    expect(parsed['mcp_servers']).toEqual({
      example: { command: 'uvx', args: ['mcp-server-example'] },
    });
    expect(parsed['hooks']).toBeDefined();
  });

  it('creates timestamped backup when existing config is modified', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    await writeFile(configPath, 'model = "gpt-5-codex"\n', 'utf8');

    const result = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath!.startsWith(`${configPath}.bak.`)).toBe(true);
    const backupRaw = await readFile(result.backupPath!, 'utf8');
    expect(backupRaw).toBe('model = "gpt-5-codex"\n');
  });

  it('preserves user-authored hook entries on rerun (re-install)', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    const userToml = `[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "user-bash-hook"
statusMessage = "user-tool"
`;
    await writeFile(configPath, userToml, 'utf8');

    const first = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(first.changed).toBe(true);

    const second = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    // Second run still idempotent; user entry preserved through both passes.
    expect(second.changed).toBe(false);

    const raw = await readFile(configPath, 'utf8');
    expect(raw).toContain('user-bash-hook');
    expect(raw).toContain('multi-cc-im hook');
  });

  it('preserves trust/disabled state and third-party fields through installation and a byte-stable rerun', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    const existing = {
      approval_policy: 'on-request',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-audit', async: true, additionalContextLimit: 4096 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'old', statusMessage: 'multi-cc-im hook (Stop)' }] }],
        state: {
          'user-audit': { enabled: false, trusted_hash: 'reviewed-user-hash' },
          'bridge-stop': { enabled: true, trusted_hash: 'reviewed-bridge-hash' },
        },
      },
    };
    const original = stringifyToml(existing);
    await writeFile(configPath, original);
    const first = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(first.changed).toBe(true);
    expect(first.handlerCount).toBe(5);
    expect(await readFile(first.backupPath!, 'utf8')).toBe(original);
    const installed = await readFile(configPath, 'utf8');
    const parsed = parseToml(installed) as Record<string, unknown>;
    expect(parsed['approval_policy']).toBe('on-request');
    expect(parsed['hooks']).toMatchObject({
      state: existing.hooks.state,
      PreToolUse: [existing.hooks.PreToolUse[0], ...buildMultiCcImHookGroups(BIN, 600)['PreToolUse']!],
    });
    const second = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(await readFile(configPath, 'utf8')).toBe(installed);
    expect((await readdir(sandboxRoot)).filter(name => name.includes('.bak.'))).toHaveLength(1);
  });

  it('updates owned handlers in place so positional trust/disabled keys keep their meaning', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    const firstUser = { type: 'command', command: 'audit-one', async: true };
    const secondUser = { type: 'command', command: 'audit-two', additionalContextLimit: 2048 };
    const state = { 'position-0-1': { enabled: false, trusted_hash: 'user-one' }, 'position-1-0': { enabled: true, trusted_hash: 'user-two' } };
    const config = { hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'old', statusMessage: 'multi-cc-im hook (Stop)' }, firstUser] },
        { hooks: [secondUser] },
      ],
      state,
    } };
    await writeFile(configPath, stringifyToml(config));
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    const parsed = parseToml(await readFile(configPath, 'utf8')) as unknown as { hooks: { Stop: { hooks: unknown[] }[]; state: unknown } };
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0]!.hooks[0]).toEqual(buildMultiCcImHookGroups(BIN, 600)['Stop']![0]!.hooks[0]);
    expect(parsed.hooks.Stop[0]!.hooks[1]).toEqual(firstUser);
    expect(parsed.hooks.Stop[1]!.hooks[0]).toEqual(secondUser);
    expect(parsed.hooks.state).toEqual(state);
    expect((await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot })).changed).toBe(false);
  });

  it('honors custom timeoutSec on all handlers', async () => {
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot, timeoutSec: 300 });
    const raw = await readFile(join(sandboxRoot, 'config.toml'), 'utf8');
    const parsed = parseToml(raw) as unknown as { hooks: CodexHooksMap };
    for (const event of Object.keys(parsed.hooks)) {
      const timeout = parsed.hooks[event]?.[0]?.hooks[0]?.timeout;
      expect(timeout).toBe(300);
    }
  });

  it('logs to provided log sink', async () => {
    const lines: string[] = [];
    await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes('config:'))).toBe(true);
    expect(lines.some((l) => l.includes('binary:'))).toBe(true);
  });

  it('emits native hook/title review guidance on real toml write (changed=true)', async () => {
    const lines: string[] = [];
    const result = await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
      log: (l) => lines.push(l),
    });
    expect(result.changed).toBe(true);
    expect(lines.filter((l) => l === CODEX_HOOK_REVIEW_GUIDANCE)).toHaveLength(1);
  });

  it('emits native hook/title review guidance ALSO on idempotent rerun (changed=false)', async () => {
    // Even a no-op setup may be followed by a TUI that has not applied the
    // reviewed hooks or the saved title selection. Keep the native guidance.
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    const lines: string[] = [];
    const result = await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
      log: (l) => lines.push(l),
    });
    expect(result.changed).toBe(false);
    expect(lines.filter((l) => l === CODEX_HOOK_REVIEW_GUIDANCE)).toHaveLength(1);
  });

  it('atomic write: no temp file lingers after write', async () => {
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    const entries = await readdir(sandboxRoot);
    for (const e of entries) {
      expect(e.includes('.tmp.')).toBe(false);
    }
  });

  it('handles empty existing config file as missing', async () => {
    const configPath = join(sandboxRoot, 'config.toml');
    await writeFile(configPath, '', 'utf8');
    const result = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    expect(result.changed).toBe(true);
    expect(result.handlerCount).toBe(4);
  });

  it('config file written with mode 0644 (non-secret)', async () => {
    const result = await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    const st = await stat(result.configPath);
    // mode lower 9 bits — owner+group+other rwx
    expect(st.mode & 0o777).toBe(0o644);
  });
});
