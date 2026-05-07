import { describe, it, expect } from 'vitest';
import type { CwdAbs, IncomingMessage, PaneId, SessionId } from '@multi-cc-im/shared';
import type { SessionInfo } from './matcher.js';
import { route, type RouterState, type SessionRegistry } from './router.js';

function s(
  shortIdHex: string,
  tabTitle: string | undefined,
  paneId: number,
): SessionInfo {
  const padded = shortIdHex.padEnd(8, '0').slice(0, 8);
  const sessionId = `${padded}-3606-4fe4-b01d-${'0'.repeat(12)}` as SessionId;
  return {
    sessionId,
    paneId: paneId as PaneId,
    tabTitle,
    cwd: '/tmp/proj' as CwdAbs,
  };
}

function fixedRegistry(sessions: SessionInfo[]): SessionRegistry {
  return {
    listAlive: async () => sessions,
  };
}

/**
 * Test helper: run `route()` with IMWork **on** by default. Most existing
 * tests describe "user sent IM message in IM mode" scenarios, which require
 * IMWork on. The new `IMWork off → reject` behavior is tested in its own
 * describe block by passing `route()` directly with `imWorkOn: false`.
 */
async function routeOn(
  msg: ReturnType<typeof incoming>,
  opts: { registry: SessionRegistry; state: RouterState },
) {
  return route(msg, { ...opts, imWorkOn: true });
}

function memState(initial: SessionId | null = null): RouterState {
  let current = initial;
  return {
    getCurrent: () => current,
    setCurrent: (id) => {
      current = id;
    },
  };
}

function incoming(text: string): IncomingMessage {
  return {
    msgId: 'm1',
    from: 'wxid_owner',
    text,
    attachments: [],
    timestamp: Date.now(),
  };
}

const FRONTEND = s('abc11111', 'frontend', 10);
const API = s('def22222', 'api', 20);
const FRAME = s('aaa33333', 'frame', 30);

describe('router — plain message + current_session', () => {
  it('plain + current set → dispatches to current', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]).toEqual({
      session: FRONTEND,
      content: 'hello',
    });
    expect(result.echo).toContain('frontend');
  });

  it('plain + current unset + single alive session → auto-current to that one', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('plain + current unset + multiple alive → error with @list hint', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no current.*@list|@<name>/i);
  });

  it('plain + current set but session not alive → unset current + error', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toMatch(/disconnected|cleared/i);
  });

  it('plain + zero alive → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no.*active session/i);
  });
});

describe('router — @<name> mention (single)', () => {
  it('@<exact> matches → dispatches + sets current', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([
      { session: FRONTEND, content: 'hello' },
    ]);
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
    expect(result.echo).toMatch(/→ frontend|current = frontend/);
  });

  it('@<unique-prefix> matches → dispatches + sets current', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@fr hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('@<ambiguous-prefix> → error with candidate list, no dispatch, no current change', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@fr hello'), {
      registry: fixedRegistry([FRONTEND, FRAME]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/ambiguous|matches multiple|frontend.*frame/i);
  });

  it('@<no-match> → error listing all sessions', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@xyz hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/not found|no match/i);
  });

  it('@<name> with empty body → error (nothing to dispatch)', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    // current still set so user can follow with body
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
    expect(result.echo).toMatch(/empty body|nothing to send|switched to/i);
  });

  it('@$<id-prefix> matches by session id', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@$abc1 hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
  });
});

describe('router — multi @ targets', () => {
  it('@a @b body → dispatches to both, no current change', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@frontend @api sync implementation'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toHaveLength(2);
    const targets = result.dispatches.map((d) => d.session);
    expect(targets).toContain(FRONTEND);
    expect(targets).toContain(API);
    expect(result.dispatches.every((d) => d.content === 'sync implementation')).toBe(true);
    // Multi-target does NOT change current_session
    expect(state.getCurrent()).toBe(API.sessionId);
  });

  it('any one @ ambiguous → entire message rejected', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@fr @api hello'), {
      registry: fixedRegistry([FRONTEND, FRAME, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/ambiguous/i);
  });

  it('any one @ unmatched → entire message rejected', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@xyz @api hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/not found|no match/i);
  });

  it('@a @b empty body → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend @api'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/empty body|nothing to send/i);
  });
});

describe('router — @all broadcast', () => {
  it('@all body → dispatches to all alive', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('@all stop everything'), {
      registry: fixedRegistry([FRONTEND, API, FRAME]),
      state,
    });
    expect(result.dispatches).toHaveLength(3);
    expect(result.dispatches.every((d) => d.content === 'stop everything')).toBe(
      true,
    );
    // Broadcast does NOT change current_session
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('@all with zero alive → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all hello'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no.*active/i);
  });

  it('@all with empty body → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/empty body|nothing to send/i);
  });
});

describe('router — bridge commands (@multi-cc-im /<cmd>)', () => {
  it('@multi-cc-im /list with active sessions → numbered list, no dispatches', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('@multi-cc-im /list'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('1. frontend');
    expect(result.echo).toContain('2. api');
    expect(result.echo).toContain('pane 10');
    expect(result.echo).toContain('pane 20');
  });

  it('@multi-cc-im /list with zero sessions → "no active sessions"', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im /list'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('no active sessions');
  });

  it('@multi-cc-im /help → echo includes Bridge commands + /start /stop + permission gate hint', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im /help'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('/list | /help | /current | /start | /stop');
    expect(result.echo).toContain('Permission: @<tab> /1');
    expect(result.echo).toContain('Tip: /rename inside cc TUI');
    expect(result.echo).toContain('$<sid-prefix>');
  });

  it('@multi-cc-im /current with current set + alive → echo "current = <displayName>" + IMWork status', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('current = frontend\nIMWork = ON');
    // current unchanged
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('@multi-cc-im /current with none set → "current = none" + IMWork status', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('current = none\nIMWork = ON');
  });

  it('@multi-cc-im /current with stale current → clears + "current = none (previous session disconnected)" + IMWork status', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toBe(
      'current = none (previous session disconnected)\nIMWork = ON',
    );
  });

  it('@multi-cc-im /current shows IMWork = OFF when imWorkOn=false', async () => {
    // Bridge commands always pass through the IMWork gate; /current shows
    // current+IMWork status independently.
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toBe('current = none\nIMWork = OFF');
  });

  it('@multi-cc-im /unknown → echo unknown bridge command error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im /unknown'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/unknown bridge command/i);
    expect(result.echo).toContain('/unknown');
  });

  it('@multi-cc-im (no /command) → parser error surfaced', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/expects a \/<command>/);
  });

  it('@multi-cc-im @api /list (combined with another @) → parser error surfaced', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@multi-cc-im @api /list'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/exclusive — cannot combine/);
  });
});

describe('router — error & malformed input', () => {
  it('@all @frontend mixed → parser error surfaced', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all @frontend hi'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/@all.*exclusive/i);
  });

  it('null text (image-only message) → error gracefully', async () => {
    const state = memState(null);
    const msg: IncomingMessage = { ...incoming(''), text: null };
    const result = await route(msg, {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
  });
});

describe('router — visible echo format', () => {
  it('plain + current → echo includes current target name', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.echo).toMatch(/→.*frontend/);
  });

  it('@switch → echo confirms switch + current update', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.echo).toMatch(/current = frontend|switched to frontend/);
  });

  it('multi-@ echo lists all targets', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend @api hi'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('api');
  });

  it('@all echo announces broadcast count', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all hi'), {
      registry: fixedRegistry([FRONTEND, API, FRAME]),
      state,
    });
    expect(result.echo).toMatch(/3.*session|all 3|broadcast/i);
  });
});

describe('router — permission_response (@<tab> /1 | /2)', () => {
  it('@<exact> /1 → permissionResponse allow + echo, no dispatch, no current change', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend /1'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.permissionResponse).toEqual({
      session: FRONTEND,
      decision: 'allow',
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('frontend');
    expect(result.echo).toMatch(/允许|allow/i);
    // Permission flow does NOT touch current_session.
    expect(state.getCurrent()).toBeNull();
  });

  it('@<exact> /2 → permissionResponse deny + echo', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@api /2'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.permissionResponse).toEqual({
      session: API,
      decision: 'deny',
    });
    expect(result.echo).toContain('api');
    expect(result.echo).toMatch(/拒绝|deny/i);
  });

  it('@<unique-prefix> /1 → matches via 4-level fallback', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@front /1'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.permissionResponse?.decision).toBe('allow');
    expect(result.permissionResponse?.session.sessionId).toBe(FRONTEND.sessionId);
  });

  it('@<ambiguous-prefix> /1 → echo error, no permissionResponse', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@fr /1'), {
      registry: fixedRegistry([FRONTEND, FRAME]),
      state,
    });
    expect(result.permissionResponse).toBeUndefined();
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/ambiguous/i);
  });

  it('@<no-match> /1 → echo not-found, no permissionResponse', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@nothere /1'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.permissionResponse).toBeUndefined();
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/not found/i);
  });

  it('current_session is preserved after permission_response (sticky)', async () => {
    const state = memState(API.sessionId);
    const result = await routeOn(incoming('@frontend /1'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.permissionResponse?.decision).toBe('allow');
    // Permission shortcut MUST NOT clobber the user's current pointer.
    expect(state.getCurrent()).toBe(API.sessionId);
  });
});

describe('router — IMWork gate (@multi-cc-im /start /stop)', () => {
  it('IMWork off (default): mention → reject + echo "请先发 /start"', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/);
    expect(result.echo).toMatch(/\/start/);
  });

  it('IMWork off: plain → reject', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/);
  });

  it('IMWork off: @all body → reject', async () => {
    const state = memState(null);
    const result = await route(incoming('@all hi'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/);
  });

  it('IMWork off: bridge command /list → still works (always passes IMWork gate)', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /list'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toContain('frontend');
  });

  it('IMWork off: permission response /1 → still works (always passes IMWork gate)', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend /1'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.permissionResponse?.decision).toBe('allow');
  });

  it('/start while IMWork off → echo cc list + rules + imWorkAction = enable', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /start'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toBe('enable');
    expect(result.echo).toContain('✓ IMWork ON');
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('api');
    expect(result.echo).toContain('10 秒内回复');
    expect(result.echo).toContain('只处理从 IM 发出的消息');
  });

  it('/start while IMWork already on → echo "already ON" + cc list, no imWorkAction', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
    });
    expect(result.imWorkAction).toBeUndefined();
    expect(result.echo).toContain('already ON');
    expect(result.echo).toContain('frontend');
  });

  it('/start with zero cc → echo includes "无" hint', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /start'), {
      registry: fixedRegistry([]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toBe('enable');
    expect(result.echo).toContain('当前可用 cc sessions: (无');
  });

  it('/start: cc without /rename shows "未 /rename" hint', async () => {
    const UNNAMED = s('eeee5555', undefined, 40);
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /start'), {
      registry: fixedRegistry([UNNAMED]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toContain('未 /rename');
  });

  it('/stop while IMWork on → echo "OFF" + imWorkAction = disable', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /stop'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
    });
    expect(result.imWorkAction).toBe('disable');
    expect(result.echo).toContain('✓ IMWork OFF');
  });

  it('/stop while IMWork already off → echo "already OFF", no imWorkAction', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /stop'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toBeUndefined();
    expect(result.echo).toContain('already OFF');
  });
});

