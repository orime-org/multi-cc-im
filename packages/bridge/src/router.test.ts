import { describe, it, expect } from 'vitest';
import type { IncomingMessage, PaneId } from '@multi-cc-im/shared';
import type { SessionInfo } from './matcher.js';
import { route, type PaneRegistry, type RouterState } from './router.js';

// ============================================================================
// Test helpers
// ============================================================================

function s(tabTitle: string, paneId: number): SessionInfo {
  return {
    paneId: paneId as PaneId,
    tabTitle,
    cwd: '/tmp/proj',
  };
}

function fixedRegistry(sessions: readonly SessionInfo[]): PaneRegistry {
  return {
    listPanes: async () => sessions,
  };
}

function memState(initial: PaneId | null = null): RouterState {
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
    from: 'ou_owner',
    text,
    attachments: [],
    timestamp: Date.now(),
    replyCtx: {
      imType: 'lark',
      openId: 'ou_owner',
      chatId: 'oc_chat_ctx-abc',
    },
  };
}

/**
 * Most existing tests describe the "user is in IM mode" case so default
 * IMWork on. The IMWork-off gate is exercised in its own describe block.
 */
async function routeOn(
  msg: IncomingMessage,
  opts: { registry: PaneRegistry; state: RouterState },
) {
  return route(msg, { ...opts, imWorkOn: true });
}

const FRONTEND = s('frontend', 10);
const API = s('api', 20);
const FRAME = s('frame', 30);

// ============================================================================
// Tests
// ============================================================================

describe('router — plain message + sticky current_pane', () => {
  it('plain + current set → dispatches to current', async () => {
    const state = memState(FRONTEND.paneId);
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

  it('plain + current unset + single named pane → auto-current to it', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(state.getCurrent()).toBe(FRONTEND.paneId);
  });

  it('plain + current unset + multiple named → error with hint', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no current|@<name>|\/list/i);
  });

  it('plain + current set but pane no longer present → unset + error', async () => {
    const state = memState(FRONTEND.paneId);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toMatch(/disconnected|cleared/i);
  });

  it('plain + zero panes → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no addressable cc/i);
  });

  it('plain + only un-renamed panes → error', async () => {
    const state = memState(null);
    const noName = s('', 99);
    const result = await routeOn(incoming('hello'), {
      registry: fixedRegistry([noName]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no addressable cc/i);
  });
});

describe('router — @<name> mention', () => {
  it('@frontend hello → unique match + dispatches + sets current', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([
      { session: FRONTEND, content: 'hello' },
    ]);
    expect(state.getCurrent()).toBe(FRONTEND.paneId);
    expect(result.echo).toContain('frontend');
  });

  it('@front matches "frontend" by prefix', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@front hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
  });

  it('@front ambiguous (frontend + frame) → error lists candidates', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@fr hello'), {
      registry: fixedRegistry([FRONTEND, FRAME]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('ambiguous');
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('frame');
  });

  it('@nonexistent → error lists alive named sessions', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@nope hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/not found.*alive/i);
    expect(result.echo).toContain('frontend');
  });

  it('@nonexistent + zero named panes → "no /rename\'d" hint', async () => {
    const state = memState(null);
    const noName = s('', 5);
    const result = await routeOn(incoming('@nope hello'), {
      registry: fixedRegistry([noName]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no \/rename'd/i);
  });

  it('@frontend (empty body, single resolve) → sets current with note', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBe(FRONTEND.paneId);
    expect(result.echo).toContain('current');
    expect(result.echo).toContain('frontend');
  });

  it('@frontend @api hello → multi-target dispatch, current NOT updated', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend @api hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toHaveLength(2);
    expect(result.dispatches.map((d) => d.session)).toEqual([FRONTEND, API]);
    expect(result.dispatches.every((d) => d.content === 'hello')).toBe(true);
    expect(state.getCurrent()).toBeNull();
  });

  it('@frontend @api (empty body, multi resolve) → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend @api'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/empty body/i);
  });
});

describe('router — @all broadcast', () => {
  it('@all hello → fan out to every named pane', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all hello'), {
      registry: fixedRegistry([FRONTEND, API, FRAME]),
      state,
    });
    expect(result.dispatches).toHaveLength(3);
    expect(result.dispatches.map((d) => d.session.tabTitle).sort()).toEqual([
      'api',
      'frame',
      'frontend',
    ]);
    expect(result.dispatches.every((d) => d.content === 'hello')).toBe(true);
    expect(result.echo).toContain('broadcast');
    // Broadcast does NOT set current.
    expect(state.getCurrent()).toBeNull();
  });

  it('@all hello + un-renamed pane present → un-renamed excluded', async () => {
    const state = memState(null);
    const noName = s('', 99);
    const result = await routeOn(incoming('@all hello'), {
      registry: fixedRegistry([FRONTEND, noName]),
      state,
    });
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
  });

  it('@all (empty body) → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/empty body/i);
  });

  it('@all + zero named panes → error', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@all hello'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/no \/rename'd/i);
  });
});

describe('router — bridge commands (bare /<command>)', () => {
  it('/list → echoes pane inventory', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/list'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('api');
  });

  it('/list → header is "wezterm tabs" not "可用 cc" (DD #61: lists all panes regardless of cc presence)', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/list'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.echo).toContain('wezterm tabs');
    expect(result.echo).not.toContain('可用 cc sessions');
  });

  it('/list → /rename\'d pane renders [可寻址 @<name>] status; un-renamed renders /rename hint', async () => {
    const state = memState(null);
    const unnamed = s('', 99);
    const result = await routeOn(incoming('/list'), {
      registry: fixedRegistry([FRONTEND, unnamed]),
      state,
    });
    expect(result.echo).toContain('[可寻址 @frontend]');
    expect(result.echo).toContain('[未 /rename');
  });

  it('/list with empty registry → empty-state hint', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/list'), {
      registry: fixedRegistry([]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/无|wezterm tab/);
  });

  it('/help → echoes routing guide (mentions key concepts)', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/help'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('@<name>');
    expect(result.echo).toContain('@all');
    expect(result.echo).toContain('/list');
  });

  it('/current with no current → "current = none"', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('current = none');
    expect(result.echo).toContain('IMWork = ON');
  });

  it('/current with set current → "current = frontend"', async () => {
    const state = memState(FRONTEND.paneId);
    const result = await routeOn(incoming('/current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('current = frontend');
  });

  it('/current with stale paneId (pane gone) → unsets + reports', async () => {
    const state = memState(FRONTEND.paneId);
    const result = await routeOn(incoming('/current'), {
      registry: fixedRegistry([API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(state.getCurrent()).toBeNull();
    expect(result.echo).toContain('disconnected');
  });

  it('/start when off → imWorkAction enable {auto:true} + inventory (auto is the new default — DD #64 inverted)', async () => {
    const state = memState(null);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toEqual({ kind: 'enable', auto: true });
    expect(result.echo).toContain('IMWork ON (auto-approve)');
    expect(result.echo).toContain('frontend');
  });

  it('/start off → imWorkAction enable {auto:false} (opt-in to ask mode)', async () => {
    const state = memState(null);
    const result = await route(incoming('/start off'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toEqual({ kind: 'enable', auto: false });
    expect(result.echo).toContain('IMWork ON (ask)');
    expect(result.echo).toContain('10 秒内 /1');
  });

  it('/start (default) → echo mentions auto-approve as the active mode', async () => {
    const state = memState(null);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toContain('(auto-approve)');
    expect(result.echo).toContain('auto-approve ON');
    // Tell user how to switch to ask mode.
    expect(result.echo).toContain('/start off');
  });

  it('/start echo footer points users to /help for full command reference', async () => {
    const state = memState(null);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toContain('/help');
  });

  it('/help echo lists concrete usage examples (mention + broadcast + bridge commands)', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/help'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    // Concrete examples (not just placeholder syntax) so users know what
    // to type without guessing.
    expect(result.echo).toContain('@frontend hello');
    expect(result.echo).toContain('@all');
    expect(result.echo).toContain('/clear');
    expect(result.echo).toContain('/1');
    expect(result.echo).toContain('Bridge 命令');
    expect(result.echo).toContain('/rename');
  });

  it('/start when already on → still emits imWorkAction (lets user re-toggle modes)', async () => {
    const state = memState(null);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
    });
    // Always emit — user can switch /start ↔ /start off.
    // Default is now auto:true (DD #64 inverted).
    expect(result.imWorkAction).toEqual({ kind: 'enable', auto: true });
    // Still re-renders inventory + rules (idempotent UX).
    expect(result.echo).toContain('IMWork ON');
    expect(result.echo).toContain('frontend');
  });

  it('/start off when already-on-with-auto → emits + auto:false (mode switch ask)', async () => {
    const state = memState(null);
    const result = await route(incoming('/start off'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      imWorkAuto: true,
    });
    expect(result.imWorkAction).toEqual({ kind: 'enable', auto: false });
    expect(result.echo).toContain('IMWork ON (ask)');
  });

  it('/stop when on → imWorkAction disable', async () => {
    const state = memState(null);
    const result = await route(incoming('/stop'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
    });
    expect(result.imWorkAction).toEqual({ kind: 'disable' });
    expect(result.echo).toContain('IMWork OFF');
  });

  it('/stop when already off → still emits (idempotent — orchestrator delete tolerates ENOENT)', async () => {
    const state = memState(null);
    const result = await route(incoming('/stop'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toEqual({ kind: 'disable' });
    expect(result.echo).toMatch(/already OFF/i);
  });

  it('/current shows IMWork = ON (auto-approve) when imWorkAuto=true', async () => {
    const state = memState(null);
    const result = await route(incoming('/current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      imWorkAuto: true,
    });
    expect(result.echo).toContain('IMWork = ON (auto-approve)');
  });

  it('/current shows IMWork = ON (no auto suffix) when imWorkAuto=false', async () => {
    const state = memState(null);
    const result = await route(incoming('/current'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      imWorkAuto: false,
    });
    expect(result.echo).toContain('IMWork = ON');
    expect(result.echo).not.toContain('auto-approve');
  });

  it('unknown bridge command → error pointing to /help', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('/bogus'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/unknown bridge command/i);
    expect(result.echo).toContain('/help');
  });
});

describe('router — permission_response @<tab> /1 /2', () => {
  it('@frontend /1 → permissionResponse allow + echo + no dispatch', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend /1'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.permissionResponse).toEqual({
      session: FRONTEND,
      decision: 'allow',
    });
    expect(result.echo).toContain('frontend');
  });

  it('@frontend /2 → permissionResponse deny', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@frontend /2'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.permissionResponse).toEqual({
      session: FRONTEND,
      decision: 'deny',
    });
  });

  it('@nonexistent /1 → no permissionResponse, error echo', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@nope /1'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.permissionResponse).toBeUndefined();
    expect(result.echo).toMatch(/not found/i);
  });

  it('@<ambiguous> /1 → no permissionResponse, ambiguity echo', async () => {
    const state = memState(null);
    const result = await routeOn(incoming('@fr /1'), {
      registry: fixedRegistry([FRONTEND, FRAME]),
      state,
    });
    expect(result.permissionResponse).toBeUndefined();
    expect(result.echo).toMatch(/ambiguous/i);
  });
});

describe('router — IMWork off gate', () => {
  it('plain rejected when off', async () => {
    const state = memState(FRONTEND.paneId);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/i);
  });

  it('@<name> mention rejected when off', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/i);
  });

  it('@all broadcast rejected when off', async () => {
    const state = memState(null);
    const result = await route(incoming('@all hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/IMWork off/i);
  });

  it('bridge command /list ALWAYS allowed even when off', async () => {
    const state = memState(null);
    const result = await route(incoming('/list'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.echo).toContain('frontend');
  });

  it('bridge command /start ALWAYS allowed when off (it enables IMWork; default auto:true)', async () => {
    const state = memState(null);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.imWorkAction).toEqual({ kind: 'enable', auto: true });
  });

  it('permission response @<tab> /1 ALWAYS allowed even when off', async () => {
    const state = memState(null);
    const result = await route(incoming('@frontend /1'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
    });
    expect(result.permissionResponse).toBeDefined();
    expect(result.permissionResponse?.decision).toBe('allow');
  });

  it('imWorkOn defaults to false when omitted (plain rejected)', async () => {
    const state = memState(FRONTEND.paneId);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.echo).toMatch(/IMWork off/i);
  });
});

describe('router — empty / null text passthrough', () => {
  it('null text → empty result (image-only message)', async () => {
    const msg: IncomingMessage = {
      msgId: 'm2',
      from: 'ou_owner',
      text: null,
      attachments: [],
      timestamp: Date.now(),
      replyCtx: {
        imType: 'lark',
        openId: 'ou_owner',
        chatId: 'oc_chat',
      },
    };
    const result = await routeOn(msg, {
      registry: fixedRegistry([FRONTEND]),
      state: memState(null),
    });
    expect(result.echo).toBe('');
    expect(result.dispatches).toEqual([]);
  });

  it('whitespace-only text → empty result', async () => {
    const result = await routeOn(incoming('   \t  '), {
      registry: fixedRegistry([FRONTEND]),
      state: memState(null),
    });
    expect(result.echo).toBe('');
    expect(result.dispatches).toEqual([]);
  });
});

describe('router — /start formatNumericTabWarning + formatDuplicateTabWarning', () => {
  it('numeric-only tab title → warning included in /start echo', async () => {
    const numeric = s('123', 5);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND, numeric]),
      state: memState(null),
      imWorkOn: false,
    });
    // The warning header lists the offending titles in quotes.
    expect(result.echo).toContain('"123"');
    expect(result.echo).toMatch(/⚠️ 注意：1 个 cc/);
  });

  it('non-numeric tab titles → no numeric warning header', async () => {
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND, API]),
      state: memState(null),
      imWorkOn: false,
    });
    // The general rules block always mentions "纯数字"; the warning header
    // (⚠️ 注意：N 个 cc 的 tab title 是纯数字) is what's conditional.
    expect(result.echo).not.toMatch(/⚠️ 注意：\d+ 个 cc/);
  });

  it('duplicate tab titles on different panes → conflict warning', async () => {
    const a = s('frontend', 10);
    const b = s('frontend', 11);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([a, b]),
      state: memState(null),
      imWorkOn: false,
    });
    expect(result.echo).toMatch(/同名 cc 冲突/);
    expect(result.echo).toContain('pane 10');
    expect(result.echo).toContain('pane 11');
  });

  it('all-distinct tab titles → no duplicate warning', async () => {
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND, API]),
      state: memState(null),
      imWorkOn: false,
    });
    expect(result.echo).not.toMatch(/同名 cc 冲突/);
  });

  it('un-renamed pane (empty title) does not trigger duplicate warning when only one such pane', async () => {
    const noName = s('', 99);
    const result = await route(incoming('/start'), {
      registry: fixedRegistry([FRONTEND, noName]),
      state: memState(null),
      imWorkOn: false,
    });
    expect(result.echo).not.toMatch(/同名 cc 冲突/);
  });
});

describe('router — AI-routed plain dispatch (DD #73)', () => {
  it('plain msg + aiRouter picks tab → dispatches to that tab + intent as content + sticky current', async () => {
    const state = memState(null);
    const result = await route(incoming('给前端那个写个登录页'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: '写个登录页',
        reason: '前端关键词',
        permissionResponse: null,
      }),
    });
    expect(result.dispatches).toEqual([
      { session: FRONTEND, content: '写个登录页' },
    ]);
    expect(state.getCurrent()).toBe(FRONTEND.paneId);
    expect(result.echo).toContain('frontend');
    expect(result.echo).toContain('写个登录页');
  });

  it('plain msg + aiRouter returns target=null → echo "无法识别" + no dispatch', async () => {
    const state = memState(null);
    const result = await route(incoming('哎呀今天好烦'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: '模糊',
        permissionResponse: null,
      }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/无法识别/);
    expect(result.echo).toContain('@<tab>');
  });

  it('plain msg + aiRouter returns intent=null → echo "无法识别" even if target set', async () => {
    const state = memState(null);
    const result = await route(incoming('something'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: null,
        reason: 'partial',
        permissionResponse: null,
      }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/无法识别/);
  });

  it('plain msg + aiRouter picks unknown tab → echo with "tab 不存在" + no dispatch', async () => {
    const state = memState(null);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'mobile',
        intent: 'hello',
        reason: 'mobile picked',
        permissionResponse: null,
      }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('mobile');
    expect(result.echo).toMatch(/不存在|@<tab>/);
  });

  it('plain msg + aiRouter passes currentTab from sticky state', async () => {
    const state = memState(API.paneId);
    let received: string | null | undefined;
    const result = await route(incoming('继续刚才的'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async (opts) => {
        received = opts.currentTab;
        return { target: 'api', intent: '继续', reason: 'pronoun', permissionResponse: null };
      },
    });
    expect(received).toBe('api');
    expect(result.dispatches[0]?.session).toBe(API);
  });

  it('plain msg + zero named panes → "no addressable cc" (no AI call)', async () => {
    const state = memState(null);
    let aiCalled = false;
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([s('', 99)]),
      state,
      imWorkOn: true,
      aiRouter: async () => {
        aiCalled = true;
        return { target: null, intent: null, reason: '', permissionResponse: null };
      },
    });
    expect(aiCalled).toBe(false);
    expect(result.echo).toMatch(/no addressable cc/i);
  });

  it('plain msg + IMWork off → IMWork-off gate fires before AI router', async () => {
    const state = memState(null);
    let aiCalled = false;
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: false,
      aiRouter: async () => {
        aiCalled = true;
        return { target: 'frontend', intent: 'hello', reason: 'r', permissionResponse: null };
      },
    });
    expect(aiCalled).toBe(false);
    expect(result.echo).toMatch(/IMWork off/i);
  });

  it('@<name> mention bypasses aiRouter entirely', async () => {
    const state = memState(null);
    let aiCalled = false;
    const result = await route(incoming('@frontend hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => {
        aiCalled = true;
        return { target: 'api', intent: 'should-be-ignored', reason: '', permissionResponse: null };
      },
    });
    expect(aiCalled).toBe(false);
    expect(result.dispatches[0]?.session).toBe(FRONTEND);
    expect(result.dispatches[0]?.content).toBe('hello');
  });
});

describe('router — parser error passthrough', () => {
  it('malformed @ token → error echo', async () => {
    // Two-mention with @all in the middle is ambiguous (@all + named) — parser
    // returns error. Tested here to ensure error type passes through router.
    const state = memState(null);
    const result = await routeOn(incoming('@all @frontend hello'), {
      registry: fixedRegistry([FRONTEND]),
      state,
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toMatch(/^❌/);
  });
});

// ============================================================================
// Echo formatting — readable two-line format for AI-routed plain dispatch
// + raw IM excerpt on AI routing failure echo
// ============================================================================

describe('router — AI-routed echo format', () => {
  it('successful AI route renders X format: "target: <tab>" + "content: <intent>"', async () => {
    const state = memState(null);
    const result = await route(incoming('给前端那个写个登录页'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: '写个登录页',
        reason: '前端关键词',
        permissionResponse: null,
      }),
    });
    expect(result.echo).toBe('target: frontend\ncontent: 写个登录页');
  });

  it('successful AI route truncates long intent to 20 chars + ellipsis', async () => {
    const state = memState(null);
    const longIntent = '这是一个超过二十个字符长度的意图描述用来验证截断行为';
    expect(longIntent.length).toBeGreaterThan(20);
    const result = await route(incoming('随便发个长消息'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: longIntent,
        reason: 'r',
        permissionResponse: null,
      }),
    });
    const lines = result.echo.split('\n');
    expect(lines[0]).toBe('target: frontend');
    expect(lines[1]).toBe(`content: ${longIntent.slice(0, 19)}…`);
    expect(lines[1]!.length).toBe('content: '.length + 20);
  });

  it('successful AI route does NOT truncate short intent', async () => {
    const state = memState(null);
    const result = await route(incoming('hi'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: 'hi',
        reason: 'r',
        permissionResponse: null,
      }),
    });
    expect(result.echo).toBe('target: frontend\ncontent: hi');
  });

  it('AI routing failure echo includes raw IM excerpt (≤20 chars passthrough) + tab list', async () => {
    const state = memState(null);
    const result = await route(incoming('哎呀今天好烦'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.echo).toBe(
      '❌ 「哎呀今天好烦」 无法识别目标\n' +
        '   可用：@frontend, @api\n' +
        '   或用 @<tab> 显式指定',
    );
  });

  it('AI routing failure echo truncates long raw IM message to 20 chars + ellipsis', async () => {
    const state = memState(null);
    const longMsg = '这是一条非常非常长的用户消息内容超过了二十个字符的限制需要被截断';
    expect(longMsg.length).toBeGreaterThan(20);
    const result = await route(incoming(longMsg), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.echo).toContain(`❌ 「${longMsg.slice(0, 19)}…」 无法识别目标`);
    expect(result.echo).toContain('可用：@frontend');
    expect(result.echo).toContain('或用 @<tab> 显式指定');
  });

  it('AI routing failure echo lists every named tab in order so user sees full inventory', async () => {
    const state = memState(null);
    const result = await route(incoming('随便发的'), {
      registry: fixedRegistry([FRONTEND, API, FRAME]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    // Tabs preserved in registry order (frontend → api → frame).
    expect(result.echo).toContain('可用：@frontend, @api, @frame');
  });

  it('substring fallback: AI returns null but message contains a tab name verbatim → routes via deterministic match', async () => {
    // Real-account smoke 2026-05-11: user sent "是那个multi-cc-im 已经合并..."
    // and AI bailed because it read "multi-cc-im" as a topic word, not a
    // route cue. The deterministic substring fallback catches this when
    // the tab name actually appears in the message text.
    const state = memState(null);
    const MULTI = s('multi-cc-im', 50);
    const result = await route(incoming('是那个multi-cc-im 已经合并了'), {
      registry: fixedRegistry([FRONTEND, MULTI]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.dispatches).toEqual([
      { session: MULTI, content: '是那个multi-cc-im 已经合并了' },
    ]);
    expect(result.echo).toContain('target: multi-cc-im');
    expect(state.getCurrent()).toBe(MULTI.paneId);
  });

  it('substring fallback: case-insensitive + ignores hyphens / whitespace (matches AI prompt leniency)', async () => {
    const state = memState(null);
    const MULTI = s('multi-cc-im', 50);
    const result = await route(incoming('multi CC IM 已经合并'), {
      registry: fixedRegistry([FRONTEND, MULTI]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.dispatches[0]?.session).toBe(MULTI);
  });

  it('substring fallback: zero matches → standard error echo with tab list (no false dispatch)', async () => {
    const state = memState(null);
    const result = await route(incoming('哎呀今天好烦'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('无法识别目标');
    expect(result.echo).toContain('可用：@frontend, @api');
  });

  it('substring fallback: multiple tabs match → ambiguous, defers to user @<tab> (no guess)', async () => {
    const state = memState(null);
    const result = await route(incoming('frontend 和 api 两边都看看'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('无法识别目标');
  });

  it('substring fallback: skips tab names shorter than 3 chars (defensive — minimizes false positives)', async () => {
    const state = memState(null);
    const SHORT = s('ai', 60);  // 2 chars — would match "the AI is broken" etc.
    const result = await route(incoming('the ai is broken'), {
      registry: fixedRegistry([SHORT]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({ target: null, intent: null, reason: '模糊', permissionResponse: null }),
    });
    expect(result.dispatches).toEqual([]);  // not auto-routed despite "ai" substring
    expect(result.echo).toContain('无法识别目标');
  });

  it('aiTrace: every plain-AI route surfaces target / intent / reason for orchestrator logging', async () => {
    // Per user smoke 2026-05-11 ("需要把 CC 分诊错误打出来"): RouterResult
    // now carries an aiTrace so orchestrator stderr can show the AI's
    // decision for prompt-iteration visibility.
    const state = memState(null);

    // Happy path — AI picks a tab.
    const ok = await route(incoming('hello there'), {
      registry: fixedRegistry([FRONTEND]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'frontend',
        intent: 'hello there',
        reason: 'literal name match',
        permissionResponse: null,
      }),
    });
    expect(ok.aiTrace).toEqual({
      target: 'frontend',
      intent: 'hello there',
      reason: 'literal name match',
      fallback: null,
    });

    // Substring fallback — AI returned null but message contains tab.
    const fb = await route(incoming('frontend 已经合并'), {
      registry: fixedRegistry([FRONTEND]),
      state: memState(null),
      imWorkOn: true,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'I bailed on the topic-mention case',
        permissionResponse: null,
      }),
    });
    expect(fb.aiTrace).toEqual({
      target: null,
      intent: null,
      reason: 'I bailed on the topic-mention case',
      fallback: 'substring',
    });

    // Total failure — no AI pick, no substring match.
    const miss = await route(incoming('哎呀今天好烦'), {
      registry: fixedRegistry([FRONTEND]),
      state: memState(null),
      imWorkOn: true,
      aiRouter: async () => ({
        target: null,
        intent: null,
        reason: 'no signal in message',
        permissionResponse: null,
      }),
    });
    expect(miss.aiTrace).toEqual({
      target: null,
      intent: null,
      reason: 'no signal in message',
      fallback: null,
    });
  });

  it('AI picks unknown tab → echo includes both the picked-but-missing name AND the actual available list', async () => {
    const state = memState(null);
    const result = await route(incoming('hello'), {
      registry: fixedRegistry([FRONTEND, API]),
      state,
      imWorkOn: true,
      aiRouter: async () => ({
        target: 'mobile',
        intent: 'hello',
        reason: 'mobile picked',
        permissionResponse: null,
      }),
    });
    expect(result.dispatches).toEqual([]);
    expect(result.echo).toContain('AI 路由到 `mobile` 但 tab 不存在');
    expect(result.echo).toContain('可用：@frontend, @api');
  });
});
