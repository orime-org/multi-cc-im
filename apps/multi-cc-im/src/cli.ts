// Entry point invoked by the `bin/multi-cc-im` bash wrapper via tsx. Node
// 22-24 default can't resolve `import './hook.js'` → `./hook.ts` for the
// source-as-bin pattern (verified ERR_MODULE_NOT_FOUND on v24.10); tsx
// handles the extension rewrite. v2 will tsup-bundle to .js, at which point
// this file could regain a `#!/usr/bin/env node` shebang directly.

import { adapters, findAdapter } from './adapters.js';
import { runCleanupCommand } from './cleanup.js';
import { runHookCommand } from './hook.js';
import {
  fieldKeyToEnvVar,
  fieldKeyToFlag,
  runLoginCommand,
} from './login.js';
import { runStartCommand } from './start.js';

const HELP_TEXT = `multi-cc-im — IM ↔ Claude Code TUI bridge

Usage:
  multi-cc-im start                — start the bridge daemon (long-running);
                                     auto-registers cc hooks in
                                     ~/.claude/settings.json on first run
                                     (idempotent merge, preserves other
                                     tools' hooks).
                                     Transitional: lark M3-M8 wiring
                                     pending per DD #86 §11.4.
  multi-cc-im login lark           — validate Feishu app_id + app_secret +
                                     persist to ~/.multi-cc-im/credentials/
                                     lark.json (mode 0600). Source the
                                     two values from --app-id / --app-secret
                                     args or LARK_APP_ID / LARK_APP_SECRET
                                     env vars.
  multi-cc-im cleanup [--dry-run]  — manually sweep ~/.multi-cc-im/state/
                                     (paired SessionStart+SessionEnd, orphan Stop
                                     files, legacy state files). Same as the
                                     daemon's startup sweep; safe to run while
                                     daemon is running (won't touch live cc).
  multi-cc-im hook <event>         — cc hook entrypoint (called by cc settings.json)
  multi-cc-im --help | -h          — print this help
  multi-cc-im --version | -v       — print version

Environment:
  MULTI_CC_IM_HOME                 — override default ~/.multi-cc-im root
  LARK_APP_ID                      — Feishu self-built app_id (login lark fallback)
  LARK_APP_SECRET                  — Feishu self-built app_secret (login lark fallback)

Exit codes:
  0  — success
  1  — pre-flight / runtime failure (stderr details)
  2  — usage error (unknown subcommand / missing arg)
`.trimStart();

// Initial release version. Keep in sync with `package.json` "version"
// in this app + all workspace packages — both are bumped together.
// TODO: import from package.json directly (needs tsup JSON loader config)
// so we never forget to bump this on release.
const VERSION = '0.1.2';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [subcommand, ...rest] = args;

  if (
    subcommand === undefined ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    process.stdout.write(HELP_TEXT);
    return subcommand === undefined ? 2 : 0;
  }
  if (subcommand === '--version' || subcommand === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (subcommand) {
    case 'hook':
      return await dispatchHook(rest);
    case 'login':
      return await dispatchLogin(rest);
    case 'cleanup':
      return await dispatchCleanup(rest);
    case 'start':
      return await dispatchStart(rest);
    default:
      process.stderr.write(
        `multi-cc-im: unknown subcommand '${subcommand}'\nRun \`multi-cc-im --help\` for usage.\n`,
      );
      return 2;
  }
}

async function dispatchLogin(args: string[]): Promise<number> {
  const [im, ...rest] = args;
  const knownIds = adapters.map((a) => a.id).join(', ');

  if (im === undefined) {
    process.stderr.write(
      `multi-cc-im login: adapter required\n` +
        `Usage: multi-cc-im login <adapter> [--<field> <value>]\n` +
        `  Available adapters: ${knownIds}\n`,
    );
    return 2;
  }

  const entry = findAdapter(im);
  if (!entry) {
    process.stderr.write(
      `multi-cc-im login: unknown adapter '${im}'\n` +
        `  Available: ${knownIds}\n`,
    );
    return 2;
  }

  // Build flag + env-var lookup tables from the adapter's schema fields.
  // Convention (W7): camelCase key → --kebab-case flag + ADAPTERID_SCREAMING
  // env var. Adding a new adapter inherits CLI flag/env support automatically.
  const flagToKey = new Map<string, string>();
  const envToKey = new Map<string, string>();
  for (const field of entry.setupSchema.fields) {
    flagToKey.set(`--${fieldKeyToFlag(field.key)}`, field.key);
    envToKey.set(fieldKeyToEnvVar(entry.id, field.key), field.key);
  }

  // Seed values from env, override with CLI flags.
  const values: Record<string, unknown> = {};
  for (const [envName, key] of envToKey) {
    const v = process.env[envName];
    if (v !== undefined) values[key] = v;
  }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const key = flagToKey.get(arg);
    if (key !== undefined && i + 1 < rest.length) {
      values[key] = rest[i + 1]!;
      i++;
    } else {
      const flagsUsage = [...flagToKey.keys()]
        .map((f) => `[${f} <value>]`)
        .join(' ');
      const envsUsage = [...envToKey.keys()].join(' / ');
      process.stderr.write(
        `multi-cc-im login ${im}: unknown arg '${arg}'\n` +
          `Usage: multi-cc-im login ${im} ${flagsUsage}\n` +
          `       (or set env vars: ${envsUsage})\n`,
      );
      return 2;
    }
  }

  const result = await runLoginCommand({ adapter: im, values });
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  if (result.exitCode === 0) {
    process.stdout.write(
      `✓ ${im} login successful — credentials saved to ~/.multi-cc-im/credentials/${im}.json\n`,
    );
  }
  return result.exitCode;
}

async function dispatchCleanup(args: string[]): Promise<number> {
  // Accept --dry-run / -n; reject other flags.
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
    } else {
      process.stderr.write(
        `multi-cc-im cleanup: unknown arg '${arg}'\nUsage: multi-cc-im cleanup [--dry-run]\n`,
      );
      return 2;
    }
  }
  const result = await runCleanupCommand({ dryRun });
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

async function dispatchHook(args: string[]): Promise<number> {
  // hook <event> — `<event>` arg is informational; the actual event name lives
  // in the JSON stdin payload (per cc hook protocol). We forward it verbatim
  // to `runHookCommand` so the entry-trace records what cc invoked us with,
  // independent of stdin contents (helps disambiguate "cc didn't pipe a
  // payload" vs "cc piped wrong payload" — issue 377 diagnostic).

  const stdin = await readAllStdin();
  const stateDir = resolveStateDir();
  const result = await runHookCommand({
    stdin,
    stateDir,
    event: args[0],
  });

  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

async function dispatchStart(args: string[]): Promise<number> {
  // Parse `multi-cc-im start [<adapter>]` — single optional positional arg.
  // Per [DD §4](docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#4-d1--locked-decision-single-start-command).
  if (args.length > 1) {
    process.stderr.write(
      `multi-cc-im start: too many arguments (got ${args.length}, expected 0 or 1)\n` +
        `Usage: multi-cc-im start [<adapter>]\n`,
    );
    return 2;
  }
  const adapterArg = args[0];
  const result = await runStartCommand({ adapterArg });
  if (result.stderr.length > 0) {
    process.stderr.write(`${result.stderr}\n`);
    return result.exitCode;
  }

  if (!result.shutdown) return result.exitCode;

  // Bridge is running; install signal handlers for graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\nmulti-cc-im: ${signal} received, stopping...\n`);
    try {
      await result.shutdown!();
    } catch (err) {
      process.stderr.write(
        `multi-cc-im: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the event loop alive until a signal triggers shutdown.
  return await new Promise<number>(() => {});
}

function resolveStateDir(): string {
  const root =
    process.env.MULTI_CC_IM_HOME ??
    `${process.env.HOME ?? ''}/.multi-cc-im`;
  return `${root}/state`;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `multi-cc-im: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  },
);
