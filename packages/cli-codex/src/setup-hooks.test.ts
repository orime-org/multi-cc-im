import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  runCodexSetupHooks,
  pruneExistingHooks,
  buildMultiCcImHookGroups,
  defaultCodexConfigPath,
  WARN_CODEX_RESTART_LINE,
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

describe('pruneExistingHooks', () => {
  it('returns empty for non-object input', () => {
    expect(pruneExistingHooks(null)).toEqual({ hooks: {}, removed: 0 });
    expect(pruneExistingHooks('string' as unknown)).toEqual({ hooks: {}, removed: 0 });
  });

  it('removes only multi-cc-im-tagged entries; keeps user entries', () => {
    const input = {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'echo ours', statusMessage: 'multi-cc-im hook (Stop)' },
            { type: 'command', command: 'echo user', statusMessage: 'user-tool' },
          ],
        },
      ],
    };
    const { hooks, removed } = pruneExistingHooks(input);
    expect(removed).toBe(1);
    expect(hooks['Stop']?.[0]?.hooks).toEqual([
      { type: 'command', command: 'echo user', statusMessage: 'user-tool' },
    ]);
  });

  it('drops an event entirely when all its entries were ours', () => {
    const input = {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'x', statusMessage: 'multi-cc-im hook (Stop)' },
          ],
        },
      ],
    };
    const { hooks, removed } = pruneExistingHooks(input);
    expect(removed).toBe(1);
    expect(hooks['Stop']).toBeUndefined();
  });

  it('preserves matcher on kept groups', () => {
    const input = {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'user-bash-hook', statusMessage: 'user' }],
        },
      ],
    };
    const { hooks } = pruneExistingHooks(input);
    expect(hooks['PreToolUse']?.[0]?.matcher).toBe('Bash');
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

  it('emits codex-restart warning when changed=true (real toml write)', async () => {
    const lines: string[] = [];
    const result = await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
      log: (l) => lines.push(l),
    });
    expect(result.changed).toBe(true);
    expect(lines).toContain(WARN_CODEX_RESTART_LINE);
  });

  it('does NOT emit codex-restart warning on idempotent rerun (changed=false)', async () => {
    // First run actually writes — warning expected
    await runCodexSetupHooks({ binaryPath: BIN, codexHome: sandboxRoot });
    // Second run is a no-op — warning would be noise
    const lines: string[] = [];
    const result = await runCodexSetupHooks({
      binaryPath: BIN,
      codexHome: sandboxRoot,
      log: (l) => lines.push(l),
    });
    expect(result.changed).toBe(false);
    expect(lines).not.toContain(WARN_CODEX_RESTART_LINE);
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
