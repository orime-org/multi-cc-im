import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCodexSessionName } from './session-name.js';

let home: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

it('reads a named session through stdio when the shared control socket is absent', async () => {
  home = await mkdtemp(join(await realpath('/tmp'), 'codex-stdio-red-'));
  await writeFile(join(home, 'app-server'), `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const home = process.env.CODEX_HOME;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(home + '/requests.jsonl', JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {
    codexHome: home, userAgent: 'codex_cli_rs/0.163.0', platformFamily: 'unix', platformOs: 'macos',
  } }));
  if (message.method === 'thread/read') console.log(JSON.stringify({ id: message.id, result: {
    thread: { id: message.params.threadId, name: 'Named in-process session', source: 'cli' },
  } }));
});
`, { mode: 0o700 });
  const errors: unknown[] = [];
  const result = await resolveCodexSessionName('019a15e0-329d-7343-9e8c-2d694c948237', {
    home, executable: process.execPath, onError: err => errors.push(err),
  });
  expect(result, errors.map(String).join('\n')).toBe('Named in-process session');
  expect(errors).toEqual([]);
  const requests = (await readFile(join(home, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method: string });
  expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/read']);
});
