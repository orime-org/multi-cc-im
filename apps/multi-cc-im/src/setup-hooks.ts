import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { atomicWrite } from '@multi-cc-im/storage-files';

/**
 * The 2 cc hook events multi-cc-im needs to subscribe to.
 *
 * Per [DD: pane-keyed state files](../../../../docs/superpowers/specs/2026-05-08-pane-keyed-state-files-dd.md)
 * (DD #61), SessionStart + SessionEnd were dropped:
 *   - daemon no longer needs `WEZTERM_PANE` snapshot from SessionStart
 *     (hook subprocess reads env directly + writes to `<paneId>_<sid>.<event>`)
 *   - daemon no longer needs SessionEnd as a death signal (wezterm cli list
 *     is the live source of truth for "which panes have cc")
 *
 * - `PreToolUse` — IM permission gate per [DD: permission forward](../../../../docs/superpowers/specs/2026-05-07-permission-forward-dd.md).
 *   Hook subprocess writes `<paneId>_<sid>.PermissionRequest.<id>.json`,
 *   daemon forwards to IM, IM user replies `@<tabname> /1` / `/2`, daemon
 *   writes `<paneId>_<sid>.PermissionResponse.<id>.json`, hook subprocess
 *   emits permission decision to cc. **10 second** timeout default-allows.
 * - `Stop` — assistant turn complete; bridge forwards
 *   `last_assistant_message` to IM origin via `<paneId>.IMOrigin` lookup.
 *
 * Schema follows cc upstream: `hooks` is an object keyed by event name,
 * each event maps to an array of matcher groups, each group has its own
 * inner `hooks` array of handler entries. See
 * https://code.claude.com/docs/en/hooks for authoritative shape.
 *
 * Per-event matcher + timeout:
 * - `Stop` — `matcher: ""` (no tool concept)
 * - `PreToolUse` — `matcher: "*"` (match all tools) + `timeout: 10`
 */
const HOOK_EVENTS = ['PreToolUse', 'Stop'] as const;

/**
 * Per-event matcher groups to emit into `~/.claude/settings.json`. Each spec
 * becomes one `{matcher, hooks: [{command, timeout?}]}` group under the
 * event key; all groups share the same `multi-cc-im hook <event>` command.
 *
 * Why per-event arrays (not a single matcher per event):
 * `PreToolUse` needs DISJOINT matcher groups so different tools get
 * different timeouts. cc fires "all matching hooks in parallel and
 * deduplicates identical handlers" — but identity is by full handler
 * object (including `timeout`), so overlapping matchers with different
 * timeouts double-fire the same script. Disjoint matchers avoid that.
 *
 * Per [DD: AskUserQuestion IM bridge](../../../docs/superpowers/specs/2026-05-12-askuserquestion-im-bridge-dd.md) §6 P1 + §9.5:
 * - `AskUserQuestion` → timeout 120 (2 min) — hook holds polling for an
 *   IM-side natural-language reply (D2-B "hook holds until IM reply").
 *   §9.5 shortened from the original 300s: 2 min covers a user who's
 *   briefly attending the phone; after that the hook self-constructs
 *   an allow + updatedInput with empty answers so cc records the tool
 *   as completed with empty user answers (no deny channel).
 * - Everything else → timeout 20 — original IM permission gate RTT
 *   budget: 10s internal poll (`PERMISSION_TIMEOUT_MS` in
 *   `cli-cc/hook-receiver.ts`) + 10s margin for stdout write + daemon
 *   transient retry. Negative lookahead `^(?!AskUserQuestion$).+$` keeps
 *   this entry future-proof — any tool except `AskUserQuestion` auto-
 *   covered (incl. new cc tools we haven't enumerated).
 * - `Stop` → no tool concept, single matcher `""`, no custom timeout.
 */
interface MatcherSpec {
  matcher: string;
  timeout?: number;
}

const EVENT_MATCHER_SPECS: Record<
  (typeof HOOK_EVENTS)[number],
  readonly MatcherSpec[]
> = {
  PreToolUse: [
    { matcher: 'AskUserQuestion', timeout: 120 },
    { matcher: '^(?!AskUserQuestion$).+$', timeout: 20 },
  ],
  Stop: [{ matcher: '' }],
};

interface HookHandler {
  type: 'command';
  command: string;
  /** Per-cc-hook-protocol custom timeout (seconds). Optional. */
  timeout?: number;
}

interface MatcherGroup {
  matcher: string;
  hooks: HookHandler[];
}

type HooksMap = Record<string, MatcherGroup[]>;

const MULTI_CC_IM_HOOK_NEEDLE = 'bin/multi-cc-im hook ';

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
  /**
   * Total handler entries across all events after merge (sum of every
   * `matcher group → inner hooks[]` length).
   */
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
 * hook commands into `~/.claude/settings.json` using cc's nested-object
 * schema (`hooks: { EventName: [{matcher, hooks: [...]}] }`).
 *
 * - **Missing file or empty `{}`**: write a fresh `{ "hooks": { ... } }`
 *   with our 6 events.
 * - **Existing settings with non-multi-cc-im hooks**: preserve them verbatim,
 *   append our matcher groups under each of the 6 events.
 * - **Existing settings with stale multi-cc-im hooks** (e.g. user moved the
 *   repo, ABS_PATH changed): drop those by detecting `bin/multi-cc-im hook`
 *   substring in `command`, then add fresh 6 with current absolute path.
 *   Empty matcher groups / event keys are pruned after the drop.
 * - **Existing settings with legacy flat-array `hooks`** (PR #31 / #32 era —
 *   cc rejected these with a Settings Warning): discarded entirely. Those
 *   entries were never honored, so nothing of value is lost. A log line
 *   tells the user the cleanup happened.
 * - **Other top-level fields** (e.g. `mcpServers`, `model`): preserved
 *   verbatim.
 * - **Already up-to-date** (current ABS_PATH 6 entries already present, no
 *   stale / legacy artifacts to clean): no-op — file is not touched, no
 *   backup is created. Avoids accumulating `.bak.*` files on repeated runs.
 *
 * Atomic write via `atomicWrite` (same-dir tmp + fsync + rename, mode 0600 —
 * matches cc's own settings.json default permission). Backup of the prior
 * settings.json is taken first to a timestamped `.bak.<iso>` sibling — only
 * when an actual write is going to happen.
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

  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(ccSettingsPath, 'utf-8');
    if (raw.trim() === '') {
      // Empty / whitespace-only file is functionally equivalent to `{}` —
      // treat it as such instead of choking on `JSON.parse('')`. Common when
      // a previous tool truncated the file to 0 bytes.
      log(`  (cc settings.json is empty, treating as {})`);
      existing = {};
    } else {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch (parseErr) {
        return {
          exitCode: 1,
          stderr: `multi-cc-im setup-hooks: failed to parse JSON in ${ccSettingsPath}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        };
      }
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

  const { hooksMap, removedCount, legacyArrayDropped } = pruneExistingHooks(
    existing.hooks,
  );
  for (const event of HOOK_EVENTS) {
    const groups = hooksMap[event] ?? [];
    const newGroups: MatcherGroup[] = [];
    for (const spec of EVENT_MATCHER_SPECS[event]) {
      const handler: HookHandler = {
        type: 'command',
        command: `${wrapperPath} hook ${event}`,
        ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
      };
      newGroups.push({ matcher: spec.matcher, hooks: [handler] });
    }
    hooksMap[event] = [...groups, ...newGroups];
  }

  const newSettings: Record<string, unknown> = {
    ...existing,
    hooks: hooksMap,
  };

  // Short-circuit: if the merge would produce byte-for-byte the same content
  // (user already has the right hooks under the current ABS_PATH and no
  // legacy/stale entries to clean up), skip backup + write entirely. Without
  // this, every re-run accumulates a `.bak.<ts>` file even when nothing
  // actually changes — confusing the user and littering ~/.claude/.
  // `isDeepStrictEqual` ignores key order which is what we want here.
  if (isDeepStrictEqual(newSettings, existing)) {
    log(`  ✓ already up-to-date, no changes needed`);
      return {
      exitCode: 0,
      stderr: '',
      writtenTo: ccSettingsPath,
      hookCount: countHandlers(hooksMap),
    };
  }

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

  if (legacyArrayDropped > 0) {
    log(
      `  ✓ replaced ${legacyArrayDropped} legacy flat-array hook entr${legacyArrayDropped === 1 ? 'y' : 'ies'} (cc was ignoring them — wrong schema from older multi-cc-im versions)`,
    );
  }
  if (removedCount > 0) {
    log(
      `  ✓ removed ${removedCount} stale multi-cc-im hook handler(s) (likely from previous repo path)`,
    );
  }
  // Sum every matcher spec multi-cc-im owns across all managed events.
  // Note: != HOOK_EVENTS.length now that PreToolUse split into 2 disjoint
  // matcher groups (AskUserQuestion + everything-else) per DD AskUserQuestion §6 P1.
  const ownHandlerCount = Object.values(EVENT_MATCHER_SPECS).reduce(
    (sum, specs) => sum + specs.length,
    0,
  );
  log(
    `  ✓ added ${ownHandlerCount} multi-cc-im hooks (events: ${HOOK_EVENTS.join(', ')})`,
  );
  const totalHandlers = countHandlers(hooksMap);
  const otherHandlers = totalHandlers - ownHandlerCount;
  if (otherHandlers > 0) {
    log(
      `  ✓ total handlers now: ${totalHandlers} (${otherHandlers} from other tools preserved)`,
    );
  } else {
    log(`  ✓ total handlers now: ${totalHandlers}`);
  }

  return {
    exitCode: 0,
    stderr: '',
    writtenTo: ccSettingsPath,
    hookCount: totalHandlers,
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

/**
 * Walk the user's existing `hooks` value, drop any handler whose `command`
 * mentions `bin/multi-cc-im hook ` (so re-running the command swaps stale
 * ABS_PATH entries cleanly), and prune empty matcher groups / events left
 * behind. Returns a map ready to receive our fresh entries.
 *
 * Handles three input shapes:
 * 1. Object — cc upstream schema; walked normally.
 * 2. Array — legacy buggy multi-cc-im flat-array (cc rejected with Settings
 *    Warning, so it was effectively dead). Discarded entirely; counted via
 *    `legacyArrayDropped` for the log line.
 * 3. Anything else (undefined/null/string/etc.) — treated as no existing
 *    hooks; an empty map is returned.
 */
function pruneExistingHooks(rawHooks: unknown): {
  hooksMap: HooksMap;
  removedCount: number;
  legacyArrayDropped: number;
} {
  if (Array.isArray(rawHooks)) {
    return { hooksMap: {}, removedCount: 0, legacyArrayDropped: rawHooks.length };
  }
  if (typeof rawHooks !== 'object' || rawHooks === null) {
    return { hooksMap: {}, removedCount: 0, legacyArrayDropped: 0 };
  }

  const out: HooksMap = {};
  let removedCount = 0;

  for (const [event, value] of Object.entries(rawHooks as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const filteredGroups: MatcherGroup[] = [];
    for (const group of value) {
      if (typeof group !== 'object' || group === null) continue;
      const matcher = (group as { matcher?: unknown }).matcher;
      const innerHooks = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(innerHooks)) continue;
      const filteredHandlers: HookHandler[] = [];
      for (const handler of innerHooks) {
        if (typeof handler !== 'object' || handler === null) continue;
        const cmd = (handler as { command?: unknown }).command;
        const type = (handler as { type?: unknown }).type;
        if (
          type === 'command' &&
          typeof cmd === 'string' &&
          cmd.includes(MULTI_CC_IM_HOOK_NEEDLE)
        ) {
          removedCount++;
          continue;
        }
        // Preserve unknown handler shapes verbatim (http/mcp_tool/agent/prompt).
        filteredHandlers.push(handler as HookHandler);
      }
      if (filteredHandlers.length === 0) continue;
      filteredGroups.push({
        matcher: typeof matcher === 'string' ? matcher : '',
        hooks: filteredHandlers,
      });
    }
    if (filteredGroups.length > 0) {
      out[event] = filteredGroups;
    }
  }

  return { hooksMap: out, removedCount, legacyArrayDropped: 0 };
}

function countHandlers(hooksMap: HooksMap): number {
  let n = 0;
  for (const groups of Object.values(hooksMap)) {
    for (const g of groups) n += g.hooks.length;
  }
  return n;
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
