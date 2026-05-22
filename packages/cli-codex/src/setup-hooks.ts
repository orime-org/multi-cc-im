import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
 * | `SessionStart` | `'^startup$'` (codex matcher applies to `source`) | Register pane on real session start; skip resume/clear/compact. |
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

const HOOK_TAG = 'multi-cc-im';
const STATUS_MSG = 'multi-cc-im hook';

export interface CodexHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

export type CodexHooksMap = Record<string, CodexHookGroup[]>;

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

/**
 * Strip any `[[hooks.<Event>.hooks]]` entry the daemon previously
 * installed (identified by `statusMessage` containing the HOOK_TAG).
 * Returns the cleaned hooks map plus a removed-count for the installer
 * log. Leaves user-authored entries untouched (entries without the tag).
 */
export function pruneExistingHooks(rawHooks: unknown): {
  hooks: CodexHooksMap;
  removed: number;
} {
  if (rawHooks === null || typeof rawHooks !== 'object') {
    return { hooks: {}, removed: 0 };
  }
  const out: CodexHooksMap = {};
  let removed = 0;
  for (const [event, groupsRaw] of Object.entries(rawHooks as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) continue;
    const groups: CodexHookGroup[] = [];
    for (const grpRaw of groupsRaw) {
      if (grpRaw === null || typeof grpRaw !== 'object') continue;
      const grp = grpRaw as { matcher?: unknown; hooks?: unknown };
      const handlersRaw = grp.hooks;
      if (!Array.isArray(handlersRaw)) continue;
      const kept: CodexHookEntry[] = [];
      for (const h of handlersRaw) {
        if (h === null || typeof h !== 'object') continue;
        const handler = h as Partial<CodexHookEntry>;
        const isOurs =
          typeof handler.statusMessage === 'string' &&
          handler.statusMessage.includes(HOOK_TAG);
        if (isOurs) {
          removed += 1;
        } else if (handler.type === 'command' && typeof handler.command === 'string') {
          kept.push({
            type: 'command',
            command: handler.command,
            ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
            ...(typeof handler.statusMessage === 'string'
              ? { statusMessage: handler.statusMessage }
              : {}),
          });
        }
      }
      if (kept.length > 0) {
        const matcher = typeof grp.matcher === 'string' ? grp.matcher : undefined;
        groups.push({
          ...(matcher !== undefined ? { matcher } : {}),
          hooks: kept,
        });
      }
    }
    if (groups.length > 0) {
      out[event] = groups;
    }
  }
  return { hooks: out, removed };
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

function mergeHooks(existing: CodexHooksMap, ours: CodexHooksMap): CodexHooksMap {
  const out: CodexHooksMap = { ...existing };
  for (const [event, groups] of Object.entries(ours)) {
    out[event] = [...(existing[event] ?? []), ...groups];
  }
  return out;
}

function countHandlers(hooks: CodexHooksMap): number {
  let n = 0;
  for (const groups of Object.values(hooks)) {
    for (const g of groups) n += g.hooks.length;
  }
  return n;
}

/**
 * Compare two hooks maps for installer idempotency. JSON.stringify
 * round-trip is sufficient: TOML round-tripping the same content via
 * smol-toml is byte-stable for the subset of TOML we write.
 */
function hooksMapsEqual(a: CodexHooksMap, b: CodexHooksMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const { hooks: cleanedHooks, removed } = pruneExistingHooks(existingHooksRaw);
  if (removed > 0) {
    log(`  - pruned ${removed} pre-existing multi-cc-im handler(s) for re-install`);
  }

  const ours = buildMultiCcImHookGroups(opts.binaryPath, timeoutSec);
  const merged = mergeHooks(cleanedHooks, ours);

  // Idempotency check: compare the merged result (`merged`) against the
  // hooks block we would have produced from a no-op pass (the `cleanedHooks`
  // alone is wrong — that omits ours; we want `merged === existingHooks`
  // up to the parts we own). Equivalent test: are `existingHooks` minus
  // our own entries the same as cleaned, AND does merged equal what was
  // already there?
  const alreadyInstalled = hooksMapsEqual(existingHooksRaw as CodexHooksMap, merged);

  if (alreadyInstalled) {
    log(`  ✓ already up-to-date (${countHandlers(merged)} handlers); no write needed.`);
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

  // Write merged config back. Preserve every non-`hooks` table verbatim
  // by passing the parsed object straight to `stringify` after swapping
  // in the new hooks tree.
  const nextConfig: Record<string, unknown> = { ...existingConfig, hooks: merged };
  const out = stringifyToml(nextConfig);
  await atomicWrite(configPath, out);

  log(`  ✓ wrote ${countHandlers(merged)} handlers across ${Object.keys(merged).length} events.`);

  return {
    configPath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    changed: true,
    handlerCount: countHandlers(merged),
  };
}
