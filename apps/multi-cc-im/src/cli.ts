// Entry point invoked by the `bin/multi-cc-im` bash wrapper via tsx. Node
// 22-24 default can't resolve `import './hook.js'` → `./hook.ts` for the
// source-as-bin pattern (verified ERR_MODULE_NOT_FOUND on v24.10); tsx
// handles the extension rewrite. v2 will tsup-bundle to .js, at which point
// this file could regain a `#!/usr/bin/env node` shebang directly.

import { runCleanupCommand } from './cleanup.js';
import { runHookCommand } from './hook.js';
import { runStartCommand } from './start.js';

const HELP_TEXT = `multi-cc-im — IM ↔ Claude Code TUI bridge

Usage:
  multi-cc-im start                — start the bridge daemon (long-running);
                                     auto-registers cc hooks in
                                     ~/.claude/settings.json on first run
                                     (idempotent merge, preserves other
                                     tools' hooks).
                                     M1 transitional: no IM adapter wired
                                     yet (lark M2-M8 in progress per
                                     DD #86 §11.4).
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

Exit codes:
  0  — success
  1  — pre-flight / runtime failure (stderr details)
  2  — usage error (unknown subcommand / missing arg)
`.trimStart();

const VERSION = '0.0.0';

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
    case 'cleanup':
      return await dispatchCleanup(rest);
    case 'start':
      return await dispatchStart();
    default:
      process.stderr.write(
        `multi-cc-im: unknown subcommand '${subcommand}'\nRun \`multi-cc-im --help\` for usage.\n`,
      );
      return 2;
  }
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
  // in the JSON stdin payload (per cc hook protocol). We accept + ignore arg
  // so cc settings.json can use `multi-cc-im hook SessionStart` etc. for clarity.
  void args; // no-op; reserved for future per-event sanity check vs payload

  const stdin = await readAllStdin();
  const stateDir = resolveStateDir();
  const result = await runHookCommand({ stdin, stateDir });

  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  return result.exitCode;
}

async function dispatchStart(): Promise<number> {
  const result = await runStartCommand();
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
