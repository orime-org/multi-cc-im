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
  readPermissionDialogResponseFile,
  writePermissionDialogRequestFile,
  permissionDialogRequestPath,
  permissionDialogResponsePath,
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
  PermissionRequestPayload,
  PreToolUsePayload,
  SessionId,
  StopPayload,
  TermAdapter,
  TerminalId,
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
    name: 'lark-mock',
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
    imType: 'lark',
    openId: 'ou_owner',
    chatId: 'oc_chat',
  },
): IncomingMessage {
  return {
    msgId: 'm1',
    from: 'ou_owner',
    text,
    attachments: [],
    replyCtx,
    timestamp: Date.now(),
  };
}

function makeStop(opts: {
  paneId: PaneId;
  sessionId?: SessionId;
  message: string;
  active?: boolean;
}): StopPayload & { paneId: PaneId; termId?: TerminalId } {
  return {
    session_id: opts.sessionId ?? SID_A,
    transcript_path: '/tmp/x.jsonl' as TranscriptPath,
    cwd: '/tmp/proj-a' as CwdAbs,
    hook_event_name: 'Stop',
    permission_mode: 'default',
    stop_hook_active: opts.active ?? false,
    last_assistant_message: opts.message,
    termId: 'wezterm',
    paneId: opts.paneId,
  };
}

function makePreToolUse(opts: {
  paneId: PaneId;
  sessionId?: SessionId;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  requestId: string;
}): PreToolUsePayload & { paneId: PaneId; requestId: string } {
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

function makePermissionDialog(opts: {
  paneId: PaneId;
  sessionId?: SessionId;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  permissionSuggestions?: readonly unknown[];
  requestId: string;
}): PermissionRequestPayload & { paneId: PaneId; requestId: string } {
  return {
    session_id: opts.sessionId ?? SID_A,
    transcript_path: '/tmp/x.jsonl' as TranscriptPath,
    cwd: '/tmp/proj-a' as CwdAbs,
    hook_event_name: 'PermissionRequest',
    tool_name: opts.toolName ?? 'Bash',
    tool_input: opts.toolInput ?? { command: 'mkdir -p .claude/hooks' },
    permission_suggestions: opts.permissionSuggestions ?? [
      { type: 'addRules', behavior: 'allow', destination: 'session' },
    ],
    paneId: opts.paneId,
    requestId: opts.requestId,
  };
}

// ============================================================================
// Global setup: fresh state dir + IMWork on by default.
// ============================================================================

beforeEach(async () => {
  testStateDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  await writeIMWorkFile(testStateDir, 'wezterm');
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    expect(await existsIMWorkFile(testStateDir, 'wezterm')).toBe(true);
    await orch.start();
    await orch.stop();
    expect(await existsIMWorkFile(testStateDir, 'wezterm')).toBe(false);
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await expect(orch.start()).rejects.toThrow(/already started/);
    await orch.stop();
  });
});

// ============================================================================
// Inbound: IM → router → term sendText
// ============================================================================

describe('createOrchestrator — inbound (IM → cc)', () => {
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendTextCalls).toEqual([
      { paneId: FRONTEND_PANE, content: 'hello' },
    ]);
    expect(term.sendKeystrokeCalls).toEqual([
      { paneId: FRONTEND_PANE, key: '\r' },
    ]);
    // Pre-ack 'AI 分诊中' fires first for plain msgs (v1.10); the route
    // echo comes after — find the non-pre-ack message.
    const routeEcho = im.sent.find((s) => !s.content.includes('AI 分诊中'));
    expect(routeEcho?.content).toMatch(/→.*frontend/);
    await orch.stop();
  });

  it('#<ambiguous> mention → router error echo only, no dispatch', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO, FRAME_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#fr hello'));
    expect(term.sendTextCalls).toEqual([]);
    expect(im.sent[0]?.content).toMatch(/ambiguous/i);
    await orch.stop();
  });

  it('multi-target #a #b → both panes get two-step send', async () => {
    const im = makeMockIM();
    const term = makeMockTerm([FRONTEND_INFO, API_INFO]);
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend #api sync now'));
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await im.handler!.onMessage(
      incoming('#frontend first', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_tok-A',
      }),
    );
    expect(await existsIMOriginFile(testStateDir)).toBe(true);

    await im.handler!.onMessage(
      incoming('#frontend second', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_tok-B',
      }),
    );
    const ctx = await readIMOriginFile(testStateDir);
    expect(ctx).toEqual({
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_tok-B',
    });

    await orch.stop();
  });

  it('inbound bridge command (/list) ALSO writes IMOrigin — every inbound covers stale token (DD: IMOrigin global)', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    // First a real dispatch to seed IMOrigin = tok-A.
    await im.handler!.onMessage(
      incoming('#frontend hello', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_tok-A',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('lark');
      if (ctx?.imType === 'lark') expect(ctx.chatId).toBe('oc_chat_tok-A');
    }

    // Then a bridge command — does NOT dispatch, but server still issued
    // a fresh token (tok-B). Pre-fix bug: dispatch-only write left IMOrigin
    // at tok-A (stale). Post-fix: every inbound overwrites.
    await im.handler!.onMessage(
      incoming('/list', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_tok-B',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('lark');
      if (ctx?.imType === 'lark') expect(ctx.chatId).toBe('oc_chat_tok-B');
    }

    // Now a permission response — also a non-dispatch path; same story.
    await im.handler!.onMessage(
      incoming('#frontend /1', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_tok-C',
      }),
    );
    {
      const ctx = await readIMOriginFile(testStateDir);
      expect(ctx?.imType).toBe('lark');
      if (ctx?.imType === 'lark') expect(ctx.chatId).toBe('oc_chat_tok-C');
    }

    await orch.stop();
  });
});

// ============================================================================
// Outbound: cc Stop → IM
// ============================================================================

describe('createOrchestrator — outbound (cc Stop → IM)', () => {
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    // Inbound dispatch sets the IMOrigin for FRONTEND_PANE
    await im.handler!.onMessage(
      incoming('hello', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_ctx-frontend',
      }),
    );
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({ paneId: FRONTEND_PANE, message: 'done' }),
    );

    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[frontend]\ndone');
    expect(im.sent[0]?.replyCtx).toEqual({
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_ctx-frontend',
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({ paneId: FRONTEND_PANE, message: '' }),
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
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
        paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    for (const turn of [1, 2, 3]) {
      await im.handler!.onMessage(
        incoming(`turn ${turn}`, {
          imType: 'lark',
          openId: 'ou_alice',
          chatId: `oc_chat_ctx-${turn}`,
        }),
      );
      im.sent.length = 0;
      await cli.handler!.onStop(
        makeStop({
          paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await im.handler!.onMessage(
      incoming('#frontend #api hi', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_ctx-multi',
      }),
    );
    im.sent.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
        sessionId: SID_A,
        message: 'frontend reply',
      }),
    );
    await cli.handler!.onStop(
      makeStop({
        paneId: API_PANE,
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
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_ctx-99',
    });
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await cli.handler!.onStop(makeStop({ paneId: 99 as PaneId, message: 'lone' }));
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]?.content).toBe('[(pane 99)]\nlone');
    await orch.stop();
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('createOrchestrator — error handling', () => {
  it('term sendText throws → error echoed to IM, dispatch aborted (no keystroke)', async () => {
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      onError: (err) => errors.push(err),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    expect(term.sendKeystrokeCalls).toEqual([]);
    // Pre-ack 'AI 分诊中' fires first (v1.10); the error echo comes after.
    const errEcho = im.sent.find((s) => !s.content.includes('AI 分诊中'));
    expect(errEcho?.content).toMatch(/send failed|not found/i);
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
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
  it('inbound dispatch emits one [IM → name] line', async () => {
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello world'));
    const dispatchLine = lines.find((l) => l.startsWith('[IM →'));
    expect(dispatchLine).toContain('frontend');
    expect(dispatchLine).toContain('hello world');
    await orch.stop();
  });

  it('multi-line echo unfolds in daemon stderr (matches IM-side rendering)', async () => {
    // Per user smoke 2026-05-11: the failure echo with `可用：#tab1, #tab2`
    // was being truncated by `truncate(result.echo, 80)` in the daemon
    // log, making the local terminal view incomplete vs what the IM
    // actually shows. Fix unfolds the echo line by line so daemon stderr
    // mirrors what gets sent to IM. Test exercises this via the
    // handlePlainWithAI failure path which produces a 3-line echo.
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      // Stub aiRouter that always returns null so the plain-with-AI
      // failure echo fires (3-line: error + 可用 + 或用 #<tab>).
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
      log: (l) => lines.push(l),
    });
    await orch.start();

    await im.handler!.onMessage(incoming('哎呀今天好烦'));

    // Header line + each echo line on its own log entry.
    const headerIdx = lines.findIndex((l) =>
      l.startsWith('[IM] router returned echo only:'),
    );
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    // Header line itself does NOT contain the echo body (echo goes to
    // following indented lines, not the header).
    expect(lines[headerIdx]).not.toContain('哎呀');
    // The 3 indented lines after the header carry the echo:
    //   line 0: ❌ 「哎呀今天好烦」 无法识别目标
    //   line 1:    可用：#frontend
    //   line 2:    或用 #<tab> 显式指定
    const indented = lines
      .slice(headerIdx + 1)
      .filter((l) => l.startsWith('  '));
    expect(indented.length).toBeGreaterThanOrEqual(3);
    const joined = indented.join('\n');
    expect(joined).toContain('无法识别目标');
    expect(joined).toContain('可用：#frontend');
    expect(joined).toContain('或用 #<tab> 显式指定');
    await orch.stop();
  });

  it('[AI router] trace line is logged whenever the AI router was consulted (for prompt iteration)', async () => {
    // Per user smoke 2026-05-11 ("需要把 CC 分诊错误打出来"): every plain
    // message that goes through the AI router now logs the model's
    // decision in stderr so the user can iterate on the prompt without
    // rebuilding the daemon.
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: 'frontend',
        intent: 'do x',
        reason: 'literal name match',
        permissionResponse: null,
      }),
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('frontend please do x'));

    const traceLine = lines.find((l) => l.startsWith('[AI router]'));
    expect(traceLine).toBeDefined();
    expect(traceLine).toContain('target=frontend');
    expect(traceLine).toContain('intent="do x"');
    expect(traceLine).toContain('reason="literal name match"');
    await orch.stop();
  });

  it('[AI router] trace line includes fallback=substring when the deterministic match kicked in', async () => {
    const im = makeMockIM();
    const lines: string[] = [];
    const orch = createOrchestrator({
      stateDir: testStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'I bailed on topic mention',
        permissionResponse: null,
      }),
      log: (l) => lines.push(l),
    });
    await orch.start();
    // Message contains tab name → substring fallback should fire.
    await im.handler!.onMessage(incoming('frontend 已经合并了'));

    const traceLine = lines.find((l) => l.startsWith('[AI router]'));
    expect(traceLine).toBeDefined();
    expect(traceLine).toContain('target=none');
    expect(traceLine).toContain('reason="I bailed on topic mention"');
    expect(traceLine).toContain('fallback=substring');
    await orch.stop();
  });

  it('cc Stop emits [cc → IM] line with truncated reply', async () => {
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    lines.length = 0;

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
        message: 'cc replied',
      }),
    );
    const stopLine = lines.find((l) => l.startsWith('[cc → IM]'));
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();
    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('x'.repeat(200)));
    const line = lines.find((l) => l.startsWith('[IM →'))!;
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
    await writeIMWorkFile(permStateDir, 'wezterm');
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    // Bind IMOrigin via inbound dispatch
    await im.handler!.onMessage(incoming('#frontend please run a tool'));
    im.sent.length = 0;

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
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
    expect(body).toContain('#frontend /1');
    expect(body).toContain('#frontend /2');
    expect(body).toMatch(/10/);
    await orch.stop();
  });

  it('onPreToolUse for AskUserQuestion → IM gets numbered-options prompt + "你的考虑" trailing (DD §6 P3 D3)', async () => {
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
      aiRouter: null,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend please ask'));
    im.sent.length = 0;

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              question: 'Pick a database',
              header: 'DB choice',
              multiSelect: false,
              options: [
                { label: 'Postgres', description: 'mature relational' },
                { label: 'MongoDB', description: 'doc store' },
              ],
            },
          ],
        },
        requestId: 'abcd1234',
      }),
    );

    expect(im.sent).toHaveLength(1);
    const body = im.sent[0]!.content;
    // Numbered options:
    expect(body).toMatch(/1\..*Postgres/);
    expect(body).toMatch(/2\..*MongoDB/);
    // Descriptions present (indented under each option):
    expect(body).toContain('mature relational');
    expect(body).toContain('doc store');
    // Trailing "你的考虑" free-text option:
    expect(body).toContain('你的考虑');
    // Question text visible:
    expect(body).toContain('Pick a database');
    // Tab visible:
    expect(body).toContain('frontend');
    // NOT the regular "准备跑工具" format:
    expect(body).not.toContain('准备跑工具');
    // NOT the /1 /2 allow/deny prompt:
    expect(body).not.toMatch(/#frontend\s*\/1\s*=\s*允许/);

    // Audit log for the special path:
    expect(
      lines.some((l) => l.startsWith('[AskUserQuestion forward')),
    ).toBe(true);
    await orch.stop();
  });

  it('AskUserQuestion multi-question (>=2 questions) → only first shown + note about cc TUI for the rest', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend please ask'));
    im.sent.length = 0;

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        toolName: 'AskUserQuestion',
        toolInput: {
          questions: [
            {
              question: 'Q1',
              header: '',
              multiSelect: false,
              options: [{ label: 'A', description: '' }],
            },
            {
              question: 'Q2',
              header: '',
              multiSelect: false,
              options: [{ label: 'B', description: '' }],
            },
          ],
        },
        requestId: 'abcd2222',
      }),
    );

    const body = im.sent[0]!.content;
    // Q1 shown:
    expect(body).toContain('Q1');
    // Note about the rest:
    expect(body).toMatch(/2 个问题|cc TUI/);
    await orch.stop();
  });

  it('AskUserQuestion with malformed toolInput (missing questions array) → defensive echo, no crash', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend please ask'));
    im.sent.length = 0;

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        toolName: 'AskUserQuestion',
        toolInput: { not_questions: 'oops' },
        requestId: 'abcd3333',
      }),
    );

    // Doesn't crash, sends a defensive note pointing user to cc TUI.
    expect(im.sent).toHaveLength(1);
    expect(im.sent[0]!.content).toContain('cc TUI');
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        requestId: 'abc12345',
      }),
    );

    expect(im.sent.length).toBe(0);
    expect(lines.some((l) => l.includes('no IMOrigin'))).toBe(true);
    await orch.stop();
  });

  it('inbound `#frontend /1` → writes PermissionResponse with allow', async () => {
    // requestId must be hex to match parsePermissionFilename regex.
    const requestId = 'aabb9999';
    const reqPath = permissionRequestPath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend /1'));

    const respPath = permissionResponsePath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE,
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

  it('inbound `#frontend /2` → writes PermissionResponse with deny', async () => {
    const requestId = 'ccdd8888';
    const reqPath = permissionRequestPath({
      stateDir: permStateDir,
      paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend /2'));

    const resp = await readPermissionResponseFile(
      permissionResponsePath({
        stateDir: permStateDir,
        paneId: FRONTEND_PANE,
        sessionId: SID_A,
        requestId,
      }),
    );
    expect(resp?.decision).toBe('deny');
    await orch.stop();
  });

  it('inbound `#frontend /1` with no pending Request → IM echoes dead-drop timeout notice', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: permStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend /1'));

    const allSent = im.sent.map((s) => s.content).join('\n');
    // Per DD §9.5 R8: when daemon writes a PermissionResponse but the
    // hook has already exited (timeout), surface the timeout to the
    // user rather than the previous ambiguous "no pending" message.
    expect(allSent).toMatch(/超时|timed? ?out|dead.?drop|不再等待/i);
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

  it('/start when off → writes IMWork + echo includes "ON"', async () => {
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    expect(await existsIMWorkFile(toggleStateDir, 'wezterm')).toBe(false);

    await im.handler!.onMessage(incoming('/start'));

    expect(await existsIMWorkFile(toggleStateDir, 'wezterm')).toBe(true);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toContain('IMWork ON');
    expect(echo).toContain('frontend');
    // Default is now auto-approve (DD #64 inverted) — bullet line tells
    // user how to switch back to ask mode.
    expect(echo).toContain('/start off');
    await orch.stop();
  });

  it('/stop when on → deletes IMWork + echo includes "OFF"', async () => {
    await writeIMWorkFile(toggleStateDir, 'wezterm');
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: toggleStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();
    expect(await existsIMWorkFile(toggleStateDir, 'wezterm')).toBe(true);

    await im.handler!.onMessage(incoming('/stop'));

    expect(await existsIMWorkFile(toggleStateDir, 'wezterm')).toBe(false);
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
    });
    await orch.start();

    await im.handler!.onMessage(incoming('#frontend hello'));

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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      log: (l) => lines.push(l),
    });
    await orch.start();

    await cli.handler!.onStop(
      makeStop({
        paneId: FRONTEND_PANE,
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
    await writeIMWorkFile(reaperStateDir, 'wezterm');
    await writeIMOriginFile(reaperStateDir, {
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_tk',
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
      paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      reaperDelayMs: REAPER_WINDOW_MS,
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
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
      paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      reaperDelayMs: REAPER_WINDOW_MS,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
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

  it('AskUserQuestion uses askUserQuestionReaperDelayMs (NOT regular reaperDelayMs)', async () => {
    // Root-cause fix 2026-05-12: regular 10s reaper unlinked the Request
    // file while the AskUserQuestion hook was still polling (290s hold)
    // → daemon saw empty pending when user IM reply landed → routed as
    // new task instead of force-permission. Per-tool delay split fixes it.
    //
    // Test design: small regularDelay (50ms), large AUQ delay (500ms).
    // After PRE_REAPER_PROBE_MS (10ms) AUQ Request must still exist.
    // After regular reap window (50ms + buffer), AUQ Request STILL exists.
    // After AUQ reap window (500ms+), AUQ Request gone.
    const REGULAR_REAPER_MS = 50;
    const AUQ_REAPER_MS = 500;

    const requestId = 'auqreaper1';
    const reqPath = permissionRequestPath({
      stateDir: reaperStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId,
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'q', options: [] }] },
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
      aiRouter: null,
      reaperDelayMs: REGULAR_REAPER_MS,
      askUserQuestionReaperDelayMs: AUQ_REAPER_MS,
    });
    await orch.start();

    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'q', options: [] }] },
        requestId,
      }),
    );

    // Past the REGULAR reap window: AskUserQuestion Request still here.
    await delay(REGULAR_REAPER_MS + 50);
    expect(existsSync(reqPath)).toBe(true);

    // Past the AUQ reap window: now gone.
    await delay(AUQ_REAPER_MS);
    expect(existsSync(reqPath)).toBe(false);

    await orch.stop();
  });

  it('reaper logs [reaper] unlink line when it fires (diagnostic for future smoke gaps)', async () => {
    const requestId = 'reaperlog1';
    const lines: string[] = [];
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: reaperStateDir,
      imAdapter: makeMockIM(),
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
      reaperDelayMs: REAPER_WINDOW_MS,
      log: (l) => lines.push(l),
    });
    await orch.start();
    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        requestId,
      }),
    );
    await delay(POST_REAPER_PROBE_MS);
    expect(
      lines.some(
        (l) =>
          l.startsWith('[reaper] unlink') &&
          l.includes(`reqId=${requestId}`),
      ),
    ).toBe(true);
    await orch.stop();
  });

  it('orchestrator.stop() clears pending reaper timers', async () => {
    const requestId = 'reaper-test-3';
    const reqPath = permissionRequestPath({
      stateDir: reaperStateDir,
      paneId: FRONTEND_PANE,
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
      aiRouter: null,  // disable AI routing for these tests (default would spawn real cc)
      reaperDelayMs: REAPER_WINDOW_MS,
    });
    await orch.start();
    await cli.handler!.onPreToolUse(
      makePreToolUse({
        paneId: FRONTEND_PANE,
        requestId,
      }),
    );

    await orch.stop();
    await delay(POST_REAPER_PROBE_MS);
    expect(existsSync(reqPath)).toBe(true);
  });
});

// ============================================================================
// AI-routed plain dispatch (DD #73): when aiRouter is wired, plain (no-mention)
// IM messages are triaged via the spawned cc subprocess. Tests pass a
// deterministic stub instead of the real `routeViaAI` so we don't fork a real
// `claude` process during the unit test run.
// ============================================================================

describe('createOrchestrator — AI-routed plain dispatch (DD #73)', () => {
  let aiTestStateDir: string;
  beforeEach(async () => {
    aiTestStateDir = mkdtempSync(join(tmpdir(), 'orch-ai-test-'));
    await writeIMWorkFile(aiTestStateDir, 'wezterm', { auto: true });
  });

  it('plain msg with stub aiRouter → dispatches to picked tab + intent as content', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const term = makeMockTerm([FRONTEND_INFO, API_INFO]);
    const orch = createOrchestrator({
      stateDir: aiTestStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: 'frontend',
        intent: '写个登录页',
        reason: 'r',
        permissionResponse: null,
      }),
    });
    await orch.start();
    await im.handler!.onMessage(
      incoming('给前端那个写个登录页', {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat_ctx-ai-1',
      }),
    );
    expect(term.sendTextCalls).toEqual([
      { paneId: FRONTEND_PANE, content: '写个登录页' },
    ]);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toContain('frontend');
    expect(echo).toContain('写个登录页');
    await orch.stop();
  });

  it('plain msg with aiRouter returning target=null → echo "无法识别" + no dispatch', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const term = makeMockTerm([FRONTEND_INFO, API_INFO]);
    const orch = createOrchestrator({
      stateDir: aiTestStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('哎呀今天好烦'));
    expect(term.sendTextCalls).toEqual([]);
    const echo = im.sent.map((s) => s.content).join('\n');
    expect(echo).toMatch(/无法识别/);
    await orch.stop();
  });

  it('plain msg + aiRouter=null → falls back to legacy sticky logic (no spawn)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const term = makeMockTerm([FRONTEND_INFO]);
    const state = memState();
    state.setCurrent(FRONTEND_PANE);
    const orch = createOrchestrator({
      stateDir: aiTestStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: cli,
      state,
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    // Legacy path: dispatched to current pane verbatim.
    expect(term.sendTextCalls).toEqual([
      { paneId: FRONTEND_PANE, content: 'hello' },
    ]);
    await orch.stop();
  });

  it('aiRouter callback receives currentTab from sticky state', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const term = makeMockTerm([FRONTEND_INFO, API_INFO]);
    const state = memState();
    state.setCurrent(API_PANE);
    let received: string | null | undefined;
    const orch = createOrchestrator({
      stateDir: aiTestStateDir,
      imAdapter: im,
      termAdapter: term,
      cliAdapter: cli,
      state,
      sendKeystrokeDelayMs: 0,
      aiRouter: async (opts) => {
        received = opts.currentTab;
        return { target: 'api', intent: '继续', reason: 'pronoun', permissionResponse: null };
      },
    });
    await orch.start();
    await im.handler!.onMessage(incoming('继续刚才的'));
    expect(received).toBe('api');
    expect(term.sendTextCalls[0]?.paneId).toBe(API_PANE);
    await orch.stop();
  });
});

// ============================================================================
// P4 — AI-matched natural-language permission reply dispatch
// (DD 2026-05-11 §9.1 P4)
// ============================================================================

describe('createOrchestrator — AI permission reply dispatch (DD §9.1 P4)', () => {
  let aiPermStateDir: string;
  beforeEach(async () => {
    aiPermStateDir = mkdtempSync(join(tmpdir(), 'orch-ai-perm-'));
    await writeIMWorkFile(aiPermStateDir, 'wezterm', { auto: false });
  });

  // Helper: write a pending PermissionRequest file under the test state
  // dir so listPendingPermissionRequests (wired by the orchestrator) can
  // find it when the inbound IM message arrives.
  async function writePending(opts: {
    paneId: PaneId;
    sessionId: SessionId;
    requestId: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }): Promise<void> {
    const path = permissionRequestPath({
      stateDir: aiPermStateDir,
      paneId: opts.paneId,
      sessionId: opts.sessionId,
      requestId: opts.requestId,
    });
    await writeFile(
      path,
      JSON.stringify({
        requestId: opts.requestId,
        toolName: opts.toolName ?? 'Bash',
        toolInput: opts.toolInput ?? { command: 'rm -rf node_modules' },
        createdAt: Date.now(),
      }),
    );
  }

  it('aiRouter sees the pending PermissionRequest (orchestrator wires listPendingPermissionRequests by stateDir)', async () => {
    const requestId = 'aabb1111';
    await writePending({
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });

    const im = makeMockIM();
    let observed:
      | readonly { tabName: string; toolName: string; toolInput: Record<string, unknown> }[]
      | undefined;
    const orch = createOrchestrator({
      stateDir: aiPermStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async (o) => {
        observed = o.pendingRequests as typeof observed;
        return {
          target: null,
          intent: null,
          reason: 'permission reply',
          permissionResponse: {
            target: 'frontend',
            decision: 'allow',
            reason: '用户同意 rm node_modules',
          },
        };
      },
    });
    await orch.start();
    await im.handler!.onMessage(incoming('frontend 那个 rm 同意'));

    expect(observed).toEqual([
      {
        tabName: 'frontend',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf node_modules' },
      },
    ]);
    await orch.stop();
  });

  it('AI permissionResponse allow → writes PermissionResponse file with AI reason verbatim', async () => {
    const requestId = 'ccdd2222';
    await writePending({
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });

    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: aiPermStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'permission reply',
        permissionResponse: {
          target: 'frontend',
          decision: 'allow',
          reason: '用户同意 rm node_modules',
        },
      }),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('frontend 那个 rm 同意'));

    const resp = await readPermissionResponseFile(
      permissionResponsePath({
        stateDir: aiPermStateDir,
        paneId: FRONTEND_PANE,
        sessionId: SID_A,
        requestId,
      }),
    );
    expect(resp).toEqual({
      requestId,
      decision: 'allow',
      reason: '用户同意 rm node_modules',
    });
    await orch.stop();
  });

  it('AI permissionResponse deny → writes PermissionResponse file with deny + reason', async () => {
    const requestId = 'eeff3333';
    await writePending({
      paneId: API_PANE,
      sessionId: SID_B,
      requestId,
      toolName: 'Edit',
      toolInput: { file_path: '/etc/hosts' },
    });

    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: aiPermStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([API_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'permission reply',
        permissionResponse: {
          target: 'api',
          decision: 'deny',
          reason: '用户拒绝改 /etc/hosts',
        },
      }),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('api 拒绝改 hosts'));

    const resp = await readPermissionResponseFile(
      permissionResponsePath({
        stateDir: aiPermStateDir,
        paneId: API_PANE,
        sessionId: SID_B,
        requestId,
      }),
    );
    expect(resp?.decision).toBe('deny');
    expect(resp?.reason).toBe('用户拒绝改 /etc/hosts');
    await orch.stop();
  });

  it('emits [AI permission] log line on dispatch (D5-5 — always log)', async () => {
    const requestId = '11119999';
    await writePending({
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });

    const lines: string[] = [];
    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: aiPermStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'permission reply',
        permissionResponse: {
          target: 'frontend',
          decision: 'allow',
          reason: '用户同意 rm node_modules',
        },
      }),
      log: (l) => lines.push(l),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('frontend 那个 rm 同意'));

    const aiPermLine = lines.find((l) => l.startsWith('[AI permission]'));
    expect(aiPermLine).toBeDefined();
    expect(aiPermLine).toContain('target=frontend');
    expect(aiPermLine).toContain('decision=allow');
    expect(aiPermLine).toContain('reason="用户同意 rm node_modules"');
    await orch.stop();
  });

  it('rigid-syntax `#frontend /1` path unchanged (no AI reason → default "IM user replied /1")', async () => {
    const requestId = '22228888';
    await writePending({
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });

    const im = makeMockIM();
    const orch = createOrchestrator({
      stateDir: aiPermStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: makeMockCLI(),
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null, // route via parser, not AI
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend /1'));

    const resp = await readPermissionResponseFile(
      permissionResponsePath({
        stateDir: aiPermStateDir,
        paneId: FRONTEND_PANE,
        sessionId: SID_A,
        requestId,
      }),
    );
    expect(resp?.decision).toBe('allow');
    // Default reason is preserved when router didn't provide one.
    expect(resp?.reason).toContain('/1');
    await orch.stop();
  });
});

// ============================================================================
// Pre-ack for AI router (v1.10, 2026-05-12)
// Plain msgs trigger 3-7s AI subprocess; pre-ack tells the user daemon's
// working so they don't think the message dropped.
// ============================================================================

describe('createOrchestrator — AI router pre-ack (v1.10)', () => {
  let preAckStateDir: string;
  beforeEach(async () => {
    preAckStateDir = mkdtempSync(join(tmpdir(), 'orch-preack-'));
    await writeIMWorkFile(preAckStateDir, 'wezterm', { auto: true });
  });

  it('plain msg → IM gets "🔍 AI 分诊中" pre-ack BEFORE the route result', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: preAckStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: 'frontend',
        intent: '写个登录页',
        reason: 'r',
        permissionResponse: null,
      }),
    });
    await orch.start();
    await im.handler!.onMessage(incoming('给前端写个登录页'));

    // First sent message is pre-ack; the next is the route echo.
    expect(im.sent.length).toBeGreaterThanOrEqual(2);
    expect(im.sent[0]!.content).toMatch(/AI 分诊中/);
    expect(im.sent[0]!.content).toContain('给前端写个登录页');
    // Subsequent echoes (target/content) come AFTER pre-ack:
    const restJoined = im.sent
      .slice(1)
      .map((s) => s.content)
      .join('\n');
    expect(restJoined).toContain('frontend');
    await orch.stop();
  });

  it('bridge command (/list) → no pre-ack (fast path)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: preAckStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('/list'));
    const sentJoined = im.sent.map((s) => s.content).join('\n');
    expect(sentJoined).not.toMatch(/AI 分诊中/);
    await orch.stop();
  });

  it('mention (#frontend hi) → no pre-ack (fast path)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: preAckStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('#frontend hi'));
    const sentJoined = im.sent.map((s) => s.content).join('\n');
    expect(sentJoined).not.toMatch(/AI 分诊中/);
    await orch.stop();
  });

  it('IMWork off → no pre-ack (no IM dispatch at all)', async () => {
    // beforeEach put IMWork on (auto). Switch to OFF by deleting the
    // per-terminal file (file existence ⇔ IM mode ON per IMWork+IMOrigin
    // DD; issue-378 split moved the filename to `IM<TermType>`).
    await unlink(join(preAckStateDir, 'IMWezterm')).catch(() => {});
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: preAckStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hello'));
    const sentJoined = im.sent.map((s) => s.content).join('\n');
    expect(sentJoined).not.toMatch(/AI 分诊中/);
    await orch.stop();
  });

  it('pre-ack send failure does NOT break route() — route still runs', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const errSeen: Array<{ phase: string }> = [];
    let sendCallCount = 0;
    im.send = async (content, replyCtx) => {
      sendCallCount++;
      if (sendCallCount === 1) {
        // First call is pre-ack — fail it.
        throw new Error('lark API down');
      }
      im.sent.push({ content, replyCtx });
    };
    const orch = createOrchestrator({
      stateDir: preAckStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([FRONTEND_INFO]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: 'frontend',
        intent: 'hi',
        reason: 'r',
        permissionResponse: null,
      }),
      onError: (_err, ctx) => {
        if (ctx && typeof ctx === 'object' && 'phase' in ctx) {
          errSeen.push({ phase: String((ctx as { phase: unknown }).phase) });
        }
      },
    });
    await orch.start();
    await im.handler!.onMessage(incoming('hi'));
    // Pre-ack failure recorded:
    expect(errSeen.some((e) => e.phase === 'preAck')).toBe(true);
    // Route still ran — sent at least one (real echo, the failed pre-ack
    // never made it into im.sent).
    expect(im.sent.length).toBeGreaterThanOrEqual(1);
    await orch.stop();
  });
});

// ============================================================================
// PermissionRequest hook event (cc sensitive-path dialog forwarder) — P5
// Per DD: PermissionRequest hook IM bridge (2026-05-13)
// ============================================================================

describe('createOrchestrator — handlePermissionDialog (P5)', () => {
  let dialogStateDir: string;

  beforeEach(async () => {
    dialogStateDir = mkdtempSync(join(tmpdir(), 'orch-dialog-'));
    await writeIMWorkFile(dialogStateDir, 'wezterm', { auto: true });
    await writeIMOriginFile(dialogStateDir, {
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat',
    });
  });

  function makeFrontendInfo(): TermPaneInfo {
    return {
      paneId: FRONTEND_PANE,
      title: 'frontend',
      cwd: '/tmp/proj-a' as CwdAbs,
    };
  }

  it('/start auto → silent emit single-yes allow (NO updatedPermissions) + IM audit log', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();

    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        toolName: 'Bash',
        toolInput: { command: 'mkdir -p .claude/hooks' },
        requestId: 'd7e57001',
      }),
    );

    // Response file written: single-yes allow, no updatedPermissions
    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e57001',
    });
    const resp = await readPermissionDialogResponseFile(respPath);
    expect(resp?.decision.behavior).toBe('allow');
    if (resp?.decision.behavior !== 'allow') throw new Error('expected allow');
    expect(resp.decision.updatedPermissions).toBeUndefined();

    // IM audit log notification fired (D5-B)
    const auditMsg = im.sent.find((s) => s.content.includes('daemon auto-allowed'));
    expect(auditMsg).toBeDefined();
    expect(auditMsg!.content).toContain('frontend');
    expect(auditMsg!.content).toContain('mkdir -p .claude/hooks');

    await orch.stop();
  });

  it('/start off → does NOT write Response, does NOT send IM audit (P6+P7 will wire forward)', async () => {
    // Switch IMWork to off mode
    await writeIMWorkFile(dialogStateDir, 'wezterm', { auto: false });

    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();

    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        requestId: 'd7e50ff1',
      }),
    );

    // No Response file (P6+P7 not wired yet)
    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e50ff1',
    });
    expect(existsSync(respPath)).toBe(false);
    // No IM audit log either (audit is auto-mode only per D5-B)
    expect(im.sent.some((s) => s.content.includes('daemon auto-allowed'))).toBe(
      false,
    );

    await orch.stop();
  });

  it('IMWork file absent (race) → silent skip, no Response, no IM send', async () => {
    // Remove IMWezterm (per-terminal IMWork — issue 378 split) to
    // simulate race (hook should have silent-exited but somehow a
    // Request reached daemon).
    await unlink(join(dialogStateDir, 'IMWezterm')).catch(() => {});

    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();

    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        requestId: 'd7e5ace1',
      }),
    );

    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e5ace1',
    });
    expect(existsSync(respPath)).toBe(false);
    expect(im.sent).toHaveLength(0);

    await orch.stop();
  });

  it('auto-mode audit log extracts file_path from tool_input when present (Edit/Write tools)', async () => {
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();

    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        toolName: 'Edit',
        toolInput: {
          file_path: '/Users/me/work/.claude/hooks/auto-format.sh',
          old_string: 'x',
          new_string: 'y',
        },
        requestId: 'd7e5ed01',
      }),
    );

    const auditMsg = im.sent.find((s) => s.content.includes('daemon auto-allowed'));
    expect(auditMsg).toBeDefined();
    expect(auditMsg!.content).toContain('.claude/hooks/auto-format.sh');

    await orch.stop();
  });

  it('schedules permission-dialog reaper with PermissionDialog file paths (NOT regular permission file paths)', async () => {
    const REAPER_WINDOW = 50;
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
      permissionDialogReaperDelayMs: REAPER_WINDOW,
    });
    await orch.start();

    // Manually plant a stale PermissionDialogRequest file to simulate a
    // SIGKILL'd hook orphan.
    const reqPath = permissionDialogRequestPath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e5eee1',
    });
    await writeFile(
      reqPath,
      JSON.stringify({
        requestId: 'd7e5eee1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        permissionSuggestions: [],
        createdAt: 0,
      }),
    );

    // Trigger handler (will write a Response too because auto=true)
    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        requestId: 'd7e5eee1',
      }),
    );

    // Both Request and Response should still exist before reaper fires
    expect(existsSync(reqPath)).toBe(true);
    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e5eee1',
    });
    expect(existsSync(respPath)).toBe(true);

    // Strong wait for the reaper to actually unlink both files. Replaces a
    // fixed `setTimeout(REAPER_WINDOW + 50)` that flaked on Linux CI under
    // load (file system + reaper timer can drift past a 100ms budget). The
    // 2s waitFor cap is just a safety net; on a healthy machine the loop
    // exits in ~70ms (REAPER_WINDOW + one poll tick).
    const waitForGone = async (p: string, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!existsSync(p)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitForGone(reqPath);
    await waitForGone(respPath);

    // Reaper should have unlinked both PermissionDialog files
    expect(existsSync(reqPath)).toBe(false);
    expect(existsSync(respPath)).toBe(false);

    // PermissionDialog reaper must NOT touch regular Permission files
    // (defense against the reaper-kind regression).
    const regularReqPath = permissionRequestPath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e5eee1',
    });
    expect(existsSync(regularReqPath)).toBe(false); // wasn't created, never existed

    await orch.stop();
  });

  // -------------------------------------------------------------------
  // P7 — /start off mode: forward IM with numbered options + dispatch
  // user reply through ai-router + write Response file
  // -------------------------------------------------------------------

  it('/start off → forwards IM with numbered options (single-yes + N suggestions + deny)', async () => {
    await writeIMWorkFile(dialogStateDir, 'wezterm', { auto: false });
    const im = makeMockIM();
    const cli = makeMockCLI();
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: null,
    });
    await orch.start();

    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        toolName: 'Bash',
        toolInput: { command: 'mkdir -p .claude/hooks' },
        permissionSuggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Edit', ruleContent: 'Edit(./.claude/**)' }],
          },
        ],
        requestId: 'd7e50ff2',
      }),
    );

    const forwardMsg = im.sent.find((s) =>
      s.content.includes('cc 想编辑敏感路径'),
    );
    expect(forwardMsg).toBeDefined();
    expect(forwardMsg!.content).toContain('frontend');
    expect(forwardMsg!.content).toContain('mkdir -p .claude/hooks');
    expect(forwardMsg!.content).toContain('1. 同意一次');
    expect(forwardMsg!.content).toContain('2. 始终允许: Edit(./.claude/**)');
    expect(forwardMsg!.content).toContain('3. 拒绝');
    // PreToolUse-style reply hint: rigid syntax + plain message both OK
    expect(forwardMsg!.content).toContain('#frontend /1');
    expect(forwardMsg!.content).toContain('#frontend /2');
    expect(forwardMsg!.content).toMatch(/数字 \/ 自然语言/);

    // No Response written yet — waiting for user reply
    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId: 'd7e50ff2',
    });
    expect(existsSync(respPath)).toBe(false);

    await orch.stop();
  });

  it('/start off → user IM reply triggers ai-router → Response written with appliedSuggestionIndex resolved into PermissionUpdate', async () => {
    await writeIMWorkFile(dialogStateDir, 'wezterm', { auto: false });
    const im = makeMockIM();
    const cli = makeMockCLI();
    const sampleSuggestion = {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [{ toolName: 'Edit', ruleContent: 'Edit(./.claude/**)' }],
    };
    const orch = createOrchestrator({
      stateDir: dialogStateDir,
      imAdapter: im,
      termAdapter: makeMockTerm([makeFrontendInfo()]),
      cliAdapter: cli,
      state: memState(),
      sendKeystrokeDelayMs: 0,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'r',
        permissionResponse: null,
      }),
      aiPermissionRequestRouter: async () => ({
        target: 'frontend',
        reason: 'picked option 1',
        answer: { behavior: 'allow', appliedSuggestionIndex: 1 },
      }),
    });
    await orch.start();

    // Step 1: cc fires PermissionDialog → daemon writes Request file
    // (mirrors what hook-receiver does) + forwards IM.
    const requestId = 'de00003';
    await writePermissionDialogRequestFile({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
      toolName: 'Bash',
      toolInput: { command: 'mkdir -p .claude/hooks' },
      permissionSuggestions: [sampleSuggestion],
      createdAt: Date.now(),
    });
    await cli.handler!.onPermissionDialog!(
      makePermissionDialog({
        paneId: FRONTEND_PANE,
        permissionSuggestions: [sampleSuggestion],
        requestId,
      }),
    );

    // Step 2: user replies in IM
    await im.handler!.onMessage(incoming('选 2'));

    // Step 3: Response file written with the resolved PermissionUpdate
    const respPath = permissionDialogResponsePath({
      stateDir: dialogStateDir,
      paneId: FRONTEND_PANE,
      sessionId: SID_A,
      requestId,
    });
    const resp = await readPermissionDialogResponseFile(respPath);
    expect(resp?.decision.behavior).toBe('allow');
    if (resp?.decision.behavior !== 'allow') throw new Error('expected allow');
    expect(resp.decision.updatedPermissions).toEqual([sampleSuggestion]);

    await orch.stop();
  });

  // dead-drop case (hook already exited when user replies in IM):
  // listPendingPermissionDialogs returns non-empty → router enters
  // PermissionDialog branch → by the time daemon's
  // handlePermissionDialogResponseFromIM does readdir, the Request file
  // is gone (hook exit cleanup) → daemon sends "⏱ cc 已超时" IM notice.
  // The race between hook exit + daemon readdir is real but not
  // deterministically reproducible in unit tests with mocked timers.
  // Covered by real-account smoke (see PR description). Logic verified
  // by inspection: same pattern as v1.9 AUQ dead-drop already shipped.
});
