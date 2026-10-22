import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  routeViaCodex,
  routeAskUserQuestionViaCodex,
  routePermissionRequestViaCodex,
} from './ai-router-codex.js';

let root: string;
let binary: string;
let metadata: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcim-codex-router-test-'));
  binary = join(root, 'codex-fixture');
  metadata = join(root, 'invocation.json');
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({
  args, cwd: process.cwd(), schema: JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')),
  pane: process.env.WEZTERM_PANE, iterm: process.env.ITERM_SESSION_ID,
}));
process.stdin.resume();
process.stdin.on('end', () => {
  if (process.env.MCIM_CODEX_TEST_MODE === 'fail') { process.stderr.write('fixture failure'); process.exit(2); }
  if (process.env.MCIM_CODEX_TEST_MODE === 'hang') { setInterval(() => {}, 100); return; }
  if (process.env.MCIM_CODEX_TEST_MODE !== 'missing') writeFileSync(output, process.env.MCIM_CODEX_TEST_OUTPUT ?? '{}');
});
`);
  await chmod(binary, 0o755);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function invocation() {
  return JSON.parse(await readFile(metadata, 'utf8')) as {
    args: string[]; cwd: string; pane?: string; iterm?: string;
    schema: { required: string[]; additionalProperties: boolean };
  };
}

const routing = { target: 'work', intent: 'Run checks', reason: 'Matched work', permissionResponse: null };
const question = { target: 'work', reason: null, answers: [{ questionIndex: 0, kind: 'option', optionIndex: [1, 2] }, { questionIndex: 1, kind: 'text', text: 'My answer' }] };
const permission = { target: 'work', reason: 'User chose deny', answer: { behavior: 'deny', message: 'Do not run' } };
const questions = [{ tabName: 'work', questions: [{ question: 'Which?', header: 'Choice', multiSelect: true, options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] }];
const dialogs = [{ tabName: 'work', toolName: 'Bash', toolInputSummary: 'echo fixture', permissionSuggestions: [] }];

const modes = [
  { name: 'plain routing', result: routing, run: () => routeViaCodex({ userMsg: 'Run checks', tabs: ['work'], currentTab: null, codexBinary: binary }) },
  { name: 'question extraction', result: question, run: () => routeAskUserQuestionViaCodex({ userMsg: 'Both and my answer', pendings: questions, codexBinary: binary }) },
  { name: 'permission extraction', result: permission, run: () => routePermissionRequestViaCodex({ userMsg: 'Do not run', pendings: dialogs, codexBinary: binary }) },
];

describe.each(modes)('$name', ({ result, run }) => {
  it('uses Codex with hooks disabled and isolated cwd, then removes temporary files', async () => {
    vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', JSON.stringify(result));
    vi.stubEnv('WEZTERM_PANE', '42');
    vi.stubEnv('ITERM_SESSION_ID', 'user-terminal');
    expect(await run()).toEqual(result);
    const call = await invocation();
    expect(call.args.slice(0, 1)).toEqual(['exec']);
    expect(call.args).toContain('--ephemeral');
    expect(call.args).not.toContain('--model');
    expect(call.args).toContain('--disable');
    expect(call.args[call.args.indexOf('--disable') + 1]).toBe('hooks');
    expect(call.args).not.toContain('--dangerously-bypass-hook-trust');
    expect(call.args[call.args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(call.pane).toBeUndefined();
    expect(call.iterm).toBeUndefined();
    expect(call.cwd).toBe(join(await realpath(tmpdir()), basename(dirname(call.args[call.args.indexOf('--output-schema') + 1]!))));
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.schema.additionalProperties).toBe(false);
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['fail', 'missing'])('handles %s without invoking another backend', async (mode) => {
    vi.stubEnv('MCIM_CODEX_TEST_MODE', mode);
    const output = await run();
    expect(output === null || ('target' in output && output.target === null)).toBe(true);
    const call = await invocation();
    await expect(stat(call.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed JSON', async () => {
    vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', 'not JSON');
    const output = await run();
    expect(output === null || ('target' in output && output.target === null)).toBe(true);
  });
});

it('preserves the default Codex model, and supports an explicit model override', async () => {
  vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', JSON.stringify(routing));
  await routeViaCodex({ userMsg: 'Run checks', tabs: ['work'], currentTab: null, codexBinary: binary, model: 'fixture-model' });
  const call = await invocation();
  expect(call.args[call.args.indexOf('--model') + 1]).toBe('fixture-model');
});

it('returns a classified missing-binary failure', async () => {
  const result = await routeViaCodex({ userMsg: 'Run checks', tabs: [], currentTab: null, codexBinary: join(root, 'missing') });
  expect(result.reason).toContain('binary not found');
});

it('terminates its own timed-out subprocess and cleans its workspace', async () => {
  vi.stubEnv('MCIM_CODEX_TEST_MODE', 'hang');
  const result = await routeViaCodex({ userMsg: 'Run checks', tabs: [], currentTab: null, codexBinary: binary, timeoutMs: 1000 });
  expect(result.target).toBeNull();
  expect(result.reason).toMatch(/timeout/);
  await expect(stat((await invocation()).cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});


it.each([
  { behavior: 'allow' },
  { behavior: 'allow', appliedSuggestionIndex: 1 },
  { behavior: 'deny' },
])('preserves existing permission answer semantics: %j', async (answer) => {
  vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', JSON.stringify({ target: 'work', reason: null, answer }));
  expect(await routePermissionRequestViaCodex({ userMsg: 'Reply', pendings: dialogs, codexBinary: binary })).toEqual({ target: 'work', reason: null, answer });
});

it('validates parsed question and permission answers with the existing shared schemas', async () => {
  vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', JSON.stringify({ target: 'work', answers: [{ questionIndex: 0, kind: 'option', optionIndex: 0 }] }));
  expect(await routeAskUserQuestionViaCodex({ userMsg: 'Reply', pendings: questions, codexBinary: binary })).toBeNull();
  vi.stubEnv('MCIM_CODEX_TEST_OUTPUT', JSON.stringify({ target: 'work', answer: { behavior: 'allow', appliedSuggestionIndex: 0 } }));
  expect(await routePermissionRequestViaCodex({ userMsg: 'Reply', pendings: dialogs, codexBinary: binary })).toBeNull();
});
