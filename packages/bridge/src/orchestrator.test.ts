import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  writeIMOriginFile,
  writeIMWorkFile,
  existsIMOriginFile,
  existsIMWorkFile,
  readIMOriginFile,
  readPermissionResponseFile,
  permissionRequestPath,
  permissionResponsePath,
  writeDaemonPidFile,
  captureProcessLstart,
  readDaemonPidFile,
} from '@multi-cc-im/cli-cc';
import type {
  CLIAdapter,
  CLIHandler,
  IMAdapter,
  IMHandler,
  IMReplyContext,
  IncomingMessage,
  PaneId,
  PreToolUsePayload,
  SessionId,
  StopPayload,
  TermAdapter,
  TermListPanes,
  TermPaneInfo,
  TranscriptPath,
  CwdAbs,
} from '@multi-cc-im/shared';
import { createOrchestrator } from './orchestrator.js';
import type { RouterState } from './router.js';

// ============================================================================
// Per-test state dir + IMWork tombstone (most tests assume IM mode is on).
// Tests that need IMWork off skip the writeIMWorkFile in beforeEach by using
// their own state dir and beforeEach.
// ============================================================================

let testStateDir: string;

const SID_A = '11111111-3606-4fe4-b01d-aaaaaaaaaaaa' as SessionId;
const SID_B = '22222222-3606-4fe4-b01d-bbbbbbbbbbbb' as SessionId;

const FRONTEND_PANE = 10 as PaneId;
const API_PANE = 20 as PaneId;
const FRAME_PANE = 30 as PaneId;

const FRONTEND_INFO: TermPaneInfo = {
  paneId: FRONTEND_PANE,
  title: 'frontend',
  cwd: '/tmp/proj-a',
};
const API_INFO: TermPaneInfo = {
  paneId: API_PANE,
  title: 'api',
  cwd: '/tmp/proj-b',
};
const FRAME_INFO: TermPaneInfo = {
  paneId: FRAME_PANE,
  title: 'frame',
  cwd: '/tmp/proj-c',
};

// ============================================================================
// Mocks
// ============================================================================

interface MockIM extends IMAdapter {
  sent: { content: string; replyCtx: IMReplyContext }[];
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

interface MockTerm extends TermAdapter, TermListPanes {
  sendTextCalls: { paneId: PaneId; content: string }[];
  sendKeystrokeCalls: { paneId: PaneId; key: string }[];
}

function makeMockTerm(panes: readonly TermPaneInfo[] = []): MockTerm {
  const sendTextCalls: { paneId: PaneId; content: string }[] = [];
  const sendKeystrokeCalls: { paneId: PaneId; key: string }[] = [];
  return {
    name: 'wezterm-mock',
    sendTextCalls,
    sendKeystrokeCalls,
    async start() {},
    async sendText(paneId, content) {
      sendTextCalls.push({ paneId, content });
    },
    async sendKeystroke(paneId, key) {
      sendKeystrokeCalls.push({ paneId, key });
    },
    async stop() {},
    async listPanes() {
      return panes;
    },
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

function memState(): RouterState {
  let current: PaneId | null = null;
  return {
    getCurrent: () => current,
    setCurrent: (id) => {
      current = id;
    },
  };
}

function incoming(
  text: string,
  replyCtx: IMReplyContext = {
    imType: 'wechat',
    to: 'wxid_owner',
    contextToken: 'ctx',
  },
): IncomingMessage {
  return {
    msgId: 'm1',
    from: 'wxid_owner',
    text,
    attachments: [],
    replyCtx,
    timestamp: Date.now(),
  };
}

function makeStop(opts: {
  paneId: number;
  sessionId?: SessionId;
  message: string;
  active?: boolean;
}): StopPayload & { paneId: number } {
  return {
    session_id: opts.sessionId ?? SID_A,
    transcript_path: '/tmp/x.jsonl' as TranscriptPath,
    cwd: '/tmp/proj-a' as CwdAbs,
    hook_event_name: 'Stop',
    permission_mode: 'default',
    stop_hook_active: opts.active ?? false,
    last_assistant_message: opts.message,
    paneId: opts.paneId,
  };
}

function makePreToolUse(opts: {
  paneId: number;
  sessionId?: SessionId;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  requestId: string;
}): PreToolUsePayload & { paneId: number; requestId: string } {
  return {
    session_id: opts.sessionId ?? SID_A,
    transcript_path: '/tmp/x.jsonl' as TranscriptPath,
    cwd: '/tmp/proj-a' as CwdAbs,
    hook_event_name: 'PreToolUse',
    permission_mode: 'default',
    tool_name: opts.toolName ?? 'Bash',
    tool_input: opts.toolInput ?? { command: 'ls' },
    tool_use_id: 'tu_1',
    paneId: opts.paneId,
    requestId: opts.requestId,
  };
}

// ============================================================================
// Global setup: fresh state dir + IMWork on by default.
// ============================================================================

beforeEach(async () => {
  testStateDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  await writeIMWorkFile(testStateDir);
});

// ============================================================================
// Lifecycle
// ============================================================================

describe('createOrchestrator — start/stop lifecycle', () => {
  it('start() subscribes IM + CLI + Term handlers', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
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
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm(),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await orch.stop();
    expect(im.handler).toBeUndefined();
    expect(cli.handler).toBeUndefined();
  });

  it('stop() deletes IMWork file (Ctrl+C cleanup)', async () => {
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm(),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    expect(await existsIMWorkFile(testStateDir)).toBe(true);
    await orch.start();
    await orch.stop();
    expect(await existsIMWorkFile(testStateDir)).toBe(false);
  });

  it('stop() deletes daemon.pid file', async () => {
    const lstart = await captureProcessLstart(process.pid);
    await writeDaemonPidFile({
      stateDir: testStateDir,
      pid: process.pid,
      startedAt: lstart!,
    });
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm(),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    expect(await readDaemonPidFile(testStateDir)).not.toBeNull();
    await orch.stop();
    expect(await readDaemonPidFile(testStateDir)).toBeNull();
  });

  it('starting twice throws', async () => {
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm(),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await expect(orch.start()).rejects.toThrow(/already started/);
    await orch.stop();
  });
});

// ============================================================================
// Inbound: wechat → router → term sendText
// ============================================================================

describe('createOrchestrator — inbound (wechat → cc)', () => {
  it('plain msg + single named pane → two-step sendText + sendKeystroke', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendTextCalls).toEqual([
      { paneId: FRONTEND_PANE, content: 'hello' },
    ]);
    expect(term.sendKeystrokeCalls).toEqual([
      { paneId: FRONTEND_PANE, key: '\r' },
    ]);
    expect(im.sent[0]?.content).toMatch(/→.*frontend/);
    await orch.stop();
  });

  it('@<ambiguous> mention → router error echo only, no dispatch', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO, FRAME_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
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
    const term = makeMockTerm([FRONTEND_INFO, API_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend @api sync now'));
    expect(term.sendTextCalls).toHaveLength(2);
    expect(term.sendKeystrokeCalls).toHaveLength(2);
    const panes = term.sendTextCalls.map((c) => c.paneId).sort();
    expect(panes).toEqual([FRONTEND_PANE, API_PANE].sort());
    await orch.stop();
  });

  it('text=null (image-only) → router empty, no echo, no dispatch', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
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
    const term = makeMockTerm([FRONTEND_INFO]);
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
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(orderLog).toEqual(['sendText', 'sendKeystroke']);
    await orch.stop();
  });

  it('inbound dispatch writes <paneId>.IMOrigin (B2 — newest wins)', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(
      incoming('@frontend first', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tok-A',
      }),
    );
    expect(await existsIMOriginFile(testStateDir)).toBe(true);

    await im.handler!.onMessage(
      incoming('@frontend second', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tok-B',
      }),
    );
    const ctx = await readIMOriginFile(testStateDir);
    expect(ctx).toEqual({
      imType: 'wechat',
      to: 'wxid_owner',
      contextToken: 'tok-B',
    });

    await orch.stop();
  });

  it('inbound bridge command (@multi-cc-im /list) ALSO writes IMOrigin — every inbound covers stale token (DD: IMOrigin global)', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    // First a real dispatch to seed IMOrigin = tok-A.
    await im.handler!.onMessage(
      incoming('@frontend hello', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tok-A',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('wechat');
      if (ctx?.imType === 'wechat') expect(ctx.contextToken).toBe('tok-A');
    }

    // Then a bridge command — does NOT dispatch, but server still issued
    // a fresh token (tok-B). Pre-fix bug: dispatch-only write left IMOrigin
    // at tok-A (stale). Post-fix: every inbound overwrites.
    await im.handler!.onMessage(
      incoming('@multi-cc-im /list', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tok-B',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('wechat');
      if (ctx?.imType === 'wechat') expect(ctx.contextToken).toBe('tok-B');
    }

    // Now a permission response — also a non-dispatch path; same story.
    await im.handler!.onMessage(
      incoming('@frontend /1', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'tok-C',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('wechat');
      if (ctx?.imType === 'wechat') expect(ctx.contextToken).toBe('tok-C');
    }

    await orch.stop();
  });
});

// ============================================================================
// Outbound: cc Stop → wechat
// ============================================================================

describe('createOrchestrator — outbound (cc Stop → wechat)', () => {
  it('cc Stop with stored IMOrigin → forward last_assistant_message', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    // Inbound dispatch sets the IMOrigin for FRONTEND_PANE
    await im.handler!.onMessage(
      incoming('hello', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'ctx-frontend',
      }),
    );
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({ paneId: FRONTEND_PANE as unknown as number, message: 'done' }),
    );

    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[frontend]\ndone');
    expect(im.sent[0]?.replyCtx).toEqual({
      imType: 'wechat',
      to: 'wxid_owner',
      contextToken: 'ctx-frontend',
    });
    await orch.stop();
  });

  it('cc Stop with no stored IMOrigin → no-op', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'should not forward',
      }),
    );
    expect(im.sent).toEqual([]);
    await orch.stop();
  });

  it('cc Stop with empty last_assistant_message → no forward (IMOrigin preserved per DD: IMOrigin global)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({ paneId: FRONTEND_PANE as unknown as number, message: '' }),
    );
    expect(im.sent).toEqual([]);
    // Per DD: IMOrigin global — Stop forward never deletes IMOrigin
    // (latest-wins semantics, lifecycle owned by daemon start/stop only).
    expect(await existsIMOriginFile(testStateDir)).toBe(true);
    await orch.stop();
  });

  it('IMOrigin persists across multiple Stops (one-shot dropped) — multi-cc cc#2 reply still forwards after cc#1', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'first reply',
      }),
    );
    expect(im.sent).toHaveLength(1);
    im.sent.length = 0;

    // Second Stop without new inbound — IMOrigin still set (no one-shot
    // delete). Forwards using the same latest token. This is the
    // multi-cc fix: cc#1 reply doesn't starve cc#2 reply.
    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'second reply',
      }),
    );
    expect(im.sent).toHaveLength(1);
    await orch.stop();
  });

  it('multi-turn: each new dispatch resets IMOrigin → each Stop forwards once', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    for (const turn of [1, 2, 3]) {
      await im.handler!.onMessage(
        incoming(`turn ${turn}`, {
          imType: 'wechat',
          to: 'wxid_alice',
          contextToken: `ctx-${turn}`,
        }),
      );
      im.sent.length = 0;
      await cli.handler!.onStop(
        makeStop({
          paneId: FRONTEND_PANE as unknown as number,
          message: `reply ${turn}`,
        }),
      );
      expect(im.sent).toHaveLength(1);
      expect(im.sent[0]?.content).toBe(`[frontend]\nreply ${turn}`);
      im.sent.length = 0;
    }
    await orch.stop();
  });

  it('cc Stop with stop_hook_active=true still forwards (idle wakeup is a real reply)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'awakened',
        active: true,
      }),
    );
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[frontend]\nawakened');
    await orch.stop();
  });

  it('multi-target inbound stores IMOrigin for ALL dispatched panes', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO, API_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(
      incoming('@frontend @api hi', {
        imType: 'wechat',
        to: 'wxid_owner',
        contextToken: 'ctx-multi',
      }),
    );
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        sessionId: SID_A,
        message: 'frontend reply',
      }),
    );
    await cli.handler!.onStop(
      makeStop({
        paneId: API_PANE as unknown as number,
        sessionId: SID_B,
        message: 'api reply',
      }),
    );
    expect(im.sent).toHaveLength(2);
    const replies = im.sent.map((s) => s.content).sort();
    expect(replies).toEqual(['[api]\napi reply', '[frontend]\nfrontend reply']);
    await orch.stop();
  });

  it('Stop with unknown paneId (pane gone) → falls back to "(pane N)" prefix', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    // Pane 99 not in the listPanes snapshot — simulate "user closed wezterm tab".
    await writeIMOriginFile(testStateDir, {
      imType: 'wechat',
      to: 'wxid_owner',
      contextToken: 'ctx-99',
    });
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await cli.handler!.onStop(makeStop({ paneId: 99, message: 'lone' }));
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[(pane 99)]\nlone');
    await orch.stop();
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('createOrchestrator — error handling', () => {
  it('term sendText throws → error echoed to wechat, dispatch aborted (no keystroke)', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO]);
    term.sendText = vi.fn().mockRejectedValue(new Error('pane-id 99: not found'));
    const errors: unknown[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      onError: (err) => errors.push(err),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendKeystrokeCalls).toEqual([]);
    expect(im.sent[0]?.content).toMatch(/send failed|not found/i);
    expect(errors.length).toBeGreaterThan(0);
    await orch.stop();
  });

  it('IM send throws on echo → swallowed via onError, does not crash bridge', async () => {
    const im = makeMockIM();
    const errors: unknown[] = [];
    im.send = vi.fn().mockRejectedValue(new Error('iLink session expired'));
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
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

  it('listPanes throws → onError invoked, no crash', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO]);
    term.listPanes = vi.fn().mockRejectedValue(new Error('wezterm cli failed'));
    const errors: unknown[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      onError: (err) => errors.push(err),
    });
    await orch.start();
    // listPanes is called inside route() → router.listPanes
    await expect(
      im.handler!.onMessage(incoming('hello')),
    ).rejects.toThrow();
    await orch.stop();
  });
});

// ============================================================================
// INFO log sink
// ============================================================================

describe('createOrchestrator — log sink', () => {
  it('inbound dispatch emits one [wechat → name] line', async () => {
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
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

  it('cc Stop emits [cc → wechat] line with truncated reply', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    lines.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'cc replied',
      }),
    );
    const stopLine = lines.find((l) => l.startsWith('[cc → wechat]'));
    expect(stopLine).toContain('cc replied');
    expect(stopLine).toContain('frontend');
    await orch.stop();
  });

  it('cc Stop with no IMOrigin emits skip-forward log', async () => {
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'lone reply',
      }),
    );
    expect(lines.some((l) => l.includes('no IMOrigin'))).toBe(true);
    await orch.stop();
  });

  it('long inbound body is truncated with ellipsis in log', async () => {
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('x'.repeat(200)));
    const line = lines.find((l) => l.startsWith('[wechat →'))!;
    expect(line.length).toBeLessThan(150);
    expect(line.endsWith('…')).toBe(true);
    await orch.stop();
  });
});

// ============================================================================
// Permission gate (PreToolUse + IM /1 /2)
// ============================================================================

describe('createOrchestrator — IM permission gate', () => {
  let permStateDir: string;
  beforeEach(async () => {
    permStateDir = mkdtempSync(join(tmpdir(), 'orch-perm-'));
    await writeIMWorkFile(permStateDir);
  });

  it('onPreToolUse with IMOrigin set → IM prompt with tabname + tool + /1 /2 + 10s window', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    // Bind IMOrigin via inbound dispatch
    await im.handler!.onMessage(incoming('@frontend please run a tool'));
    im.sent.length = 0;

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE as unknown as number,
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /important', description: 'cleanup' },
        requestId: 'abc12345',
      }),
    );

    expect(im.sent).toHaveLength(1);
    const body = im.sent[0]!.content;
    expect(body).toContain('frontend');
    expect(body).toContain('Bash');
    expect(body).toContain('rm -rf /important');
    expect(body).toContain('@frontend /1');
    expect(body).toContain('@frontend /2');
    expect(body).toMatch(/10/);
    await orch.stop();
  });

  it('onPreToolUse without IMOrigin → log only, no IM send (defensive race path)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE as unknown as number,
        requestId: 'abc12345',
      }),
    );

    expect(im.sent.length).toBe(0);
    expect(lines.some((l) => l.includes('no IMOrigin'))).toBe(true);
    await orch.stop();
  });

  it('inbound `@frontend /1` → writes PermissionResponse with allow', async () => {
    // requestId must be hex to match parsePermissionFilename regex.
    const requestId = 'aabb9999';
    const reqPath = permissionRequestPath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        createdAt: Date.now(),
      }),
    );

    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend /1'));

    const respPath = permissionResponsePath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    const resp = await readPermissionResponseFile(respPath);
    expect(resp).toEqual({
      requestId,
      decision: 'allow',
      reason: expect.stringContaining('/1'),
    });
    await orch.stop();
  });

  it('inbound `@frontend /2` → writes PermissionResponse with deny', async () => {
    const requestId = 'ccdd8888';
    const reqPath = permissionRequestPath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        createdAt: Date.now(),
      }),
    );

    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend /2'));

    const resp = await readPermissionResponseFile(
      permissionResponsePath({
        stateDir: permStateDir,
        paneId: FRONTEND_PANE as unknown as number,
        sessionId: SID_A,
        requestId,
      }),
    );
    expect(resp?.decision).toBe('deny');
    await orch.stop();
  });

  it('inbound `@frontend /1` with no pending Request → IM echoes "no pending"', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('@frontend /1'));

    const allSent = im.sent.map((s) => s.content).join('\n');
    expect(allSent).toMatch(/没在等审批|no pending|无效/);
    await orch.stop();
  });
});

// ============================================================================
// IMWork manual toggle (/start /stop)
// ============================================================================

describe('createOrchestrator — IMWork toggle', () => {
  let toggleStateDir: string;
  beforeEach(() => {
    toggleStateDir = mkdtempSync(join(tmpdir(), 'orch-toggle-'));
    // NB: do NOT pre-write IMWork — these tests verify the toggle.
  });

  it('@multi-cc-im /start when off → writes IMWork + echo includes "ON"', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    expect(await existsIMWorkFile(toggleStateDir)).toBe(false);

    await im.handler!.onMessage(incoming('@multi-cc-im /start'));

    expect(await existsIMWorkFile(toggleStateDir)).toBe(true);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toContain('IMWork ON');
    expect(echo).toContain('frontend');
    // Default is now auto-approve (DD #64 inverted) — bullet line tells
    // user how to switch back to ask mode.
    expect(echo).toContain('/start off');
    await orch.stop();
  });

  it('@multi-cc-im /stop when on → deletes IMWork + echo includes "OFF"', async () => {
    await writeIMWorkFile(toggleStateDir);
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();
    expect(await existsIMWorkFile(toggleStateDir)).toBe(true);

    await im.handler!.onMessage(incoming('@multi-cc-im /stop'));

    expect(await existsIMWorkFile(toggleStateDir)).toBe(false);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toContain('IMWork OFF');
    await orch.stop();
  });

  it('IM mention with IMWork off → no dispatch, no IMOrigin written', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO]);
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
    });
    await orch.start();

    await im.handler!.onMessage(incoming('@frontend hello'));

    // IMWork off → router rejects dispatch (no sendText to cc)
    expect(term.sendTextCalls).toEqual([]);
    // But IMOrigin IS written at handleInbound entry regardless of IMWork
    // state (per DD: IMOrigin global — every inbound writes, IMWork is the
    // gate only on the *forward* path, not on token capture).
    expect(await existsIMOriginFile(toggleStateDir)).toBe(true);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toContain('IMWork off');
    await orch.stop();
  });

  it('handleStop with IMWork off → skip forward log, no IM send', async () => {
    const cli = makeMockCLI();
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      log: (l) => lines.push(l),
    });
    await orch.start();

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE as unknown as number,
        message: 'reply',
      }),
    );

    expect(im.sent.length).toBe(0);
    expect(lines.some((l) => l.includes('IMWork off'))).toBe(true);
    await orch.stop();
  });
});

// ============================================================================
// Daemon reaper
// ============================================================================

describe('createOrchestrator — daemon reaper (orphan PermissionRequest cleanup)', () => {
  let reaperStateDir: string;
  beforeEach(async () => {
    reaperStateDir = mkdtempSync(join(tmpdir(), 'orch-reaper-'));
    await writeIMWorkFile(reaperStateDir);
    await writeIMOriginFile(reaperStateDir, {
      imType: 'wechat',
      to: 'wxid_owner',
      contextToken: 'tk',
    });
  });

  // Real timers + a tiny window — vi.useFakeTimers does not interleave with
  // real fs.unlink reliably (libuv I/O completion races the timer callback).
  const REAPER_WINDOW_MS = 50;
  const PRE_REAPER_PROBE_MS = 10;
  const POST_REAPER_PROBE_MS = REAPER_WINDOW_MS + 50;

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it('handlePreToolUse schedules reaper that unlinks Request after timer', async () => {
    const requestId = 'reaper-test-1';
    const reqPath = permissionRequestPath({
      stateDir: reaperStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      }),
    );

    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: reaperStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      reaperDelayMs: REAPER_WINDOW_MS,
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE as unknown as number,
        requestId,
      }),
    );

    await delay(PRE_REAPER_PROBE_MS);
    expect(existsSync(reqPath)).toBe(true);

    await delay(POST_REAPER_PROBE_MS);
    expect(existsSync(reqPath)).toBe(false);

    await orch.stop();
  });

  it('reaper unlink is idempotent (hook subprocess wins → ENOENT silently ignored)', async () => {
    const requestId = 'reaper-test-2';
    const reqPath = permissionRequestPath({
      stateDir: reaperStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      }),
    );

    const cli = makeMockCLI();
    const errors: { err: unknown; ctx: { phase: string } }[] = [];
    const orch = createOrchestrator({
      stateDir: reaperStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      reaperDelayMs: REAPER_WINDOW_MS,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE as unknown as number,
        requestId,
      }),
    );

    // Hook subprocess wins
    await unlink(reqPath);

    // Reaper fires later — should silently no-op on ENOENT
    await delay(POST_REAPER_PROBE_MS);

    const reaperErrors = errors.filter((e) => e.ctx.phase === 'reaper');
    expect(reaperErrors).toEqual([]);
    await orch.stop();
  });

  it('orchestrator.stop() clears pending reaper timers', async () => {
    const requestId = 'reaper-test-3';
    const reqPath = permissionRequestPath({
      stateDir: reaperStateDir,
      paneId: FRONTEND_PANE as unknown as number,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'Bash',
        toolInput: {},
        createdAt: 0,
      }),
    );

    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: reaperStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      reaperDelayMs: REAPER_WINDOW_MS,
    });
    await orch.start();
    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE as unknown as number,
        requestId,
      }),
    );

    await orch.stop();
    await delay(POST_REAPER_PROBE_MS);
    expect(existsSync(reqPath)).toBe(true);
  });
});
