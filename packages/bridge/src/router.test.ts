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
    const result = await route(incoming('hello'), {
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
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('plain + current unset + multiple alive → error with @list hint', async () => {
    const state = memState(null);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no current.*@list|@<name>/i);
  });

  it('plain + current set but session not alive → unset current + error', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toMatch(/disconnected|cleared/i);
  });

  it('plain + zero alive → error', async () => {
    const state = memState(null);
    const result = await route(incoming('hello'), {
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
    const result = await route(incoming('@frontend hello'), {
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
    const result = await route(incoming('@fr hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('@<ambiguous-prefix> → error with candidate list, no dispatch, no current change', async () => {
    const state = memState(API.sessionId);
    const result = await route(incoming('@fr hello'), {
      registry: fixedRegistry([FRONTEND, FRAME]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/ambiguous|matches multiple|frontend.*frame/i);
  });

  it('@<no-match> → error listing all sessions', async () => {
    const state = memState(API.sessionId);
    const result = await route(incoming('@xyz hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/not found|no match/i);
  });

  it('@<name> with empty body → error (nothing to dispatch)', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend'), {
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
    const result = await route(incoming('@$abc1 hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
  });
});

describe('router — multi @ targets', () => {
  it('@a @b body → dispatches to both, no current change', async () => {
    const state = memState(API.sessionId);
    const result = await route(incoming('@frontend @api sync implementation'), {
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
    const result = await route(incoming('@fr @api hello'), {
      registry: fixedRegistry([FRONTEND, FRAME, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/ambiguous/i);
  });

  it('any one @ unmatched → entire message rejected', async () => {
    const state = memState(API.sessionId);
    const result = await route(incoming('@xyz @api hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(API.sessionId);
    expect(result.echo).toMatch(/not found|no match/i);
  });

  it('@a @b empty body → error', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend @api'), {
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
    const result = await route(incoming('@all stop everything'), {
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
    const result = await route(incoming('@all hello'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no.*active/i);
  });

  it('@all with empty body → error', async () => {
    const state = memState(null);
    const result = await route(incoming('@all'), {
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
    const result = await route(incoming('@multi-cc-im /list'), {
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
    const result = await route(incoming('@multi-cc-im /list'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('no active sessions');
  });

  it('@multi-cc-im /help → echo includes Bridge commands line + /rename tip + sid-prefix info', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /help'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('Bridge commands: @multi-cc-im /list | /help | /current');
    expect(result.echo).toContain('Tip: /rename inside cc TUI');
    expect(result.echo).toContain('$<sid-prefix>');
  });

  it('@multi-cc-im /current with current set + alive → echo "current = <displayName>"', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await route(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('current = frontend');
    // current unchanged
    expect(state.getCurrent()).toBe(FRONTEND.sessionId);
  });

  it('@multi-cc-im /current with none set → "current = none"', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toBe('current = none');
  });

  it('@multi-cc-im /current with stale current → clears + "current = none (previous session disconnected)"', async () => {
    const state = memState(FRONTEND.sessionId);
    const result = await route(incoming('@multi-cc-im /current'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toBe('current = none (previous session disconnected)');
  });

  it('@multi-cc-im /unknown → echo unknown bridge command error', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im /unknown'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/unknown bridge command/i);
    expect(result.echo).toContain('/unknown');
  });

  it('@multi-cc-im (no /command) → parser error surfaced', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/expects a \/<command>/);
  });

  it('@multi-cc-im @api /list (combined with another @) → parser error surfaced', async () => {
    const state = memState(null);
    const result = await route(incoming('@multi-cc-im @api /list'), {
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
    const result = await route(incoming('@all @frontend hi'), {
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
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.echo).toMatch(/→.*frontend/);
  });

  it('@switch → echo confirms switch + current update', async () => {
    const state = memState(API.sessionId);
    const result = await route(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.echo).toMatch(/current = frontend|switched to frontend/);
  });

  it('multi-@ echo lists all targets', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend @api hi'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('api');
  });

  it('@all echo announces broadcast count', async () => {
    const state = memState(null);
    const result = await route(incoming('@all hi'), {
      registry: fixedRegistry([FRONTEND, API, FRAME]),
      state,
    });
    expect(result.echo).toMatch(/3.*session|all 3|broadcast/i);
  });
});
