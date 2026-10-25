import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CodexEnvelope, codexInitializeParams, codexRuntimeError, getCodexVersion, parseCodexRpcError, validateCodexInitialization } from './app-server-protocol.js';

/**
 * Read native stored thread metadata using one owned stdio App Server process.
 * @param opts Selected home, UUID, total budget and diagnostics. Executable injection
 * runs fixture processes through an installed runtime without new-executable startup overhead.
 * @returns Native result and observed runtime version after subprocess cleanup.
 * @throws Spawn, protocol, initialization, premature-exit or deadline failures.
 * @example const metadata = await readCodexThreadMetadata({ home, threadId, timeoutMs: 800, onError });
 */
export async function readCodexThreadMetadata(opts: {
  home: string; threadId: string; timeoutMs: number; executable?: string; onError(err: unknown): void;
}): Promise<{ result: unknown; version: string }> {
  const started = performance.now();
  const home = resolve(opts.home);
  const child = spawn(opts.executable ?? 'codex', ['app-server', '--listen', 'stdio://'], {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  // A stdout error also reaches readline, so diagnostics retain error identity.
  const diagnostics = new Set<unknown>();
  let version = 'unknown';
  return new Promise<{ result: unknown; version: string }>((accept, reject) => {
    let state: 'initializing' | 'reading' | 'closing' | 'finished' = 'initializing';
    let outcome: { value: unknown } | { error: unknown } | undefined;
    let terminateTimer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined;
    const reserve = Math.min(50, opts.timeoutMs / 4);
    const operationTimer = setTimeout(() => close({ error: new Error('Codex session name lookup timed out') }),
      Math.max(0, opts.timeoutMs - reserve - (performance.now() - started)));

    function close(selected: NonNullable<typeof outcome>): void {
      if (state === 'closing' || state === 'finished') return;
      outcome = 'error' in selected ? { error: codexRuntimeError(state === 'initializing' ? 'initialize' : 'thread/read', version, selected.error) } : selected;
      state = 'closing'; clearTimeout(operationTimer);
      child.stdin.end();
      const remaining = Math.max(0, opts.timeoutMs - (performance.now() - started));
      terminateTimer = setTimeout(() => child.kill('SIGTERM'), Math.min(10, remaining / 4));
      killTimer = setTimeout(() => child.kill('SIGKILL'), Math.min(25, remaining / 2));
    }

    function fail(error: unknown): void {
      if (state === 'closing') { diagnostics.add(error); return; }
      if (state === 'finished') return;
      close({ error });
    }

    function send(message: unknown): void {
      child.stdin.write(JSON.stringify(message) + '\n', err => { if (err) fail(err); });
    }

    lines.on('line', line => {
      if (state === 'closing' || state === 'finished') return;
      try {
        const message = CodexEnvelope.parse(JSON.parse(line));
        if (message.method) return;
        const expected = state === 'initializing' ? 1 : 2;
        if (message.id !== expected) throw new Error('Unexpected Codex App Server metadata response identity');
        if (message.error !== undefined) throw parseCodexRpcError(message.error);
        if (state === 'initializing') {
          version = getCodexVersion(message.result);
          validateCodexInitialization(message.result, home);
          state = 'reading';
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/read', params: { threadId: opts.threadId, includeTurns: false } });
        } else close({ value: message.result });
      } catch (err) { fail(err); }
    });
    lines.on('close', () => {
      if (state === 'initializing' || state === 'reading') fail(new Error('Codex App Server metadata stream closed before its response'));
    });
    lines.on('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stderr.resume();
    child.on('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(operationTimer); clearTimeout(terminateTimer); clearTimeout(killTimer);
      state = 'finished'; lines.close();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (!outcome) reject(codexRuntimeError('metadata reader', version, new Error(`Codex App Server metadata reader exited before its response (code=${code}, signal=${signal})`)));
      else if ('error' in outcome) reject(outcome.error);
      else {
        if (code !== 0 || signal !== null) diagnostics.add(new Error(`Codex App Server metadata reader cleanup required intervention (code=${code}, signal=${signal}); metadata was received.`));
        accept({ result: outcome.value, version });
      }
    });
    send({ id: 1, method: 'initialize', params: codexInitializeParams });
  }).finally(() => {
    for (const diagnostic of diagnostics) opts.onError(codexRuntimeError('metadata reader cleanup', version, diagnostic));
  });
}
