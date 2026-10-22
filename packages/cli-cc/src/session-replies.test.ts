import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CLIHandler, CLISessionReply } from '@multi-cc-im/shared';
import * as io from './index.js';
import { createCcCliAdapter } from './adapter.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const TS = '2026-10-22T12-00-00-000Z';
const filename = (sid = SID, ts = TS): string => `SessionReply.codex.${sid}.${ts}.json`;
const reply = (overrides: Partial<CLISessionReply> = {}): CLISessionReply => ({
  cli: 'codex', sessionId: SID, sessionName: 'frontend', termId: 'wezterm',
  last_assistant_message: 'finished', ...overrides,
});
let stateDir: string;
let adapter: ReturnType<typeof createCcCliAdapter> | undefined;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), 'named-reply-')); });
afterEach(async () => { await adapter?.stop(); adapter = undefined; await rm(stateDir, { recursive: true, force: true }); });

describe('session reply queue', () => {
  it('writes an exact native name and text in a private atomic event', async () => {
    const payload = reply({ sessionName: '前端 / frontend', last_assistant_message: 'line 1\nline 2' });
    await io.writeSessionReplyFile({ stateDir, timestamp: TS, reply: payload });
    const path = join(stateDir, filename());
    expect(await io.readSessionReplyFile(path)).toEqual(payload);
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('paneId');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(io.parseSessionReplyFilename(path)).toEqual({ sessionId: SID, timestamp: TS });
  });

  it.each([
    { sessionId: '../../outside' }, { sessionName: '  ' }, { termId: 'unknown' },
    { last_assistant_message: 42 }, { cli: 'other' },
  ])('rejects malformed event fields: %j', async fields => {
    await expect(io.writeSessionReplyFile({ stateDir, timestamp: TS, reply: { ...reply(), ...fields } as CLISessionReply })).rejects.toThrow();
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('dispatches sorted restart backlog serially per session with distinct labels', async () => {
    const secondTs = '2026-10-22T12-00-01-000Z';
    const events: CLISessionReply[] = [];
    await writeFile(join(stateDir, filename(SID, secondTs)), JSON.stringify(reply({ last_assistant_message: 'second' })));
    await writeFile(join(stateDir, filename()), JSON.stringify(reply({ last_assistant_message: 'first' })));
    await writeFile(join(stateDir, filename(SID2)), JSON.stringify(reply({ sessionId: SID2, sessionName: 'api' })));
    const handler: CLIHandler = { async onStop() {}, async onPreToolUse() {},
      async onSessionReply(p) { events.push(p); await new Promise(resolve => setTimeout(resolve, 10)); } };
    adapter = createCcCliAdapter({ stateDir });
    await adapter.start(handler);
    expect(events.filter(p => p.sessionId === SID).map(p => p.last_assistant_message)).toEqual(['first', 'second']);
    expect(events.find(p => p.sessionId === SID2)?.sessionName).toBe('api');
    expect(await readdir(stateDir)).toEqual([]);
  });

  it.each(['invalid-json', 'invalid-body', 'session-mismatch', 'handler-error', 'unsupported-handler'])('diagnoses and consumes %s', async scenario => {
    const onHandlerError = vi.fn();
    const body = scenario === 'invalid-json' ? '{broken' : JSON.stringify(reply({
      ...(scenario === 'invalid-body' ? { sessionName: '' } : {}),
      ...(scenario === 'session-mismatch' ? { sessionId: SID2 } : {}),
    }));
    await writeFile(join(stateDir, filename()), body);
    const onSessionReply = vi.fn(async () => { if (scenario === 'handler-error') throw new Error('delivery fixture failed'); });
    adapter = createCcCliAdapter({ stateDir, onHandlerError });
    await adapter.start({ async onStop() {}, async onPreToolUse() {},
      ...(scenario === 'unsupported-handler' ? {} : { onSessionReply }) });
    expect(onHandlerError).toHaveBeenCalledOnce();
    expect(onHandlerError.mock.calls[0]?.[1]).toEqual({ kind: 'SessionReply', sessionId: SID });
    expect(await readdir(stateDir)).toEqual([]);
    if (scenario !== 'handler-error') expect(onSessionReply).not.toHaveBeenCalled();
  });
});
