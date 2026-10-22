import type { CLIQuestionRequest, CLIQuestions, IMAdapter, IMReplyContext, IncomingMessage, TermPaneInfo, TerminalId } from '@multi-cc-im/shared';
import { readIMOriginFile, readIMWorkFile } from '@multi-cc-im/cli-cc';
import type { AIAskUserQuestionResult, AskUserQuestionViaAIOpts } from './ai-router.js';

/** Dependencies for correlated native question forwarding, separate from hook approvals. */
export interface NativeQuestionBridgeOpts {
  stateDir: string;
  terminalId: TerminalId;
  questions?: CLIQuestions;
  imAdapter: IMAdapter;
  listPanes(): Promise<readonly TermPaneInfo[]>;
  interpret?: (opts: AskUserQuestionViaAIOpts) => Promise<AIAskUserQuestionResult | null>;
  onError(err: unknown): void;
}

/** Lifecycle and inbound interception used by the orchestrator. */
export interface NativeQuestionBridge {
  /** Begin delivery after the IM adapter has connected. */
  start(): Promise<void>;
  /** Stop delivery, clearing only this bridge's question UI state. */
  stop(): Promise<void>;
  /** Reconcile current native requests, including pending replay after restart. */
  flush(): Promise<void>;
  /** Consume only explicitly correlated answers; stale references never become chat prompts. */
  handleInbound(msg: IncomingMessage): Promise<boolean>;
  /** Remove answerability and report native completion/disconnection to the original owner. */
  onQuestionClosed(reference: string, reason: 'resolved' | 'disconnected' | 'replaced'): Promise<void>;
}

interface DisplayedQuestion {
  request: CLIQuestionRequest;
  owner: IMReplyContext;
  tabName: string;
  state: 'pending' | 'submitted' | 'resolved' | 'disconnected' | 'replaced' | 'terminalOnly';
  busy: boolean;
  delivery?: Promise<void>;
}
function ownerKey(ctx: IMReplyContext): string {
  return JSON.stringify(ctx.imType === 'lark' ? [ctx.imType, ctx.openId, ctx.chatId] : [ctx.imType, ctx.chatId]);
}
function validOrigin(ctx: IMReplyContext | null, adapterName: string): ctx is IMReplyContext {
  return ctx !== null && ctx.imType === adapterName && (ctx.imType === 'lark' ? !!ctx.openId && !!ctx.chatId : Number.isFinite(ctx.chatId));
}

function extractAnswers(
  request: CLIQuestionRequest, body: string, result?: AIAskUserQuestionResult | null,
): Record<string, readonly string[]> | null {
  const qs = request.questions;
  if (qs.length === 1) {
    const q = qs[0]!;
    if (/^\/?\d+$/.test(body) && q.options?.length) {
      const option = q.options[Number(body.replace(/^\//, '')) - 1];
      return option ? { [q.id]: [option.label] } : null;
    }
    const exact = q.options?.find(o => o.label === body);
    if (exact) return { [q.id]: [exact.label] };
    if (!q.options?.length) return { [q.id]: [body] };
  }
  if (!result || result.answers.length !== qs.length) return null;
  const answers = new Map<string, readonly string[]>();
  for (const a of result.answers) {
    const q = qs[a.questionIndex];
    if (!Number.isInteger(a.questionIndex) || !q || answers.has(q.id)) return null;
    if (a.kind === 'option') {
      if (typeof a.optionIndex !== 'number' || !Number.isInteger(a.optionIndex)) return null;
      const option = q.options?.[a.optionIndex - 1];
      if (!option) return null;
      answers.set(q.id, [option.label]);
    } else {
      if (!a.text.trim()) return null;
      answers.set(q.id, [a.text]);
    }
  }
  return Object.fromEntries(answers);
}

/**
 * Forward native questions to the existing owner IM channel and return user answers.
 * Explicit references (or bot-message replies containing one) prevent delayed
 * answers from entering ordinary terminal prompt routing.
 * @param opts Native capability, IM, state gates and selected answer interpreter.
 * @returns Lifecycle plus inbound interception; does not own terminal input.
 */
export function createNativeQuestionBridge(opts: NativeQuestionBridgeOpts): NativeQuestionBridge {
  const displayed = new Map<string, DisplayedQuestion>();
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> | undefined;

  async function gates(): Promise<{ owner: IMReplyContext; panes: readonly TermPaneInfo[] } | null> {
    if (!active || !opts.questions) return null;
    const [work, owner, panes] = await Promise.all([readIMWorkFile(opts.stateDir, opts.terminalId), readIMOriginFile(opts.stateDir), opts.listPanes()]);
    return work && validOrigin(owner, opts.imAdapter.name) ? { owner, panes } : null;
  }
  function current(ref: string): CLIQuestionRequest | undefined {
    return opts.questions?.listPending().find(q => q.reference === ref && q.termId === opts.terminalId);
  }
  async function doFlush(): Promise<void> {
    const allowed = await gates();
    if (!allowed || !active) return;
    for (const request of opts.questions?.listPending() ?? []) {
      if (request.termId !== opts.terminalId) continue;
      const terminalOnly = request.questions.some(q => q.isSecret);
      const pane = allowed.panes.find(p => p.paneId === request.paneId);
      if (!pane || !current(request.reference)) continue;
      for (const [ref, old] of displayed) {
        if (old.state === 'disconnected' && old.request.paneId === request.paneId && ref !== request.reference) displayed.delete(ref);
      }
      const previous = displayed.get(request.reference);
      if (previous) {
        if (previous.state === 'disconnected' && ownerKey(previous.owner) === ownerKey(allowed.owner)) {
          previous.request = request; previous.state = terminalOnly ? 'terminalOnly' : 'pending';
          await opts.imAdapter.send(terminalOnly ? 'Codex 已重新连接，敏感输入仍请在终端回答。' : 'Codex 已重新连接，该问题仍可使用原编号回答。', previous.owner, { sourceTag: previous.tabName });
        }
        continue;
      }
      const entry: DisplayedQuestion = { request, owner: allowed.owner, tabName: pane.title || 'Codex', state: terminalOnly ? 'terminalOnly' : 'pending', busy: false };
      displayed.set(request.reference, entry);
      const body = terminalOnly ? `Codex 正在请求敏感输入，请在对应终端回答。请勿通过 IM 发送敏感内容。\n问题编号：${request.reference}` : [`Codex ${request.isBlocking ? '正在等待回答' : '提出了一个问题（任务可继续运行）'}：`,
        ...request.questions.flatMap((q, i) => [`${i + 1}. ${q.header}: ${q.question}`,
          ...(q.options ?? []).map((o, n) => `   ${n + 1}. ${o.label} — ${o.description}`)]),
        `回复 /answer ${request.reference} <选项编号或文字回答>`,
        '也可直接回复本条消息。多题请逐题说明；仍可在 Codex 终端回答，先到的回答生效。',
      ].join('\n');
      entry.delivery = opts.imAdapter.send(body, entry.owner, { sourceTag: entry.tabName });
      try { await entry.delivery; }
      catch (err) { if (displayed.get(request.reference) === entry) displayed.delete(request.reference); opts.onError(err); }
    }
  }
  function flush(): Promise<void> {
    if (!flushing) flushing = doFlush().catch(opts.onError).finally(() => { flushing = undefined; });
    return flushing;
  }
  async function tick(): Promise<void> {
    await flush();
    if (active) { timer = setTimeout(() => { void tick(); }, 2000); timer.unref(); }
  }
  async function eligible(entry: DisplayedQuestion, ctx: IMReplyContext): Promise<boolean> {
    const allowed = await gates();
    return !!allowed && ownerKey(ctx) === ownerKey(entry.owner) && ownerKey(allowed.owner) === ownerKey(entry.owner) &&
      allowed.panes.some(p => p.paneId === entry.request.paneId) && !!current(entry.request.reference);
  }

  return {
    async start() { if (active || !opts.questions) return; active = true; await tick(); },
    async stop() { active = false; clearTimeout(timer); await flushing; displayed.clear(); },
    flush,
    async onQuestionClosed(reference, reason) {
      const entry = displayed.get(reference);
      if (!entry) return;
      entry.state = reason;
      try {
        await entry.delivery;
        const allowed = await gates();
        if (!allowed || ownerKey(allowed.owner) !== ownerKey(entry.owner)) return;
        const text = reason === 'disconnected' ? 'Codex 本机连接已断开，手机回答暂停。可在终端继续；重连核对问题后恢复。' :
          reason === 'replaced' ? 'Codex 会话、终端或线程标题已变化，手机回答已暂停。请在 /terminal-title 保留 thread-id，并确认一个线程只显示在一个窗格中；仍可在终端回答。' :
          '该 Codex 问题已结束（已回答或被取消）。迟到回复不会作为新任务发送。';
        await opts.imAdapter.send(text, entry.owner, { sourceTag: entry.tabName });
      } catch (err) { opts.onError(err); }
      finally { if (reason !== 'disconnected' && displayed.get(reference) === entry) displayed.delete(reference); }
    },
    async handleInbound(msg) {
      const text = msg.text?.trim() ?? '';
      const command = /^(?:#\S+\s+)?(\/answer(?:\s|$)[\s\S]*)$/i.exec(text)?.[1];
      const explicit = command !== undefined;
      const quoted = msg.quotedMessage?.sender.role === 'bot' ? /\b(codex-[a-f0-9]{24})\b/.exec(msg.quotedMessage.content)?.[1] : undefined;
      if (!explicit && (!quoted || text.startsWith('/'))) return false;
      const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/i.exec(command ?? text);
      const reference = explicit ? match?.[1] : quoted;
      const body = (explicit ? match?.[2] : text)?.trim();
      const respond = async (content: string): Promise<void> => { await opts.imAdapter.send(content, msg.replyCtx); };
      if (!reference || !body) { await respond('请使用 /answer <问题编号> <回答>，或直接回复原问题消息。'); return true; }
      await flush();
      const entry = displayed.get(reference);
      if (entry && ownerKey(msg.replyCtx) !== ownerKey(entry.owner)) { await respond('该问题不属于当前用户或聊天。'); return true; }
      if (entry?.state === 'terminalOnly') { await respond('此问题包含敏感输入，请在对应 Codex 终端回答；本条内容未提交给 Codex 或解释模型。'); return true; }
      if (!entry || !current(reference) || entry.state !== 'pending') {
        await respond(entry?.state === 'disconnected' ? '该问题目前不可提交，可能已结束或连接未恢复。请在对应 Codex 终端查看。' : '该问题已结束、已提交或尚未重新登记，请查看当前问题；本条不会作为新任务发送。'); return true;
      }
      if (entry.busy) { await respond('正在处理这道问题的回答，请等待 Codex 确认。'); return true; }
      entry.busy = true;
      try {
        if (!(await eligible(entry, msg.replyCtx))) { await respond('当前 IM 模式、用户、聊天或终端状态不允许回答该问题。请检查 /start 和对应 Codex 终端。'); return true; }
        let answers = extractAnswers(entry.request, body);
        if (!answers && !/^\/?\d+$/.test(body) && opts.interpret) {
          const result = await opts.interpret({ userMsg: body, pendings: [{ tabName: entry.tabName,
            questions: entry.request.questions.map(q => ({ question: q.question, header: q.header, multiSelect: false,
              options: (q.options ?? []).map(o => ({ ...o })) })) }] });
          answers = result?.target === entry.tabName ? extractAnswers(entry.request, body, result) : null;
        }
        if (!answers) { await respond('无法完整确认回答。请按题号说明每题的选项编号或文字回答；问题仍在等待。'); return true; }
        if (!(await eligible(entry, msg.replyCtx)) || entry.state !== 'pending') { await respond('问题或连接状态已改变，本次回答未发送；请查看当前 Codex 问题。'); return true; }
        const result = await opts.questions!.answer(reference, answers);
        if (result === 'submitted') { if (entry.state === 'pending') entry.state = 'submitted'; await respond('回答已发送，等待 Codex 确认；手机与终端先到的回答生效。'); }
        else if (result === 'invalid') await respond('回答与当前问题不匹配，请重新按题号回答。');
        else await respond(result === 'unavailable' ? 'Codex 连接不可用，回答未确认。请在终端查看或等待重连后再试。' : '该问题已结束或已提交，本次回答未再次发送。');
      } catch (err) { opts.onError(err); await respond('回答未能确认送达，问题仍由 Codex 管理。请在终端查看或重试当前问题编号。'); }
      finally { entry.busy = false; }
      return true;
    },
  };
}
