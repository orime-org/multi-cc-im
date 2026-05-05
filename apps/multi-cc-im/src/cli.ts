#!/usr/bin/env node
import qrcodeTerminal from 'qrcode-terminal';
import { runHookCommand } from './hook.js';
import { runLoginWechatCommand } from './login.js';
import { runStartCommand } from './start.js';

const HELP_TEXT = `multi-cc-im — wechat ↔ Claude Code TUI bridge

Usage:
  multi-cc-im start                — start the bridge daemon (long-running)
  multi-cc-im login wechat         — scan QR + save bot_token to credentials
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
    case 'login':
      return await dispatchLogin(rest);
    case 'start':
      return await dispatchStart();
    default:
      process.stderr.write(
        `multi-cc-im: unknown subcommand '${subcommand}'\nRun \`multi-cc-im --help\` for usage.\n`,
      );
      return 2;
  }
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

async function dispatchLogin(args: string[]): Promise<number> {
  const [im] = args;
  if (im !== 'wechat') {
    process.stderr.write(
      `multi-cc-im login: unsupported IM '${im ?? '(none)'}' — only 'wechat' is supported\n`,
    );
    return 2;
  }

  const result = await runLoginWechatCommand({
    output: {
      renderQR: (url) => {
        qrcodeTerminal.generate(url, { small: true });
        process.stdout.write(
          `\n如果上面二维码未能成功展示，请用浏览器打开以下链接扫码：\n${url}\n\n`,
        );
      },
      println: (msg) => process.stdout.write(`${msg}\n`),
    },
  });
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
