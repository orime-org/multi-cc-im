import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderRoutingPrompt,
  type AIRoutingOpts,
  type AIRoutingResult,
} from './ai-router.js';

/**
 * Routes IM messages via Codex CLI (`codex exec`) instead of Claude
 * Code (`claude --print`). Activated by `multi-cc-im start --cli=codex`.
 * Per [DD §7.1: AI router CLI-selectable](../../docs/superpowers/specs/2026-05-22-codex-cli-adapter-dd.md#71-ai-router-cli-selectable-2026-05-22-用户新增约束).
 *
 * Why a separate router instead of one factory dispatching on cliKind:
 * codex exec exposes structurally different headless flags than cc
 * `--print` (`--output-schema <file>` + `--output-last-message <file>`
 * + `--ephemeral` + `--dangerously-bypass-hook-trust` + `--sandbox` —
 * none of which exist on cc), and the response shape on disk
 * (last-message file containing JSON the LLM wrote) is different from
 * cc's stdout JSON envelope (`{result: "<inner string>", ...}`). One
 * function per CLI keeps each invocation legible.
 *
 * Codex headless advantages over cc per DD §7.1:
 * - `--output-schema <file>`: codex constrains the model's output to a
 *   JSON Schema strictly — no prompt-engineered "please return JSON"
 *   needed, no markdown fence stripping. 100% schema-compliant output.
 * - `--output-last-message <file>`: avoid parsing JSONL event streams;
 *   codex writes the final assistant message verbatim to disk.
 * - `--ephemeral` + `--dangerously-bypass-hook-trust`: triage subprocess
 *   doesn't persist any session state nor fire user hooks. The cli-cc
 *   path uses `WEZTERM_PANE` env strip as the equivalent guard — codex
 *   exposes explicit flags so the guard is named in code, not implied
 *   by absence of a side channel.
 *
 * Sandbox: `read-only` (matches the AI router's actual needs — it only
 * reads the user's IM message + tab list; no filesystem writes).
 *
 * Default codex binary: `'codex'` (resolved via PATH). Tests stub to a
 * fixture script.
 */

const DEFAULT_CODEX_BINARY = 'codex';
/**
 * Default codex model for triage. Codex picks per-user-config when the
 * flag is omitted; we let the user's config win unless they pass an
 * explicit override. `''` means "do not pass --model".
 */
const DEFAULT_CODEX_MODEL = '';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * JSON Schema that codex's `--output-schema` constrains the model
 * output against. Mirrors `AIRoutingResult` but expressed as an
 * open Draft-07 schema codex accepts. The router consumer then
 * runs zod on top defensively, but the schema should make zod
 * always pass when codex finishes successfully.
 */
const ROUTING_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    target: { type: ['string', 'null'] },
    intent: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    permissionResponse: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            target: { type: 'string' },
            decision: { enum: ['allow', 'deny'] },
            reason: { type: 'string' },
          },
          required: ['target', 'decision', 'reason'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['target', 'intent', 'reason', 'permissionResponse'],
  additionalProperties: false,
} as const;

function failure(reason: string): AIRoutingResult {
  return { target: null, intent: null, reason, permissionResponse: null };
}

/**
 * Spawn `codex exec` with the given prompt + output paths; resolve
 * when the process exits. Rejects on non-zero exit, error, or
 * timeout. The on-disk side effects (schema file + output file) are
 * provisioned + cleaned by the caller.
 */
function runCodexExec(opts: {
  binary: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, [...opts.args], { env: opts.env });

    // Codex exec doesn't read stdin (prompt passed via argv), but close
    // stdin defensively to match the same pattern cli-cc uses for
    // claude --print (some upstream binaries probe stdin EOF before
    // proceeding). EPIPE/ECONNRESET swallow per
    // feedback_node_spawn_stdin_epipe.md.
    child.stdin.on('error', () => {});
    child.stdin.end();

    let stderrBuf = '';
    let timedOut = false;

    child.stdout.on('data', () => {
      /* discard — we read the last-message file instead */
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const wrapped = Object.assign(err, { stderr: stderrBuf });
      reject(wrapped);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolve();
        return;
      }
      const err = new Error(
        `codex exec failed: ${opts.binary} ${opts.args.join(' ')}`,
      ) as Error & {
        code?: number | null;
        signal?: NodeJS.Signals | null;
        killed?: boolean;
        stderr?: string;
      };
      err.code = code;
      err.signal = signal;
      err.killed = timedOut;
      err.stderr = stderrBuf;
      reject(err);
    });
  });
}

function parseCodexLastMessage(content: string): AIRoutingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return failure('codex output not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return failure('codex output not object');
  }
  const obj = parsed as Record<string, unknown>;
  const target = typeof obj.target === 'string' ? obj.target : null;
  const intent = typeof obj.intent === 'string' ? obj.intent : null;
  const reason = typeof obj.reason === 'string' ? obj.reason : null;
  let permissionResponse: AIRoutingResult['permissionResponse'] = null;
  if (
    obj.permissionResponse !== undefined &&
    obj.permissionResponse !== null &&
    typeof obj.permissionResponse === 'object'
  ) {
    const pr = obj.permissionResponse as Record<string, unknown>;
    if (
      typeof pr.target === 'string' &&
      (pr.decision === 'allow' || pr.decision === 'deny') &&
      typeof pr.reason === 'string'
    ) {
      permissionResponse = {
        target: pr.target,
        decision: pr.decision,
        reason: pr.reason,
      };
    }
  }
  return { target, intent, reason, permissionResponse };
}

export interface CodexRoutingOpts extends AIRoutingOpts {
  /** Override codex binary path. Default: `'codex'` (PATH). Tests inject a stub. */
  codexBinary?: string;
}

/**
 * Codex-flavored counterpart of `routeViaAI`. Spawns `codex exec` with
 * the routing prompt, writes the model's final reply (already
 * schema-constrained by `--output-schema`) to a tempfile, parses it,
 * and returns an `AIRoutingResult`. Errors NEVER propagate — every
 * failure mode (binary missing / timeout / non-zero exit / malformed
 * JSON) returns a `failure(reason)` so the orchestrator falls back to
 * the same "AI couldn't decide" UX path it uses for cc.
 *
 * Why we don't pass `tabs` / `currentTab` / `pendingRequests` to a
 * codex-specific prompt: the prompt is rendered via the shared
 * `renderRoutingPrompt` from `ai-router.ts`, so codex sees an
 * identical user-message template to cc. The output schema constrains
 * the result — no codex-specific prompt tuning needed.
 */
export async function routeViaCodex(
  opts: CodexRoutingOpts,
): Promise<AIRoutingResult> {
  const binary = opts.codexBinary ?? DEFAULT_CODEX_BINARY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? DEFAULT_CODEX_MODEL;

  const prompt = renderRoutingPrompt({
    userMsg: opts.userMsg,
    tabs: opts.tabs,
    currentTab: opts.currentTab,
    pendingRequests: opts.pendingRequests,
    forcePermissionMode: opts.forcePermissionMode,
  });

  // Write schema + provision output file paths in a per-call tempdir
  // so concurrent triage calls don't race on shared file names.
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'multi-cc-im-codex-'));
    const schemaPath = join(tempDir, 'schema.json');
    const outPath = join(tempDir, 'last-message.txt');
    await writeFile(schemaPath, JSON.stringify(ROUTING_OUTPUT_SCHEMA, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });

    // Strip WEZTERM_PANE / ITERM_SESSION_ID so codex's hooks (if the
    // user installed cli-codex's setup-hooks) don't write Stop /
    // PermissionRequest files for this triage subprocess. Same pattern
    // ai-router.ts uses for cc.
    const childEnv = { ...process.env };
    delete childEnv.WEZTERM_PANE;
    delete childEnv.ITERM_SESSION_ID;

    const args: string[] = [
      'exec',
      '--ephemeral',
      '--dangerously-bypass-hook-trust',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outPath,
    ];
    if (model.length > 0) {
      args.push('--model', model);
    }
    args.push(prompt);

    try {
      await runCodexExec({ binary, args, env: childEnv, timeoutMs });
    } catch (err) {
      const e = err as Error & {
        code?: number | string | null;
        signal?: NodeJS.Signals | null;
        stderr?: string;
      };
      const detail =
        e.code === 'ENOENT'
          ? `codex binary not found: ${binary}`
          : `codex exec failed: code=${String(e.code)} signal=${String(e.signal)} stderr=${(e.stderr ?? '').slice(0, 200)}`;
      return failure(detail);
    }

    let content: string;
    try {
      content = await readFile(outPath, 'utf8');
    } catch (err) {
      return failure(
        `codex output file unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return parseCodexLastMessage(content);
  } finally {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup; OS will reap tmpdir eventually */
      });
    }
  }
}
