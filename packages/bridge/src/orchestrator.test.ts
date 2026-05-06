import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CLIAdapter,
  CLIHandler,
  CwdAbs,
  IMAdapter,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
  PaneId,
  PaneToSessionMap,
  SessionId,
  StopPayload,
  TermAdapter,
  TermPaneAlive,
} from '@multi-cc-im/shared';
import { createOrchestrator } from './orchestrator.js';
import type { SessionInfo } from './matcher.js';
import type { RouterState, SessionRegistry } from './router.js';

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa' as SessionId;
const SID_B = '22222222-3606-4fe4-b01d-bbbbbbbbbbbb' as SessionId;

const FRONTEND: SessionInfo = {
  sessionId: SID_A,
  paneId: 10 as PaneId,
  tabTitle: 'frontend',
  cwd: '/tmp/proj-a' as CwdAbs,
};
const API: SessionInfo = {
  sessionId: SID_B,
  paneId: 20 as PaneId,
  tabTitle: 'api',
  cwd: '/tmp/proj-b' as CwdAbs,
};

interface MockIM extends IMAdapter {
  /** Spy on send calls. */
  sent: { content: string; replyCtx: IMReplyContext }[];
  /** Captured handler from start(). */
  handler: IMHandler | undefined;
}

function makeMockIM(): MockIM {
  const sent: { content: string; replyCtx: IMReplyContext }[] = [];
  let handler: IMHandler | undefined;
  return {
    name: 'wechat-mock',
    sent,
    get handler() {
      return handler;
    },
    async start(h) {
      handler = h;
    },
    async send(content, replyCtx) {
      sent.push({ content, replyCtx });
    },
    async stop() {
      handler = undefined;
    },
  };
}

interface MockTerm extends TermAdapter, TermPaneAlive {
  sendTextCalls: { paneId: PaneId; content: string }[];
  sendKeystrokeCalls: { paneId: PaneId; key: string }[];
  isPaneAliveStub: (paneId: PaneId) => Promise<boolean>;
}

function makeMockTerm(opts: {
  alive?: (paneId: PaneId) => Promise<boolean>;
} = {}): MockTerm {
  const sendTextCalls: { paneId: PaneId; content: string }[] = [];
  const sendKeystrokeCalls: { paneId: PaneId; key: string }[] = [];
  const isPaneAliveStub = opts.alive ?? (async () => true);
  return {
    name: 'wezterm-mock',
    sendTextCalls,
    sendKeystrokeCalls,
    isPaneAliveStub,
    async start() {},
    async sendText(paneId, content) {
      sendTextCalls.push({ paneId, content });
    },
    async sendKeystroke(paneId, key) {
      sendKeystrokeCalls.push({ paneId, key });
    },
    async stop() {},
    isPaneAlive: isPaneAliveStub,
  };
}

interface MockCLI extends CLIAdapter {
  handler: CLIHandler | undefined;
}

function makeMockCLI(): MockCLI {
  let handler: CLIHandler | undefined;
  return {
    name: 'cc-mock',
    get handler() {
      return handler;
    },
    async start(h) {
      handler = h;
    },
    async enqueueInjection() {},
    async stop() {
      handler = undefined;
    },
  };
}

function fixedRegistry(sessions: SessionInfo[]): SessionRegistry & PaneToSessionMap {
  const map = new Map<number, SessionId>(
    sessions.map((s) => [s.paneId as unknown as number, s.sessionId]),
  );
  return {
    listAlive: async () => sessions,
    get: (paneId) => map.get(paneId as unknown as number) ?? null,
  };
}

function memState(): RouterState {
  let current: SessionId | null = null;
  return {
    getCurrent: () => current,
    setCurrent: (id) => {
      current = id;
    },
  };
}

function incoming(text: string, replyCtx: IMReplyContext = { to: 'wxid_owner', contextToken: 'ctx' }): IncomingMessage {
  return {
    msgId: 'm1',
    from: 'wxid_owner',
    text,
    attachments: [],
    replyCtx,
    timestamp: Date.now(),
  };
}

describe('createOrchestrator — start/stop lifecycle', () => {
  it('start() subscribes IM + CLI + Term handlers in order', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    expect(im.handler).toBeDefined();
    expect(cli.handler).toBeDefined();
    await orch.stop();
  });

  it('stop() releases handlers', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await orch.stop();
    expect(im.handler).toBeUndefined();
    expect(cli.handler).toBeUndefined();
  });
});

describe('createOrchestrator — inbound (wechat → cc)', () => {
  it('plain msg with single alive session → two-step sendText + sendKeystroke', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendTextCalls).toEqual([
      { paneId: FRONTEND.paneId, content: 'hello' },
    ]);
    expect(term.sendKeystrokeCalls).toEqual([
      { paneId: FRONTEND.paneId, key: '\r' },
    ]);
    expect(im.sent[0]?.content).toMatch(/→.*frontend/);
    await orch.stop();
  });

  it('isPaneAlive returns false → no sendText, error echo to wechat', async () => {
    const im = makeMockIM();
    const term = makeMockTerm({ alive: async () => false });
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendTextCalls).toEqual([]);
    expect(term.sendKeystrokeCalls).toEqual([]);
    expect(im.sent[0]?.content).toMatch(/not alive|disconnected/i);
    await orch.stop();
  });

  it('@<ambiguous> → router error echo only, no dispatch', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const FRAME: SessionInfo = {
      sessionId: '99999999-3606-4fe4-b01d-fffffffffff0' as SessionId,
      paneId: 30 as PaneId,
      tabTitle: 'frame',
      cwd: '/tmp/proj-c' as CwdAbs,
    };
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND, FRAME]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@fr hello'));
    expect(term.sendTextCalls).toEqual([]);
    expect(im.sent[0]?.content).toMatch(/ambiguous/i);
    await orch.stop();
  });

  it('multi-target @a @b → both panes get two-step send', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND, API]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend @api sync implementation'));
    expect(term.sendTextCalls).toHaveLength(2);
    expect(term.sendKeystrokeCalls).toHaveLength(2);
    const panes = term.sendTextCalls.map((c) => c.paneId).sort();
    expect(panes).toEqual([FRONTEND.paneId, API.paneId].sort());
    await orch.stop();
  });

  it('text=null (image-only) → router returns empty, no echo, no dispatch', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    const msg: IncomingMessage = { ...incoming(''), text: null };
    await im.handler!.onMessage(msg);
    expect(term.sendTextCalls).toEqual([]);
    expect(im.sent).toEqual([]);
    await orch.stop();
  });

  it('sendText completes BEFORE sendKeystroke (two-step ordering preserved)', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const orderLog: string[] = [];
    term.sendText = vi.fn(async (paneId, content) => {
      orderLog.push('sendText');
      term.sendTextCalls.push({ paneId, content });
    });
    term.sendKeystroke = vi.fn(async (paneId, key) => {
      orderLog.push('sendKeystroke');
      term.sendKeystrokeCalls.push({ paneId, key });
    });
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(orderLog).toEqual(['sendText', 'sendKeystroke']);
    await orch.stop();
  });
});

describe('createOrchestrator — outbound (cc Stop → wechat)', () => {
  it('cc Stop with stored replyCtx → wechat send last_assistant_message', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    // First, an inbound msg sets the reply ctx for FRONTEND
    await im.handler!.onMessage(
      incoming('hello', { to: 'wxid_owner', contextToken: 'ctx-frontend' }),
    );
    im.sent.length = 0;

    const stopPayload: StopPayload = {
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'done',
    };
    await cli.handler!.onStop(stopPayload);
    expect(im.sent).toHaveLength(1);
    // Outbound forward prefixes with `[<displayName>]\n<reply>` so user can
    // tell which cc is replying when multiple are routed via the same wechat
    // chat.
    expect(im.sent[0]?.content).toBe('[frontend]\ndone');
    expect(im.sent[0]?.replyCtx).toEqual({
      to: 'wxid_owner',
      contextToken: 'ctx-frontend',
    });
    await orch.stop();
  });

  it('cc Stop with no stored replyCtx (session never received wechat msg) → no-op', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await cli.handler!.onStop({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'should not be forwarded',
    });
    expect(im.sent).toEqual([]);
    await orch.stop();
  });

  it('cc Stop with stop_hook_active=true → still forwards (idle wakeup is also a real reply)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: true,
      last_assistant_message: 'awakened',
    });
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[frontend]\nawakened');
    await orch.stop();
  });

  it('multi-target inbound stores replyCtx for ALL dispatched sessions', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND, API]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(
      incoming('@frontend @api hi', { to: 'wxid_owner', contextToken: 'ctx-multi' }),
    );
    im.sent.length = 0;

    // Both sessions should be able to forward replies
    await cli.handler!.onStop({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'frontend reply',
    });
    await cli.handler!.onStop({
      session_id: SID_B,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-b' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'api reply',
    });
    expect(im.sent).toHaveLength(2);
    const replies = im.sent.map((s) => s.content).sort();
    expect(replies).toEqual(['[api]\napi reply', '[frontend]\nfrontend reply']);
    await orch.stop();
  });
});

describe('createOrchestrator — error handling', () => {
  it('term sendText throws → error echoed to wechat, dispatch aborted (no keystroke)', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    term.sendText = vi.fn().mockRejectedValue(new Error('pane-id 99: not found'));
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendKeystrokeCalls).toEqual([]);
    expect(im.sent[0]?.content).toMatch(/not found|error|failed/i);
    await orch.stop();
  });

  it('IM send throws on echo → swallowed via onError callback, does not crash bridge', async () => {
    const im = makeMockIM();
    const errors: unknown[] = [];
    im.send = vi.fn().mockRejectedValue(new Error('iLink session expired'));
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      onError: (err) => errors.push(err),
    });
    await orch.start();
    await expect(
      im.handler!.onMessage(incoming('hello')),
    ).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    await orch.stop();
  });
});

describe('createOrchestrator — INFO log sink', () => {
  it('inbound dispatch emits one [wechat → name] line with truncated body', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello world'));
    const dispatchLine = lines.find((l) => l.startsWith('[wechat →'));
    expect(dispatchLine).toContain('frontend');
    expect(dispatchLine).toContain('hello world');
    await orch.stop();
  });

  it('multi-target dispatch lists all target names', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND, API]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend @api hi'));
    const dispatchLine = lines.find((l) => l.startsWith('[wechat →'));
    expect(dispatchLine).toContain('frontend');
    expect(dispatchLine).toContain('api');
    await orch.stop();
  });

  it('cc Stop with stored replyCtx emits [cc → wechat] line with truncated reply', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    // First inbound to set replyCtx
    await im.handler!.onMessage(incoming('hello'));
    lines.length = 0; // clear inbound logs
    // Then stop
    await cli.handler!.onStop({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'cc replied',
    });
    const stopLine = lines.find((l) => l.startsWith('[cc → wechat]'));
    expect(stopLine).toContain('cc replied');
    // Log line uses the same displayName the IM body is prefixed with —
    // tabTitle when set, `$<sid8>` fallback when unnamed. Here FRONTEND has
    // tabTitle='frontend' so that's what shows up.
    expect(stopLine).toContain('frontend');
    await orch.stop();
  });

  it('cc Stop without stored replyCtx emits skip-forward line', async () => {
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await cli.handler!.onStop({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'lone reply',
    });
    expect(lines.some((l) => l.includes('no wechat origin recorded'))).toBe(true);
    await orch.stop();
  });

  it('SessionStart hook emits [SessionStart sid8] cwd + model', async () => {
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await cli.handler!.onSessionStart({
      session_id: SID_A,
      transcript_path: '/tmp/x.jsonl' as never,
      cwd: '/tmp/proj-a' as never,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-opus-4-7',
    });
    const startLine = lines.find((l) => l.startsWith('[SessionStart'));
    expect(startLine).toContain(SID_A.slice(0, 8));
    expect(startLine).toContain('/tmp/proj-a');
    expect(startLine).toContain('claude-opus-4-7');
    await orch.stop();
  });

  it('long body in inbound is truncated to ~80 chars with ellipsis', async () => {
    const im = makeMockIM();
    const term = makeMockTerm();
    const lines: string[] = [];
    const orch = createOrchestrator({
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      registry: fixedRegistry([FRONTEND]),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    const longText = 'x'.repeat(200);
    await orch.start();
    await im.handler!.onMessage(incoming(longText));
    const line = lines.find((l) => l.startsWith('[wechat →'))!;
    expect(line.length).toBeLessThan(150); // not full 200
    expect(line.endsWith('…')).toBe(true);
    await orch.stop();
  });
});
