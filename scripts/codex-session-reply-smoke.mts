/** Real native Stop hooks, bundled receiver, shared watcher and recording IM. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createConfigStore } from '../packages/storage-files/src/index.js';
import { resolveAppPaths } from '../apps/multi-cc-im/src/config-paths.js';
import { createCodexCliAdapter } from '../packages/cli-codex/src/index.js';
import { connectCodexLocal } from '../packages/cli-codex/src/local-client.js';
import { createOrchestrator } from '../packages/bridge/src/orchestrator.js';
import { captureProcessLstart, writeDaemonPidFile, writeIMOriginFile, writeIMWorkFile } from '../packages/cli-cc/src/index.js';

const root = await mkdtemp(join(await realpath('/tmp'), 'msr-'));
const nativeHome = join(root, 'native');
const project = join(root, 'project-root');
const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: join(root, 'bridge') } });
const bundle = fileURLToPath(new URL('../apps/multi-cc-im/dist/cli.js', import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const hookCommand = `${quote(process.execPath)} ${quote(bundle)} hook-receiver-codex`;
const delivered: { text: string; source: string | undefined }[] = [];
const diagnostics: string[] = [];
let terminalLookups = 0;
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const text = raw.includes('from-api') ? 'API reply' : 'Frontend reply';
  const item = { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] };
  const events = [{ type: 'response.created', response: { id: 'fixture-response' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
let native: ReturnType<typeof spawn> | undefined;
let nativeExit: Promise<void> | undefined;
let peer: ReturnType<typeof connectCodexLocal> | undefined;
let bridge: ReturnType<typeof createOrchestrator> | undefined;
let stderr = '';
const completedHooks: unknown[] = [];
const nativeEvents: { method: string; params: unknown }[] = [];

async function wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`${label} timed out; diagnostics=${diagnostics.join('; ')}; native=${stderr.slice(-2000)}; events=${JSON.stringify(nativeEvents)}`);
}

try {
  await access(bundle);
  await mkdir(join(nativeHome, 'app-server-control'), { recursive: true });
  await mkdir(project);
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  await writeFile(join(nativeHome, 'config.toml'), `model="fixture"
model_provider="fixture"
[features]
hooks=true
[tui]
terminal_title=["thread-name","activity"]
[model_providers.fixture]
name="Local fixture"
base_url="http://127.0.0.1:${address.port}/v1"
wire_api="responses"
env_key="MCIM_REPLY_SMOKE_KEY"
request_max_retries=0
stream_max_retries=0
[projects.${JSON.stringify(project)}]
trust_level="trusted"
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type="command"
command=${JSON.stringify(hookCommand)}
timeout=10
`, { mode: 0o600 });
  const store = createConfigStore({ filePath: paths.configToml });
  const config = await store.load();
  await store.save({ ...config, cli: { enabled: ['codex'], aiRouter: 'codex' },
    terminal: { type: 'wezterm' }, external_paths: { wezterm: join(root, 'unavailable-terminal') } });
  const socket = join(nativeHome, 'app-server-control/app-server-control.sock');
  native = spawn('codex', ['app-server', '--listen', `unix://${socket}`], {
    cwd: project,
    env: { ...process.env, CODEX_HOME: nativeHome, MULTI_CC_IM_HOME: paths.root,
      WEZTERM_PANE: '700', MCIM_REPLY_SMOKE_KEY: 'inert-local-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nativeExit = new Promise<void>(resolve => native!.once('exit', () => resolve()));
  native.stdout!.resume(); native.stderr!.on('data', chunk => { stderr += String(chunk); });
  console.log(`Owned native fixture PID=${native.pid}`);
  await wait(async () => {
    try { await access(socket); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
  }, 'local native socket');
  peer = connectCodexLocal({ home: nativeHome, onError: err => diagnostics.push(String(err)),
    onEvent(_id, method, params) {
      if (method === 'hook/completed') completedHooks.push(params);
      if (['hook/started', 'hook/completed', 'turn/completed', 'error'].includes(method)) nativeEvents.push({ method, params });
    } });
  await peer.ready;
  const hookConfiguration = await peer.call('hooks/list', { cwds: [project] });
  const HookList = z.object({ data: z.array(z.object({ hooks: z.array(z.object({
    key: z.string(), eventName: z.string(), currentHash: z.string(), enabled: z.boolean(), trustStatus: z.string(),
  })) })) });
  const hook = HookList.parse(hookConfiguration).data[0]!.hooks.find(h => h.eventName === 'stop');
  assert(hook?.enabled);
  // The known bundle command is reviewed only within this disposable native home.
  await appendFile(join(nativeHome, 'config.toml'), `\n[hooks.state.${JSON.stringify(hook.key)}]\nenabled=true\ntrusted_hash=${JSON.stringify(hook.currentHash)}\n`);
  const reviewed = HookList.parse(await peer.call('hooks/list', { cwds: [project] })).data[0]!.hooks[0]!;
  assert.equal(reviewed.trustStatus, 'trusted');
  await writeIMWorkFile(paths.stateDir, 'wezterm');
  await writeIMOriginFile(paths.stateDir, { imType: 'lark', openId: 'fixture-owner', chatId: 'fixture-chat' });
  const startedAt = await captureProcessLstart(process.pid); assert(startedAt);
  await writeDaemonPidFile({ stateDir: paths.stateDir, pid: process.pid, startedAt });
  const cliAdapter = createCodexCliAdapter({ stateDir: paths.stateDir,
    onWatcherError: err => diagnostics.push(String(err)),
    onHandlerError: err => diagnostics.push(String(err)) });
  bridge = createOrchestrator({ stateDir: paths.stateDir, cliAdapter,
    imAdapter: { name: 'recording', async start() {}, async stop() {},
      async send(text, _ctx, options) { delivered.push({ text, source: options?.sourceTag }); } },
    termAdapter: { name: 'wezterm', async start() {}, async stop() {},
      async listPanes() { terminalLookups++; throw new Error('Terminal API deliberately unavailable'); },
      async sendText() { throw new Error('Unexpected terminal input'); }, async sendKeystroke() { throw new Error('Unexpected terminal input'); } },
    state: { getCurrent: () => null, setCurrent() {} }, aiRouter: null,
    onError: err => diagnostics.push(String(err)),
  });
  await bridge.start();
  const threads: { id: string; name: string; prompt: string }[] = [];
  for (const [name, prompt] of [['frontend', 'from-frontend'], ['api', 'from-api']]) {
    const result = await peer.call('thread/start', { cwd: project, model: 'fixture', approvalPolicy: 'never', sandbox: 'read-only' }) as { thread: { id: string } };
    await peer.call('thread/name/set', { threadId: result.thread.id, name });
    threads.push({ id: result.thread.id, name: name!, prompt: prompt! });
  }
  await Promise.all(threads.map(thread => peer!.call('turn/start', { threadId: thread.id,
    input: [{ type: 'text', text: thread.prompt }] })));
  await wait(() => delivered.length === 2, 'two actual Stop replies');
  assert.deepEqual(delivered.toSorted((a, b) => a.source!.localeCompare(b.source!)), [
    { text: 'API reply', source: 'api' }, { text: 'Frontend reply', source: 'frontend' },
  ]);
  console.log('PASS: actual native Stop hooks -> bundled receiver -> shared watcher -> bridge -> named IM replies for two same-project sessions.');
  await peer.call('thread/name/set', { threadId: threads[0]!.id, name: 'renamed-frontend' });
  await peer.call('turn/start', { threadId: threads[0]!.id, input: [{ type: 'text', text: 'from-frontend again' }] });
  await wait(() => delivered.length === 3, 'renamed Stop reply');
  assert.equal(delivered[2]!.source, 'renamed-frontend');
  assert.equal(terminalLookups, 0);
  assert.equal(completedHooks.length, 3);
  assert.deepEqual(diagnostics, []);
  console.log('PASS: next Stop uses the renamed native session; terminal API is unavailable and inherited pane is 700.');
} finally {
  await bridge?.stop(); peer?.close();
  if (native) {
    native.kill('SIGTERM');
    const deadline = setTimeout(() => native?.kill('SIGKILL'), 1500);
    await nativeExit; clearTimeout(deadline);
  }
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
