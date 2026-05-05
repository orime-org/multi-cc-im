import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '@multi-cc-im/storage-files';

/**
 * The 6 cc hook events multi-cc-im needs to subscribe to. Order matches
 * `examples/claude-settings.json` template + README Quick Start step 4.
 *
 * - `SessionStart` — captures `WEZTERM_PANE` env, populates paneToSession
 * - `UserPromptSubmit` — events.jsonl entry (analytics)
 * - `PreToolUse` / `PostToolUse` — events.jsonl entries (analytics)
 * - `Stop` — assistant turn complete; bridge forwards `last_assistant_message`
 *   to wechat origin via `lastReplyCtxBySession`
 * - `SessionEnd` — drives PaneAlive "graceful exit" signal
 */
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

export interface RunSetupHooksOpts {
  /**
   * Override the cc settings.json path. Default `~/.claude/settings.json`.
   * Tests inject a sandbox path.
   */
  ccSettingsPath?: string;
  /**
   * Override repo root. Default: auto-detected from `import.meta.url`
   * (`apps/multi-cc-im/src/setup-hooks.ts` → `../../..`). Bundled build
   * (`apps/multi-cc-im/dist/cli.js`) has the same `../../..` depth.
   */
  repoRoot?: string;
  /** Override `os.homedir()`. */
  home?: string;
  /** Default writes to stderr; tests inject a spy to assert log content. */
  log?: (line: string) => void;
}

export interface SetupHooksResult {
  exitCode: number;
  stderr: string;
  /** Path of the cc settings.json that was written (when exit 0). */
  writtenTo?: string;
  /** Total hooks registered after write (multi-cc-im 6 + others preserved). */
  hookCount?: number;
  /**
   * Path of the timestamped backup of the previous settings.json (when one
   * existed). User can `cp <backupPath> <ccSettingsPath>` to restore if our
   * write went sideways.
   */
  backupPath?: string;
}

/**
 * Implement `multi-cc-im setup-hooks`. Idempotent merge of multi-cc-im's 6
 * hook commands into `~/.claude/settings.json`:
 *
 * - **Missing file or empty `{}`**: write a fresh `{ "hooks": [...] }` with
 *   our 6 commands.
 * - **Existing settings with non-multi-cc-im hooks**: preserve them, append
 *   our 6.
 * - **Existing settings with stale multi-cc-im hooks** (e.g. user moved the
 *   repo, ABS_PATH changed): drop those by detecting `bin/multi-cc-im hook`
 *   substring in `command`, then add fresh 6 with current absolute path.
 * - **Other top-level fields** (e.g. `otherSetting`): preserved verbatim.
 *
 * Atomic write via `atomicWrite` (same-dir tmp + fsync + rename, mode 0600 —
 * matches cc's own settings.json default permission).
 *
 * Errors:
 * - Invalid JSON in existing settings.json → exit 1, settings.json untouched.
 * - File system permission errors → exit 1.
 */
export async function runSetupHooksCommand(
  opts: RunSetupHooksOpts = {},
): Promise<SetupHooksResult> {
  const home = opts.home ?? homedir();
  const ccSettingsPath = opts.ccSettingsPath ?? `${home}/.claude/settings.json`;
  const repoRoot = opts.repoRoot ?? resolveDefaultRepoRoot();
  const log = opts.log ?? defaultLog;

  log(`multi-cc-im setup-hooks`);
  log(`  cc settings.json: ${ccSettingsPath}`);
  log(`  multi-cc-im repo: ${repoRoot}`);

  const wrapperPath = `${repoRoot}/bin/multi-cc-im`;
  const ourHooks = HOOK_EVENTS.map((event) => ({
    matcher: '*',
    type: 'command' as const,
    command: `${wrapperPath} hook ${event}`,
  }));

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(ccSettingsPath, 'utf-8');
    try {
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch (parseErr) {
      return {
        exitCode: 1,
        stderr: `multi-cc-im setup-hooks: failed to parse JSON in ${ccSettingsPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log(`  (cc settings.json not found, will create)`);
    } else {
      return {
        exitCode: 1,
        stderr: `multi-cc-im setup-hooks: failed to read ${ccSettingsPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const existingHooks = Array.isArray(existing.hooks)
    ? (existing.hooks as unknown[])
    : [];

  // Filter out any existing multi-cc-im hooks (idempotent re-run; replaces
  // stale entries with possibly-different ABS_PATH).
  const otherHooks = existingHooks.filter((h) => {
    if (typeof h !== 'object' || h === null) return true;
    const cmd = (h as { command?: unknown }).command;
    if (typeof cmd !== 'string') return true;
    return !cmd.includes('bin/multi-cc-im hook ');
  });
  const removedCount = existingHooks.length - otherHooks.length;

  const newSettings: Record<string, unknown> = {
    ...existing,
    hooks: [...otherHooks, ...ourHooks],
  };

  await mkdir(dirname(ccSettingsPath), { recursive: true });

  // Backup BEFORE write — protects user's other cc settings (mcp servers /
  // model preferences / theme etc.) in case our merge logic ever corrupts.
  // Timestamped name never overwrites prior backups; user can restore any.
  let backupPath: string | undefined;
  try {
    await stat(ccSettingsPath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${ccSettingsPath}.bak.${ts}`;
    await copyFile(ccSettingsPath, backupPath);
    log(`  ✓ backup: ${backupPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        exitCode: 1,
        stderr: `multi-cc-im setup-hooks: failed to backup ${ccSettingsPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // ENOENT = no existing file to backup; that's fine
  }

  await atomicWrite(ccSettingsPath, `${JSON.stringify(newSettings, null, 2)}\n`);

  if (removedCount > 0) {
    log(
      `  ✓ removed ${removedCount} stale multi-cc-im hook(s) (likely from previous repo path)`,
    );
  }
  log(
    `  ✓ added 6 multi-cc-im hooks (events: ${HOOK_EVENTS.join(', ')})`,
  );
  const totalHooks = (newSettings.hooks as unknown[]).length;
  if (otherHooks.length > 0) {
    log(
      `  ✓ total hooks now: ${totalHooks} (${otherHooks.length} from other tools preserved)`,
    );
  } else {
    log(`  ✓ total hooks now: ${totalHooks}`);
  }
  log(`  done. Test with: \`./bin/multi-cc-im start\` then start cc in any wezterm tab.`);

  return {
    exitCode: 0,
    stderr: '',
    writtenTo: ccSettingsPath,
    hookCount: totalHooks,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

function resolveDefaultRepoRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // From either `apps/multi-cc-im/src/setup-hooks.ts` or `apps/multi-cc-im/dist/cli.js`,
  // 3 levels up reaches the repo root (where `bin/multi-cc-im` lives).
  return resolve(__dirname, '../../..');
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}
