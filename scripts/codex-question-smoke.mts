/** Isolated real-Codex smoke: localhost fake model + real bridge + fake IM/terminal. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createCodexCliAdapter } from '../packages/cli-codex/src/index.js';
import { createOrchestrator } from '../packages/bridge/src/orchestrator.js';
import { writeIMOriginFile, writeIMWorkFile } from '../packages/cli-cc/src/index.js';
import type { IMHandler, IMReplyContext } from '../packages/shared/src/index.js';

const root = await mkdtemp(join(await realpath('/tmp'), 'mqs-'));
const previousCodexHome = process.env['CODEX_HOME'];
const modelInputs: unknown[] = [];
let modelCalls = 0;
let questions = [{ id: 'pick', header: 'Pick', question: 'Choose fixture path',
  options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }];
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  modelInputs.push(JSON.parse(raw)); modelCalls++;
  const item = modelCalls % 2 === 1 ? { type: 'function_call', id: `item-${modelCalls}`, call_id: `call-${modelCalls}`,
    name: 'request_user_input', arguments: JSON.stringify({ questions }) } :
    { type: 'message', id: `msg-${modelCalls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture complete' }] };
  const events = [{ type: 'response.created', response: { id: `resp-${modelCalls}` } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp-${modelCalls}`, status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address !== 'string');
await writeFile(join(root, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[features]\nhooks = false\ndefault_mode_request_user_input = true\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nenv_key = "MCIM_QUESTION_SMOKE_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
await mkdir(join(root, 'app-server-control'));
const socketPath = join(root, 'app-server-control/app-server-control.sock');
const native = spawn('codex', ['app-server', '--listen', `unix://${socketPath}`], {
  cwd: root, env: { ...process.env, CODEX_HOME: root, MCIM_QUESTION_SMOKE_KEY: 'inert-local-fixture' }, stdio: ['ignore', 'pipe', 'pipe'],
});
native.stdout.resume();
let stderr = ''; native.stderr.on('data', chunk => { stderr += String(chunk); });
const exited = new Promise<void>(resolve => native.once('exit', () => resolve()));
const stateDir = join(root, 'state');
const owner: IMReplyContext = { imType: 'lark', openId: 'fixture-owner', chatId: 'fixture-chat' };
let sessionName = 'fixture';
const sent: string[] = [];
const sourceTags: (string | undefined)[] = [];
const errors: string[] = [];
let imHandler: IMHandler | undefined;
let terminalInputs = 0;
let terminalQueries = 0;
let ws: WebSocket | undefined;
let orchestrator: ReturnType<typeof createOrchestrator> | undefined;
const messages: Record<string, unknown>[] = [];
let nextId = 0;

async function wait<T>(get: () => T | undefined | false, label: string): Promise<T> {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = get(); if (value !== undefined && value !== false) return value; await delay(20); }
  throw new Error(`${label} timed out; bridge=${errors.join(';')}; native=${stderr.slice(-500)}`);
}
async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = `fixture:${++nextId}`;
  ws!.send(JSON.stringify({ id, method, params }));
  const response = await wait(() => messages.find(m => m['id'] === id && !m['method']), method);
  assert(!response['error'], JSON.stringify(response['error']));
  return response['result'] as Record<string, unknown>;
}
async function startBridge(): Promise<void> {
  await writeIMOriginFile(stateDir, owner); await writeIMWorkFile(stateDir, 'wezterm', { auto: true });
  const listPanes = async () => { terminalQueries++; throw new Error('Fixture terminal API unavailable'); };
  const cliAdapter = createCodexCliAdapter({ stateDir,
    onWatcherError: err => { errors.push(String(err)); },
    nativeQuestions: { home: root, terminalId: 'wezterm', intervalMs: 30, onError: err => errors.push(String(err)) },
  });
  orchestrator = createOrchestrator({ stateDir, cliAdapter,
    imAdapter: { name: 'lark', async start(h) { imHandler = h; }, async stop() {}, async send(body, _ctx, opts) { sent.push(body); sourceTags.push(opts?.sourceTag); } },
    termAdapter: { name: 'wezterm', listPanes, async start() {}, async stop() {},
      async sendText() { terminalInputs++; }, async sendKeystroke() { terminalInputs++; } },
    state: { getCurrent: () => null, setCurrent() {} }, aiRouter: null,
    aiAskUserQuestionRouter: async () => ({ target: sessionName, reason: null,
      answers: questions.map((_, i) => ({ questionIndex: i, kind: 'option' as const, optionIndex: 2 })) }),
    onError: err => errors.push(String(err)),
  });
  await orchestrator.start();
}
async function imAnswer(reference: string, body: string): Promise<void> {
  await imHandler!.onMessage({ msgId: `im-${nextId++}`, from: 'fixture-owner', timestamp: Date.now(), attachments: [],
    text: `/answer ${reference} ${body}`, replyCtx: owner });
}
async function begin(threadId: string, mode: 'plan' | 'default' = 'plan'): Promise<{ reference: string; turnId: string; requestId: unknown }> {
  const before = sent.length;
  const response = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Ask the fixture question' }],
    collaborationMode: { mode, settings: { model: 'fixture-model', reasoning_effort: 'medium', developer_instructions: null } } });
  const turnId = (response['turn'] as { id: string }).id;
  const request = await wait(() => messages.find(m => m['method'] === 'item/tool/requestUserInput' && (m['params'] as { turnId?: string })?.turnId === turnId), 'native question');
  const question = await wait(() => sent.slice(before).find(s => /\/answer codex-/.test(s)), 'forwarded question');
  const reference = /\/answer (codex-[a-f0-9]{24})/.exec(question)![1]!;
  assert.equal(sourceTags[sent.indexOf(question)], sessionName);
  return { reference, turnId, requestId: request['id'] };
}
async function completed(turnId: string): Promise<void> {
  await wait(() => messages.find(m => m['method'] === 'turn/completed' && (m['params'] as { turn?: { id?: string } })?.turn?.id === turnId), 'native completion');
}

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = new WebSocket('ws://localhost/', { createConnection: () => connect(socketPath), handshakeTimeout: 300 });
    const opened = await new Promise<boolean>(resolve => { candidate.once('open', () => resolve(true)); candidate.once('error', () => resolve(false)); });
    if (opened) { ws = candidate; break; }
    candidate.terminate(); await delay(30);
  }
  assert(ws, 'Fixture App Server did not start');
  ws.on('message', raw => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  await rpc('initialize', { clientInfo: { name: 'mcim_fixture_tui', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const response = await rpc('thread/start', { cwd: root, model: 'fixture-model', approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = (response['thread'] as { id: string }).id;
  process.env['CODEX_HOME'] = root;
  await rpc('thread/name/set', { threadId, name: sessionName });
  await startBridge();
  const first = await begin(threadId);
  await imAnswer(first.reference, '2'); await completed(first.turnId);
  assert(JSON.stringify(modelInputs[1]).includes('Two'));
  console.log('PASS: real native question -> actual bridge -> fake IM -> native model input; auto mode still asks.');
  const second = await begin(threadId);
  ws.send(JSON.stringify({ id: second.requestId, result: { answers: { pick: { answers: ['One'] } } } }));
  await completed(second.turnId); await imAnswer(second.reference, '2');
  assert(!JSON.stringify(modelInputs[3]).includes('"answers":["Two"]'));
  console.log('PASS: terminal-first answer wins; late IM reply is consumed without terminal input.');
  sessionName = 'fixture-renamed';
  await rpc('thread/name/set', { threadId, name: sessionName });
  const third = await begin(threadId, 'default');
  await orchestrator!.stop();
  await startBridge();
  await wait(() => sent.filter(s => s.includes(`/answer ${third.reference}`)).length >= 2 || undefined, 'restart replay');
  await imAnswer(third.reference, '2'); await completed(third.turnId);
  assert(JSON.stringify(modelInputs[5]).includes('Two'));
  console.log('PASS: daemon restart rediscovers the renamed native session and pending nonblocking question with the same reference.');
  questions = [questions[0]!, { ...questions[0]!, id: 'another', header: 'Another' }];
  const fourth = await begin(threadId);
  await imAnswer(fourth.reference, 'Use the second option for both'); await completed(fourth.turnId);
  const last = JSON.stringify(modelInputs[7]);
  assert(last.includes('another') && last.includes('Two'));
  assert.equal(terminalInputs, 0);
  assert.equal(terminalQueries, 0);
  console.log('PASS: multiple questions use the interpreter and reach the original native ids.');
  console.log('PASS: native discovery, delivery, answers and restart used zero terminal queries.');
} finally {
  await orchestrator?.stop(); ws?.terminate();
  native.kill('SIGTERM');
  const forceStop = setTimeout(() => native.kill('SIGKILL'), 1000);
  await exited; clearTimeout(forceStop);
  await new Promise<void>(resolve => provider.close(() => resolve()));
  if (previousCodexHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previousCodexHome;
  await rm(root, { recursive: true, force: true });
}
