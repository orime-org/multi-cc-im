import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AskUserQuestionAIOutputSchema,
  PermissionDialogAIOutputSchema,
} from '@multi-cc-im/shared';
import {
  renderRoutingPrompt,
  renderAskUserQuestionPrompt,
  renderPermissionRequestPrompt,
  type AskUserQuestionViaAIOpts,
  type PermissionRequestViaAIOpts,
  type AIAskUserQuestionResult,
  type AIPermissionDialogResult,
  type AIRoutingOpts,
  type AIRoutingResult,
} from './ai-router.js';

/**
 * Codex execution backend for plain-message, question, and permission triage.
 * Reuses the established prompts and shared answer schemas. Each invocation
 * has its own temporary cwd and disables hooks without bypassing trust.
 * User model/provider/auth configuration is retained; user sessions and
 * terminal input/output are never attached to these one-shot subprocesses.
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
 * Draft-07 schema Codex accepts. The result is still checked before dispatch;
 * schema-constrained output does not replace runtime validation.
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

const QUESTION_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    target: { type: 'string', minLength: 1 }, reason: { type: ['string', 'null'] },
    answers: { type: 'array', minItems: 1, items: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['questionIndex', 'kind', 'optionIndex'], properties: {
        questionIndex: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['option'] },
        optionIndex: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } }] },
      } },
      { type: 'object', additionalProperties: false, required: ['questionIndex', 'kind', 'text'], properties: {
        questionIndex: { type: 'integer', minimum: 0 }, kind: { type: 'string', enum: ['text'] }, text: { type: 'string' },
      } },
    ] } },
  }, required: ['target', 'reason', 'answers'],
} as const;

const PERMISSION_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    target: { type: 'string', minLength: 1 }, reason: { type: ['string', 'null'] },
    answer: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['behavior'], properties: { behavior: { type: 'string', enum: ['allow'] } } },
      { type: 'object', additionalProperties: false, required: ['behavior', 'appliedSuggestionIndex'], properties: {
        behavior: { type: 'string', enum: ['allow'] }, appliedSuggestionIndex: { type: 'integer', minimum: 1 },
      } },
      { type: 'object', additionalProperties: false, required: ['behavior'], properties: { behavior: { type: 'string', enum: ['deny'] } } },
      { type: 'object', additionalProperties: false, required: ['behavior', 'message'], properties: {
        behavior: { type: 'string', enum: ['deny'] }, message: { type: 'string' },
      } },
    ] },
  }, required: ['target', 'reason', 'answer'],
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
  cwd: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.binary, [...opts.args], { env: opts.env, cwd: opts.cwd });

    // Codex exec doesn't read stdin (prompt passed via argv), but close
    // stdin defensively to match the same pattern cli-cc uses for
    // claude --print (some upstream binaries probe stdin EOF before
    // proceeding). EPIPE/ECONNRESET swallow per
    // feedback_node_spawn_stdin_epipe.md.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') {
        child.kill('SIGTERM');
        reject(error);
      }
    });
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

/** Codex binary/model/deadline overrides for an isolated triage invocation. */
interface CodexExecOpts {
  codexBinary?: string;
  model?: string;
  timeoutMs?: number;
}

/** Plain routing input; the selected backend never uses claudeBinary. */
export interface CodexRoutingOpts extends AIRoutingOpts, CodexExecOpts {}

/** Existing Claude question interpretation contract, executed by Codex. */
export interface CodexQuestionRoutingOpts extends Omit<AskUserQuestionViaAIOpts, 'claudeBinary'>, CodexExecOpts {}

/** Existing permission interpretation contract, executed by Codex. */
export interface CodexPermissionRoutingOpts extends Omit<PermissionRequestViaAIOpts, 'claudeBinary'>, CodexExecOpts {}

function failureReason(error: unknown, opts: CodexExecOpts): string {
  const e = error as Error & { code?: number | string | null; signal?: string | null; killed?: boolean; stderr?: string };
  if (error instanceof SyntaxError) return 'codex output not JSON';
  if (e.code === undefined && error instanceof Error) return error.message;
  if (e.code === 'ENOENT') return `codex binary not found: ${opts.codexBinary ?? DEFAULT_CODEX_BINARY}`;
  if (e.killed) return `codex timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`;
  return `codex exec failed: code=${String(e.code)} signal=${String(e.signal)} stderr=${(e.stderr ?? '').slice(0, 200)}`;
}

async function runCodexPrompt(opts: CodexExecOpts & { prompt: string; schema: unknown }): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'multi-cc-im-codex-'));
  try {
    const schemaPath = join(tempDir, 'schema.json');
    const outPath = join(tempDir, 'last-message.txt');
    await writeFile(schemaPath, JSON.stringify(opts.schema), { mode: 0o600 });
    const childEnv = { ...process.env };
    delete childEnv.WEZTERM_PANE;
    delete childEnv.ITERM_SESSION_ID;
    const args = [
      'exec', '--ephemeral', '--disable', 'hooks', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--output-schema', schemaPath, '--output-last-message', outPath,
    ];
    const model = opts.model ?? DEFAULT_CODEX_MODEL;
    if (model.length > 0) args.push('--model', model);
    args.push(opts.prompt);
    await runCodexExec({
      binary: opts.codexBinary ?? DEFAULT_CODEX_BINARY,
      args,
      env: childEnv,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: tempDir,
    });
    try {
      return await readFile(outPath, 'utf8');
    } catch (error) {
      throw new Error(`codex output file unreadable: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      process.stderr.write(`[Codex AI router] workspace cleanup failed: ${error.code ?? error.name}\n`);
    });
  }
}

/**
 * Route a plain IM message with Codex using the established routing prompt.
 * @param opts Message, visible tabs, pending tools, and optional CLI overrides.
 * @returns A routing decision, or a classified failure without trying Claude.
 */
export async function routeViaCodex(opts: CodexRoutingOpts): Promise<AIRoutingResult> {
  try {
    const content = await runCodexPrompt({
      ...opts, prompt: renderRoutingPrompt(opts), schema: ROUTING_OUTPUT_SCHEMA,
    });
    return parseCodexLastMessage(content);
  } catch (error) {
    return failure(failureReason(error, opts));
  }
}

/**
 * Interpret replies to existing Claude AskUserQuestion prompts using Codex.
 * This does not implement Codex's own request_user_input transport.
 * @param opts IM reply, pending questions, and optional CLI overrides.
 * @returns Validated option/free-text answers, or null on failure.
 */
export async function routeAskUserQuestionViaCodex(
  opts: CodexQuestionRoutingOpts,
): Promise<AIAskUserQuestionResult | null> {
  try {
    const content = await runCodexPrompt({
      ...opts, prompt: renderAskUserQuestionPrompt(opts), schema: QUESTION_OUTPUT_SCHEMA,
    });
    const parsed = AskUserQuestionAIOutputSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return null;
    return { ...parsed.data, reason: parsed.data.reason ?? null };
  } catch (error) {
    process.stderr.write(`[Codex AI router] question extraction failed: ${failureReason(error, opts)}\n`);
    return null;
  }
}

/**
 * Interpret native permission replies with the selected Codex backend.
 * @param opts IM reply, pending dialogs, and optional CLI overrides.
 * @returns A validated existing permission answer, or null on failure.
 */
export async function routePermissionRequestViaCodex(
  opts: CodexPermissionRoutingOpts,
): Promise<AIPermissionDialogResult | null> {
  try {
    const content = await runCodexPrompt({
      ...opts, prompt: renderPermissionRequestPrompt(opts), schema: PERMISSION_OUTPUT_SCHEMA,
    });
    const parsed = PermissionDialogAIOutputSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return null;
    return { ...parsed.data, reason: parsed.data.reason ?? null };
  } catch (error) {
    process.stderr.write(`[Codex AI router] permission extraction failed: ${failureReason(error, opts)}\n`);
    return null;
  }
}
