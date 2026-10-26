/** Research fixture: native hook origin versus the actual TUI's thread-id title. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createCodexQuestionClient } from '../packages/cli-codex/src/question-client.js';
import type { CLIQuestionRequest } from '../packages/shared/src/index.js';
import { resolveCodexHookOrigin } from '../packages/cli-codex/src/hook-origin.js';
import { connectCodexLocal } from '../packages/cli-codex/src/local-client.js';
import { runCodexHookCommand } from '../apps/multi-cc-im/src/codex-hook.js';
import { createConfigStore } from '../packages/storage-files/src/index.js';
import { resolveAppPaths } from '../apps/multi-cc-im/src/config-paths.js';
import { captureProcessLstart, writeDaemonPidFile, writeIMWorkFile, writeIMOriginFile, listStopFiles, parseSessionReplyFilename, readSessionReplyFile } from '../packages/cli-cc/src/index.js';
import type { PaneId } from '../packages/shared/src/index.js';

const Marker = z.object({ threadId: z.string().uuid(), pane: z.string(), source: z.literal('startup') });

const runFile = promisify(execFile);
const codexVersion = (await runFile('codex', ['--version'])).stdout.trim();
const root = await mkdtemp(join(await realpath('/tmp'), 'mcim-id-'));
await mkdir(join(root, 'app-server-control'));
const socket = join(root, 'app-server-control/app-server-control.sock');
const modelInputs: string[] = [];
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  modelInputs.push(raw);
  const answered = raw.includes('function_call_output');
  const item = answered ? { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Identity fixture complete.' }] } :
    { type: 'function_call', id: 'fixture-question', call_id: 'fixture-question-call', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'choice', header: 'Choice', question: 'Choose a fixture path',
        options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] }) };
  const events = [{ type: 'response.created', response: { id: 'fixture-response' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
  res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
});
let server: ReturnType<typeof spawn> | undefined;
let questionClient: ReturnType<typeof createCodexQuestionClient> | undefined;
let exited: Promise<void> | undefined;
let stderr = '';
let capture: Promise<{ error?: unknown }> | undefined;
const previousHome = process.env.CODEX_HOME, previousPane = process.env.WEZTERM_PANE;
try {
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  await writeFile(join(root, 'marker.mjs'), `import {appendFileSync} from 'node:fs';
let raw=''; for await(const chunk of process.stdin) raw+=chunk;
const p=JSON.parse(raw);
appendFileSync(${JSON.stringify(join(root, 'markers.jsonl'))},JSON.stringify({threadId:p.session_id,source:p.source,pane:process.env.WEZTERM_PANE})+'\\n');
`, { mode: 0o600 });
  await writeFile(join(root, 'config.toml'), `model="fixture"
model_provider="fixture"
[tui]
terminal_title=["thread-id"]
[features]
hooks=true
default_mode_request_user_input=true
[model_providers.fixture]
name="Local fixture"
base_url="http://127.0.0.1:${address.port}/v1"
wire_api="responses"
env_key="MCIM_IDENTITY_FIXTURE_KEY"
request_max_retries=0
stream_max_retries=0
[projects.${JSON.stringify(root)}]
trust_level="trusted"
[[hooks.SessionStart]]
matcher=".*"
[[hooks.SessionStart.hooks]]
type="command"
command=${JSON.stringify('node ' + join(root, 'marker.mjs'))}
`, { mode: 0o600 });
  server = spawn('codex', ['--dangerously-bypass-hook-trust', 'app-server', '--listen', `unix://${socket}`], {
    cwd: root, env: { ...process.env, CODEX_HOME: root, WEZTERM_PANE: '700', MCIM_IDENTITY_FIXTURE_KEY: 'inert-local-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.resume(); server.stderr!.on('data', chunk => { stderr += String(chunk); });
  exited = new Promise<void>(resolve => server!.once('exit', () => resolve()));
  await delay(500);
  // PTYs are owned fixtures. Control-response handling below is test capture,
  // not a proposed product terminal parser or a wrapper around a user's TUI.
  const helper = `import os,pty,fcntl,termios,struct,time,select,signal
children=[]
try:
 for pane in ['800','900']:
  pid,fd=pty.fork()
  if pid==0:
   os.chdir(${JSON.stringify(root)})
   env={**os.environ,'CODEX_HOME':${JSON.stringify(root)},'WEZTERM_PANE':pane,'TERM':'xterm-256color','MCIM_IDENTITY_FIXTURE_KEY':'inert-local-fixture'}
   os.execvpe('codex',['codex','--dangerously-bypass-hook-trust','--remote',${JSON.stringify('unix://' + socket)},'--no-alt-screen','Finish the identity fixture without using tools.'],env)
  fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0))
  children.append((pid,fd,pane))
 end=time.time()+8
 while time.time()<end:
  for pid,fd,pane in children:
   if select.select([fd],[],[],0.05)[0]:
    try:
     data=os.read(fd,65536)
     with open(${JSON.stringify(root)}+'/tui-'+pane+'.log','ab') as log:log.write(data)
     if b'\\x1b[6n' in data:os.write(fd,b'\\x1b[1;1R')
    except OSError as err:
     if err.errno!=5:raise
finally:
 for pid,fd,pane in children:
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
 time.sleep(0.3)
 for pid,fd,pane in children:
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
  os.close(fd)
  os.waitpid(pid,0)
`;
  await writeFile(join(root, 'tui-fixture.py'), helper, { mode: 0o600 });
  capture = runFile('python3', [join(root, 'tui-fixture.py')], { timeout: 15000 }).then(() => ({}), error => ({ error }));
  // Read while both real native clients are still attached.
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const data = await Promise.all(['800', '900'].map(p => readFile(join(root, `tui-${p}.log`), 'utf8')));
      ready = data.every(raw => /\x1b\]0;[0-9a-f-]+\.\.\./.test(raw));
      const markersReady = (await readFile(join(root, 'markers.jsonl'), 'utf8')).trim().split('\n').length === 2;
      if (ready && markersReady) break;
      ready = false;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    await delay(30);
  }
  assert(ready, 'Both native TUI titles must be available while attached');
  const markers = (await readFile(join(root, 'markers.jsonl'), 'utf8')).trim().split('\n')
    .map(line => Marker.parse(JSON.parse(line)));
  assert.equal(markers.length, 2, stderr);
  assert(markers.every(m => m.pane === '700'));
  const actual: Record<string, string> = {};
  for (const pane of ['800', '900']) {
    const output = await readFile(join(root, `tui-${pane}.log`), 'utf8');
    const prefix = [...output.matchAll(/\x1b\]0;([0-9a-f-]+)\.\.\.[^\x07]*\x07/g)][0]?.[1];
    assert(prefix, `No native thread-id title for fixture pane ${pane}`);
    const matched = markers.filter(m => m.threadId.startsWith(prefix));
    assert.equal(matched.length, 1, 'Native title prefix must match exactly one fixture thread');
    actual[pane] = matched[0]!.threadId;
  }
  assert.notEqual(actual['800'], actual['900']);
  const freshPanes = () => Promise.all(['800', '900'].map(async p => {
    const raw = await readFile(join(root, `tui-${p}.log`), 'utf8');
    const terminalTitle = [...raw.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].at(-1)?.[1];
    return { paneId: Number(p) as PaneId, title: 'same-project', cwd: root, terminalTitle };
  }));
  const panes = await freshPanes();
  for (const p of ['800', '900']) {
    const diagnostics: unknown[] = [];
    const origin = await resolveCodexHookOrigin(actual[p]!, { home: root, terminalId: 'wezterm',
      listPanes: freshPanes, onError: e => diagnostics.push(e) });
    assert.equal(origin?.paneId, Number(p), diagnostics.map(String).join(';'));
  }
  const paths = resolveAppPaths({ env: { MULTI_CC_IM_HOME: join(root, 'bridge') } });
  const fixtureTerm = join(root, 'wezterm-fixture.mjs');
  await writeFile(fixtureTerm, "#!/bin/sh\ncat <<'MCIM_NATIVE_TITLE_FIXTURE'\n" +
    JSON.stringify(panes.map(p => ({ pane_id: p.paneId, title: p.terminalTitle, cwd: p.cwd }))) +
    "\nMCIM_NATIVE_TITLE_FIXTURE\n", { mode: 0o700 });
  const fixtureOutput = await runFile(fixtureTerm, ['cli', 'list', '--format', 'json'], { timeout: 3000 });
  assert.equal(JSON.parse(fixtureOutput.stdout).length, 2);
  const store = createConfigStore({ filePath: paths.configToml });
  const cfg = await store.load();
  await store.save({ ...cfg, cli: { ...cfg.cli, enabled: ['codex'], aiRouter: 'codex' },
    external_paths: { ...cfg.external_paths, wezterm: fixtureTerm } });
  await writeIMWorkFile(paths.stateDir, 'wezterm', { auto: true });
  await writeIMOriginFile(paths.stateDir, { imType: 'lark', openId: 'fixture-owner', chatId: 'fixture-chat' });
  await writeDaemonPidFile({ stateDir: paths.stateDir, pid: process.pid, startedAt: (await captureProcessLstart(process.pid))! });
  process.env.CODEX_HOME = root; process.env.WEZTERM_PANE = '700';
  const metadataClient = connectCodexLocal({ home: root, onError: err => { throw err; } });
  try {
    await metadataClient.ready;
    for (const p of ['800', '900']) await metadataClient.call('thread/name/set', { threadId: actual[p]!, name: `fixture-${p}` });
  } finally { metadataClient.close(); }
  for (const p of ['800', '900']) {
    const common = { session_id: actual[p]!, cwd: root, transcript_path: null, model: 'fixture', permission_mode: 'default', turn_id: 'fixture-turn' };
    const errors: unknown[] = [];
    await runCodexHookCommand(JSON.stringify({ ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'fixture reply' }),
      { paths, onError: e => errors.push(e) });
    const files = (await readdir(paths.stateDir)).filter(name => parseSessionReplyFilename(name)?.sessionId === actual[p]);
    assert.equal(files.length, 1, errors.map(String).join(';'));
    const reply = await readSessionReplyFile(join(paths.stateDir, files[0]!));
    assert.equal(reply?.sessionName, `fixture-${p}`);
    const decision = await runCodexHookCommand(JSON.stringify({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'fixture' }, tool_use_id: 'fixture-tool' }),
      { paths, onError: e => errors.push(e) });
    assert.deepEqual(decision, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      permissionDecisionReason: '[multi-cc-im] IMWork auto-approve, allow without IM prompt' } });
  }
  assert.equal((await listStopFiles({ stateDir: paths.stateDir, paneId: 700 as PaneId, sessionId: actual['800']! })).length, 0);
  console.log('PASS: production Stop entry writes native session-name replies; auto approval uses the client title identity with inherited server pane 700.');
  const seen: CLIQuestionRequest[] = [], errors: unknown[] = [];
  questionClient = createCodexQuestionClient({ home: root, terminalId: 'wezterm', intervalMs: 30,
    onError: e => errors.push(e) });
  await questionClient.start({ async onStop() {}, async onPreToolUse() {}, async onQuestion(q) { seen.push(q); } });
  for (let attempt = 0; attempt < 100 && seen.length < 2; attempt++) await delay(20);
  assert.equal(seen.length, 2, errors.map(String).join(';'));
  for (const q of seen) {
    const pane = q.sessionName === 'fixture-800' ? '800' : '900';
    assert.equal(q.sessionName, `fixture-${pane}`);
    assert.equal(q.threadId, actual[pane]);
    assert.equal(await questionClient.answer(q.reference, { choice: [pane === '800' ? 'Two' : 'One'] }), 'submitted');
  }
  for (let attempt = 0; attempt < 100 && modelInputs.length < 4; attempt++) await delay(20);
  assert(modelInputs.some(raw => raw.includes('function_call_output') && raw.includes('Two')));
  assert(modelInputs.some(raw => raw.includes('function_call_output') && raw.includes('One')));
  console.log('PASS: both real TUIs native questions preserve session names and receive separate product-client answers in their model inputs.');
  await questionClient.stop();
  const captured = await capture;
  if (captured.error) throw captured.error;
  console.log('PASS: product hook resolver identifies both real TUI threads by captured official titles and current native loaded ids, never server pane 700.');
  console.log(JSON.stringify({ codex: codexVersion, serverPane: '700', hooks: markers, actualTuiThreads: actual }, null, 2));
  console.log('CONFIRMED: hooks inherit the server pane; official TUI thread-id titles identify distinct client threads (truncated prefixes).');
} finally {
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  if (previousPane === undefined) delete process.env.WEZTERM_PANE; else process.env.WEZTERM_PANE = previousPane;
  await questionClient?.stop();
  await capture;
  if (server && exited) {
    server.kill('SIGTERM');
    const forceStop = setTimeout(() => server!.kill('SIGKILL'), 1000);
    await exited; clearTimeout(forceStop);
  }
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
