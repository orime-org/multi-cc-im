import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

/**
 * One-shot installer that registers multi-cc-im's hook receiver into
 * `~/.codex/config.toml`'s `[hooks]` tables. Mirror of
 * `apps/multi-cc-im/src/setup-hooks.ts` (which targets
 * `~/.claude/settings.json` for cli-cc), adapted to:
 *
 * - TOML instead of JSON (codex config format) — uses `smol-toml` for
 *   parse + stringify so existing user content is preserved across the
 *   round-trip.
 * - `[hooks]` + nested `[[hooks.<EventName>]]` + `[[hooks.<EventName>.hooks]]`
 *   array-of-tables structure per codex docs
 *   (https://developers.openai.com/codex/config-sample).
 * - 4 event subscriptions — SessionStart / PreToolUse / PermissionRequest /
 *   Stop — matching the four events cli-codex's hook-receiver dispatches on.
 *
 * Safety contract (per [[feedback_user_dotfile_backup]]):
 * - Before mutating `~/.codex/config.toml`, copy it to
 *   `~/.codex/config.toml.bak.<ISO>` so users can `cp` back if anything
 *   regresses. Backup only when the file actually exists and our edit
 *   will be a no-op-superset of pre-existing content (idempotent reruns
 *   on already-installed configs skip both backup and write).
 * - Atomic write: temp file in the same directory + rename, so a crash
 *   mid-write leaves either the old content or the new content intact,
 *   never a half-written file.
 *
 * Subscribed events:
 *
 * | Event | matcher | Why |
 * |---|---|---|
 * | `SessionStart` | `'^startup$'` (codex matcher applies to `source`) | Lifecycle no-op; identity comes from official thread-id titles. |
 * | `PreToolUse` | `'.*'` (all tools) | Permission gate forward — daemon decides per-tool from received payload. |
 * | `PermissionRequest` | `'.*'` (all tools) | Codex-native escalation dialog — distinct from PreToolUse. |
 * | `Stop` | (matcher unsupported on Stop per docs) | Forward cc reply to IM via `last_assistant_message`. |
 *
 * @example
 *   await runCodexSetupHooks({
 *     binaryPath: '/opt/homebrew/bin/multi-cc-im',
 *     timeoutSec: 600,
 *   });
 */

const STATUS_MSG = 'multi-cc-im hook';

/** Command handler generated and owned by the multi-cc-im installer. */
export interface CodexHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

/** Matcher group generated for a subscribed event. */
export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

/** Event-only map of generated handlers, excluding user hook state. */
export type CodexHooksMap = Record<string, CodexHookGroup[]>;

/** Complete hooks table; unowned data must survive installation unchanged. */
export type CodexHooksConfig = Record<string, unknown>;

export interface RunCodexSetupHooksOpts {
  /** Absolute path to the multi-cc-im binary the hook subprocess invokes. */
  binaryPath: string;
  /**
   * Override the codex config home (default `$CODEX_HOME` or `~/.codex`).
   * Tests inject a temp dir; production code passes nothing.
   */
  codexHome?: string;
  /** Per-hook timeout in seconds. Default 600 (codex's own default). */
  timeoutSec?: number;
  /** Plain log sink for the installer progress. Default no-op. */
  log?: (line: string) => void;
}

export interface CodexSetupHooksResult {
  /** Absolute path of the config file that was written (or would be). */
  configPath: string;
  /**
   * Path of the timestamped backup of the previous config.toml (when one
   * existed). User can `cp <backupPath> <configPath>` to restore.
   */
  backupPath?: string;
  /** `true` when the file changed; `false` when already up-to-date. */
  changed: boolean;
  /** Total hook handlers registered (sum across events). */
  handlerCount: number;
}

/**
 * Resolve `~/.codex/config.toml`, honoring the `$CODEX_HOME` env var
 * codex itself respects. Per codex source `codex-rs/core/config.rs`.
 */
export function defaultCodexConfigPath(codexHomeOverride?: string): string {
  if (codexHomeOverride !== undefined) {
    return resolve(codexHomeOverride, 'config.toml');
  }
  const envHome = process.env['CODEX_HOME'];
  if (typeof envHome === 'string' && envHome.length > 0) {
    return resolve(envHome, 'config.toml');
  }
  return join(homedir(), '.codex', 'config.toml');
}

/** Cheap stat-existence probe. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic write: temp file in same directory + rename, so a crash
 * mid-write leaves either the old content or the new content intact.
 * Mode 0644 (config is not secret).
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o644 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Build the four event entries multi-cc-im wants registered. `command`
 * is `node <binaryPath> hook-receiver-codex` so the codex hook
 * subprocess invokes the daemon's codex receiver path.
 */
export function buildMultiCcImHookGroups(
  binaryPath: string,
  timeoutSec: number,
): CodexHooksMap {
  const command = `node ${JSON.stringify(binaryPath)} hook-receiver-codex`;
  const handler = (eventLabel: string): CodexHookEntry => ({
    type: 'command',
    command,
    timeout: timeoutSec,
    statusMessage: `${STATUS_MSG} (${eventLabel})`,
  });
  return {
    SessionStart: [{ matcher: '^startup$', hooks: [handler('SessionStart')] }],
    PreToolUse: [{ matcher: '.*', hooks: [handler('PreToolUse')] }],
    PermissionRequest: [{ matcher: '.*', hooks: [handler('PermissionRequest')] }],
    Stop: [{ hooks: [handler('Stop')] }],
  };
}

/**
 * Update installer-owned handlers in place and append only missing events.
 * Codex trust keys include group/handler positions, so neither users' handlers
 * nor existing generated handlers may move. Exposed for isolated merge tests.
 * @param rawHooks Complete parsed hooks table, including persisted state.
 * @param generated Event handlers produced by this installer.
 * @returns A new table preserving unowned data and all existing positions.
 * @example
 * const hooks = mergeCodexHooks(parsed.hooks, buildMultiCcImHookGroups(path, 600));
 */
export function mergeCodexHooks(rawHooks: unknown, generated: CodexHooksMap): CodexHooksConfig {
  const existing = isRecord(rawHooks) ? rawHooks : {};
  const out: CodexHooksConfig = { ...existing };
  for (const [event, generatedGroups] of Object.entries(generated)) {
    const desired = generatedGroups[0]?.hooks[0];
    if (!desired) continue;
    let found = false;
    const current = existing[event];
    const groups: unknown[] = Array.isArray(current) ? current : [];
    const updated = groups.map(group => {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) return group;
      const handlers: unknown[] = group['hooks'];
      return { ...group, hooks: handlers.map(handler => {
        if (isRecord(handler) && handler['statusMessage'] === desired.statusMessage) {
          found = true;
          return desired;
        }
        return handler;
      }) };
    });
    out[event] = found ? updated : [...updated, ...generatedGroups];
  }
  return out;
}

function countHandlers(hooks: CodexHooksConfig): number {
  let count = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (isRecord(group) && Array.isArray(group['hooks'])) count += group['hooks'].length;
    }
  }
  return count;
}

/**
 * Read + parse the existing `~/.codex/config.toml` if it exists.
 * Returns `{ parsed: {}, raw: '' }` for missing / empty files so the
 * caller can treat them as the trivial starting state.
 */
async function readCodexConfig(
  configPath: string,
): Promise<{ parsed: Record<string, unknown>; raw: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { parsed: {}, raw: '' };
    }
    throw err;
  }
  if (raw.trim().length === 0) return { parsed: {}, raw };
  const parsed = parseToml(raw) as Record<string, unknown>;
  return { parsed, raw };
}

/**
 * Install / re-install multi-cc-im hook handlers into the user's codex
 * config. Idempotent: rerunning on an already-installed config detects
 * no-op and skips both backup and write.
 */
export async function runCodexSetupHooks(
  opts: RunCodexSetupHooksOpts,
): Promise<CodexSetupHooksResult> {
  const log = opts.log ?? ((): void => {});
  const timeoutSec = opts.timeoutSec ?? 600;
  const configPath = defaultCodexConfigPath(opts.codexHome);

  log(`multi-cc-im setup-hooks (codex):`);
  log(`  config: ${configPath}`);
  log(`  binary: ${opts.binaryPath}`);

  await mkdir(dirname(configPath), { recursive: true });

  const { parsed: existingConfig } = await readCodexConfig(configPath);
  const existingHooksRaw =
    existingConfig['hooks'] !== undefined && typeof existingConfig['hooks'] === 'object'
      ? (existingConfig['hooks'] as Record<string, unknown>)
      : {};

  const merged = mergeCodexHooks(
    existingHooksRaw,
    buildMultiCcImHookGroups(opts.binaryPath, timeoutSec),
  );

  // TOML can reorder tables. Structural equality avoids rewriting reviewed
  // config merely because object keys have a different insertion order.
  const tui = z.object({ terminal_title: z.array(z.string()).optional() }).passthrough().parse(existingConfig['tui'] ?? {});
  // Preserve the verified native defaults when no custom selection exists.
  const items = tui.terminal_title ?? ['activity', 'thread-name', 'project-name'];
  const terminalTitle = items.some(item => item === 'thread-id' || item === 'session-id') ? items : [...items, 'thread-id'];
  const nextTui = { ...tui, terminal_title: terminalTitle };
  const alreadyInstalled = isDeepStrictEqual(existingHooksRaw, merged) && isDeepStrictEqual(existingConfig['tui'], nextTui);

  // Native /hooks reviews and refreshes hook trust; /terminal-title applies
  // title selections to an already-running TUI. Do not require a blind restart.
  if (alreadyInstalled) {
    log(`  ✓ already up-to-date (${countHandlers(merged)} handlers); no write needed.`);
    log(CODEX_HOOK_REVIEW_GUIDANCE);
    return {
      configPath,
      changed: false,
      handlerCount: countHandlers(merged),
    };
  }

  // Backup before mutating; user can restore via cp.
  let backupPath: string | undefined;
  if (await pathExists(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${configPath}.bak.${ts}`;
    await copyFile(configPath, backupPath);
    log(`  ✓ backup: ${backupPath}`);
  }

  // Preserve unrelated configuration and TUI fields while adding native title
  // identity and updating only the installer-owned hook definitions.
  const nextConfig: Record<string, unknown> = { ...existingConfig, hooks: merged, tui: nextTui };
  const out = stringifyToml(nextConfig);
  await atomicWrite(configPath, out);

  log(`  ✓ wrote ${countHandlers(merged)} handlers across ${Object.values(merged).filter(Array.isArray).length} events.`);
  log(CODEX_HOOK_REVIEW_GUIDANCE);

  return {
    configPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    changed: true,
    handlerCount: countHandlers(merged),
  };
}

/** Native review and live-title activation guidance, also emitted on no-op setup. */
export const CODEX_HOOK_REVIEW_GUIDANCE =
  '  Review bridge hooks in Codex /hooks without changing your approval policy. ' +
  'For an already-running TUI, enable thread-id in /terminal-title; new TUIs read the saved title configuration. ' +
  'Missing or ambiguous thread identity pauses IM forwarding; native terminal handling remains available.';
