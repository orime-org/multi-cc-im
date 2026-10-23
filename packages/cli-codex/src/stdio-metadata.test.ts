import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCodexThreadMetadata } from './stdio-metadata.js';

const injection = vi.hoisted(() => ({
  target: 'stdin' as 'stdin' | 'stdout' | 'stderr' | 'child',
  count: 1,
  repeatedError: false,
  child: undefined as ChildProcessWithoutNullStreams | undefined,
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, actual, args) as ChildProcessWithoutNullStreams;
    injection.child = child;
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('"id":2')) return;
      // The microtask runs after readline selects the matching response outcome.
      queueMicrotask(() => {
        const shared = new Error('Late fixture IO failure');
        for (let index = 0; index < injection.count; index++) {
          const target = injection.target === 'child' ? child : child[injection.target];
          target.emit('error', injection.repeatedError ? shared : new Error(`Late fixture IO failure ${index}`));
        }
      });
    });
    return child;
  } };
});

let home: string | undefined;
afterEach(async () => {
  if (injection.child?.pid) expect(() => process.kill(injection.child!.pid!, 0)).toThrow(/ESRCH/);
  injection.child = undefined;
  injection.count = 1;
  injection.repeatedError = false;
  if (home) await rm(home, { recursive: true, force: true });
});

async function fixture(rejectRead = false): Promise<{ errors: unknown[]; read(): Promise<unknown> }> {
  home = await mkdtemp(join(await realpath('/tmp'), 'codex-io-'));
  const result = rejectRead ? { error: { code: -32603, message: 'Fixture rejection' } }
    : { result: { thread: { name: 'Verified name' } } };
  await writeFile(join(home, 'app-server'), `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize')console.log(JSON.stringify({id:message.id,result:{codexHome:process.env.CODEX_HOME,userAgent:'codex_cli_rs/0.163.0',platformFamily:'unix',platformOs:'macos'}}));
 if(message.method==='thread/read')console.log(JSON.stringify({id:message.id,...${JSON.stringify(result)}}));
});`);
  const errors: unknown[] = [];
  const selectedHome = home;
  return { errors, read: () => readCodexThreadMetadata({ home: selectedHome,
    threadId: '019a15e0-329d-7343-9e8c-2d694c948237', executable: process.execPath,
    timeoutMs: 800, onError: err => errors.push(err) }) };
}

it.each(['stdin', 'stdout', 'stderr', 'child'] as const)('reports closing %s errors and preserves metadata', async target => {
  injection.target = target;
  const peer = await fixture();
  expect(await peer.read()).toEqual({ thread: { name: 'Verified name' } });
  expect(peer.errors.map(String)).toEqual(['Error: Late fixture IO failure 0']);
});

it('reports each distinct closing error', async () => {
  injection.target = 'stdin'; injection.count = 2;
  const peer = await fixture();
  expect(await peer.read()).toEqual({ thread: { name: 'Verified name' } });
  expect(peer.errors.map(String)).toEqual(['Error: Late fixture IO failure 0', 'Error: Late fixture IO failure 1']);
});

it('reports a forwarded stdout error once', async () => {
  injection.target = 'stdout'; injection.count = 2; injection.repeatedError = true;
  const peer = await fixture();
  expect(await peer.read()).toEqual({ thread: { name: 'Verified name' } });
  expect(peer.errors.map(String)).toEqual(['Error: Late fixture IO failure']);
});

it('reports closing errors and preserves the selected request failure', async () => {
  injection.target = 'stdin';
  const peer = await fixture(true);
  await expect(peer.read()).rejects.toThrow('rejected the metadata request');
  expect(peer.errors.map(String)).toEqual(['Error: Late fixture IO failure 0']);
});
