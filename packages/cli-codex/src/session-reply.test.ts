import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcessLstart, writeDaemonPidFile, writeIMOriginFile, writeIMWorkFile } from '@multi-cc-im/cli-cc';
import { runHookReceiver } from './hook-receiver.js';
import type { StopPayload } from './payloads.js';

const SID = '11111111-1111-4111-8111-111111111111';
const payload: StopPayload = { session_id: SID, hook_event_name: 'Stop', cwd: '/fixture/project',
  transcript_path: null, model: 'fixture', permission_mode: 'default', turn_id: 'turn',
  stop_hook_active: false, last_assistant_message: 'answer' };
let stateDir: string;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), 'codex-session-reply-')); });
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

async function openGates(): Promise<void> {
  await writeIMWorkFile(stateDir, 'wezterm');
  await writeIMOriginFile(stateDir, { imType: 'lark', openId: 'owner', chatId: 'chat' });
  const startedAt = await captureProcessLstart(process.pid);
  expect(startedAt).not.toBeNull();
  await writeDaemonPidFile({ stateDir, pid: process.pid, startedAt: startedAt! });
}

describe('Codex named Stop reply', () => {
  it('queues a native session reply while pane lookup is unavailable', async () => {
    await openGates();
    const pane = vi.fn(() => undefined);
    const name = vi.fn(async () => 'frontend');
    await runHookReceiver({ stateDir, payload, resolvePaneOrigin: pane,
      stop: { termId: 'wezterm', resolveSessionName: name }, now: () => new Date('2026-10-22T12:00:00.000Z') });
    const file = `SessionReply.codex.${SID}.2026-10-22T12-00-00-000Z.json`;
    expect(JSON.parse(await readFile(join(stateDir, file), 'utf8'))).toEqual({
      cli: 'codex', sessionId: SID, sessionName: 'frontend', termId: 'wezterm', last_assistant_message: 'answer',
    });
    expect(name).toHaveBeenCalledWith(SID);
    expect(pane).not.toHaveBeenCalled();
  });

  it.each(['im-off', 'no-origin', 'dead-daemon', 'empty', 'null', 'active'] as const)('skips name lookup when %s', async scenario => {
    if (scenario !== 'im-off') await writeIMWorkFile(stateDir, 'wezterm');
    if (scenario !== 'no-origin') await writeIMOriginFile(stateDir, { imType: 'lark', openId: 'owner', chatId: 'chat' });
    if (!['im-off', 'no-origin', 'dead-daemon'].includes(scenario)) await openGates();
    const name = vi.fn(async () => 'frontend');
    const pane = vi.fn(() => undefined);
    await runHookReceiver({ stateDir, payload: { ...payload,
      last_assistant_message: scenario === 'empty' ? '' : scenario === 'null' ? null : 'answer',
      stop_hook_active: scenario === 'active' }, resolvePaneOrigin: pane,
      stop: { termId: 'wezterm', resolveSessionName: name } });
    expect(name).not.toHaveBeenCalled();
    expect(pane).not.toHaveBeenCalled();
    expect((await readdir(stateDir)).filter(n => n.startsWith('SessionReply.'))).toEqual([]);
  });

  it('writes no event when the native name is unavailable', async () => {
    await openGates();
    await runHookReceiver({ stateDir, payload, stop: { termId: 'wezterm', resolveSessionName: async () => undefined } });
    expect((await readdir(stateDir)).filter(n => n.startsWith('SessionReply.'))).toEqual([]);
  });
});
