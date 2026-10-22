import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeIMOriginFile, writeIMWorkFile, deleteIMWorkFile } from '@multi-cc-im/cli-cc';
import type { CLIQuestionRequest, IMReplyContext, IncomingMessage, PaneId } from '@multi-cc-im/shared';
import { createNativeQuestionBridge } from './native-questions.js';

const owner: IMReplyContext = { imType: 'lark', openId: 'owner', chatId: 'chat' };
const q: CLIQuestionRequest = { reference: 'codex-abcdef0123456789abcdef01', threadId: 'thread', turnId: 'turn', itemId: 'item', requestId: 1,
  termId: 'wezterm', paneId: 7 as PaneId, isBlocking: true,
  questions: [{ id: 'choice', header: 'Pick', question: 'Which?', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] };
let stateDir: string, pending: CLIQuestionRequest[], sent: string[], errors: unknown[];
let bridge: ReturnType<typeof createNativeQuestionBridge>;
const answer = vi.fn();
const interpret = vi.fn();
function message(text: string, replyCtx = owner): IncomingMessage {
  return { msgId: 'm1', from: 'owner', text, replyCtx, attachments: [], timestamp: Date.now() };
}
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'mqb-')); pending = [q]; sent = []; errors = [];
  answer.mockReset().mockResolvedValue('submitted'); interpret.mockReset();
  await writeIMOriginFile(stateDir, owner); await writeIMWorkFile(stateDir, 'wezterm', { auto: true });
  bridge = createNativeQuestionBridge({ stateDir, terminalId: 'wezterm',
    questions: { listPending: () => pending, answer },
    imAdapter: { name: 'lark', async start() {}, async stop() {}, async send(content) { sent.push(content); } },
    listPanes: async () => [{ paneId: q.paneId, title: 'work', cwd: '/tmp' }],
    interpret, onError: err => errors.push(err),
  });
});
afterEach(async () => { await bridge.stop(); await rm(stateDir, { recursive: true, force: true }); });

describe('native question IM bridge', () => {
  it('forwards in auto mode, requires actual user answer, maps option label to native id', async () => {
    await bridge.start();
    expect(sent[0]).toContain('/answer ' + q.reference);
    expect(sent[0]).toContain('1. One'); expect(answer).not.toHaveBeenCalled();
    expect(await bridge.handleInbound(message(`/answer ${q.reference} 2`))).toBe(true);
    expect(answer).toHaveBeenCalledWith(q.reference, { choice: ['Two'] });
    expect(interpret).not.toHaveBeenCalled();
  });

  it('forwards once, supports quoted bot replies and preserves normal chat routing', async () => {
    await bridge.start(); await bridge.flush(); expect(sent).toHaveLength(1);
    expect(await bridge.handleInbound(message('new task'))).toBe(false);
    const reply = message('1');
    reply.quotedMessage = { content: sent[0]!, sender: { id: 'bot', role: 'bot' } };
    expect(await bridge.handleInbound(reply)).toBe(true);
    expect(answer).toHaveBeenCalledWith(q.reference, { choice: ['One'] });
  });

  it('checks IMWork and owner/chat at both forwarding and submission', async () => {
    await deleteIMWorkFile(stateDir, 'wezterm'); await bridge.start(); expect(sent).toEqual([]);
    await writeIMWorkFile(stateDir, 'wezterm', { auto: false }); await bridge.flush(); expect(sent).toHaveLength(1);
    const other: IMReplyContext = { imType: 'lark', openId: 'stranger', chatId: 'chat' };
    expect(await bridge.handleInbound(message(`/answer ${q.reference} 1`, other))).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    await deleteIMWorkFile(stateDir, 'wezterm');
    await bridge.handleInbound(message(`/answer ${q.reference} 1`)); expect(answer).not.toHaveBeenCalled();
  });

  it('consumes stale, malformed and missing references without routing a new prompt', async () => {
    await bridge.start(); pending = []; await bridge.onQuestionClosed(q.reference, 'resolved');
    for (const text of [`/answer ${q.reference} 1`, '/answer codex-unknown 1', '/answer']) {
      expect(await bridge.handleInbound(message(text))).toBe(true);
    }
    expect(answer).not.toHaveBeenCalled(); expect(sent.join('\n')).toContain('已结束');
  });

  it('rejects missing, duplicate and invalid AI answers, then handles complete multiple questions', async () => {
    pending = [{ ...q, questions: [...q.questions, { id: 'why', header: 'Why', question: 'Reason?', options: null }] }];
    await bridge.start();
    for (const answers of [[], [{ questionIndex: 0, kind: 'option', optionIndex: 99 }],
      [{ questionIndex: 0, kind: 'text', text: 'a' }, { questionIndex: 0, kind: 'text', text: 'b' }]]) {
      interpret.mockResolvedValue({ target: 'work', reason: null, answers });
      await bridge.handleInbound(message(`/answer ${q.reference} second, because useful`));
      expect(answer).not.toHaveBeenCalled();
    }
    interpret.mockResolvedValue({ target: 'work', reason: null, answers: [
      { questionIndex: 0, kind: 'option', optionIndex: 2 }, { questionIndex: 1, kind: 'text', text: 'because useful' }] });
    await bridge.handleInbound(message(`/answer ${q.reference} second, because useful`));
    expect(answer).toHaveBeenCalledWith(q.reference, { choice: ['Two'], why: ['because useful'] });
  });

  it('shows a terminal-only notice for sensitive requests and never interprets the reply', async () => {
    pending = [{ ...q, questions: [{ ...q.questions[0]!, isSecret: true, question: 'private prompt marker' }] }];
    await bridge.start(); expect(sent[0]).toContain('敏感输入'); expect(sent[0]).not.toContain('private prompt marker');
    const reply = message('private answer'); reply.quotedMessage = { content: sent[0]!, sender: { id: 'bot', role: 'bot' } };
    expect(await bridge.handleInbound(reply)).toBe(true);
    expect(answer).not.toHaveBeenCalled(); expect(interpret).not.toHaveBeenCalled();
  });

  it('consumes a tab-prefixed answer and rechecks IM mode after interpretation', async () => {
    await bridge.start();
    interpret.mockImplementation(async () => { await deleteIMWorkFile(stateDir, 'wezterm');
      return { target: 'work', reason: null, answers: [{ questionIndex: 0, kind: 'text', text: 'user answer' }] }; });
    expect(await bridge.handleInbound(message(`#work /answer ${q.reference} user answer`))).toBe(true);
    expect(answer).not.toHaveBeenCalled();
  });

  it('rechecks pending after interpretation when the terminal wins the race', async () => {
    await bridge.start();
    interpret.mockImplementation(async () => { pending = []; await bridge.onQuestionClosed(q.reference, 'resolved');
      return { target: 'work', reason: null, answers: [{ questionIndex: 0, kind: 'text', text: 'user answer' }] }; });
    await bridge.handleInbound(message(`/answer ${q.reference} user answer`));
    expect(answer).not.toHaveBeenCalled();
  });

  it('reports disconnect, reconciles replay and allows the same reference after restart', async () => {
    await bridge.start(); pending = []; await bridge.onQuestionClosed(q.reference, 'disconnected');
    await bridge.handleInbound(message(`/answer ${q.reference} 1`)); expect(answer).not.toHaveBeenCalled();
    pending = [q]; await bridge.flush();
    await bridge.handleInbound(message(`/answer ${q.reference} 1`)); expect(answer).toHaveBeenCalledTimes(1);
    await bridge.stop(); answer.mockClear(); await bridge.start();
    await bridge.handleInbound(message(`/answer ${q.reference} 2`)); expect(answer).toHaveBeenCalledTimes(1);
  });

  it('serializes duplicate replies and never auto-fills an interpreter failure', async () => {
    await bridge.start();
    await Promise.all([bridge.handleInbound(message(`/answer ${q.reference} 1`)), bridge.handleInbound(message(`/answer ${q.reference} 2`))]);
    expect(answer).toHaveBeenCalledTimes(1);
    await bridge.stop(); await bridge.start(); answer.mockClear(); interpret.mockResolvedValue(null);
    await bridge.handleInbound(message(`/answer ${q.reference} vague`)); expect(answer).not.toHaveBeenCalled();
  });
});
