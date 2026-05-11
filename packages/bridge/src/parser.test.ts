import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';

describe('parser — plain / mention / broadcast / bridge_command', () => {
  it('empty string → plain with empty body', () => {
    expect(parse('')).toEqual({ type: 'plain', body: '' });
  });

  it('whitespace-only → plain with empty body (after trim)', () => {
    expect(parse('   ')).toEqual({ type: 'plain', body: '' });
  });

  it('no # at start → plain', () => {
    expect(parse('hello world')).toEqual({ type: 'plain', body: 'hello world' });
  });

  it('#<name> at start → mention', () => {
    expect(parse('#frontend hello')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello',
    });
  });

  it('#<name> only (no body) → mention with empty body', () => {
    expect(parse('#frontend')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '',
    });
  });

  it('#<name> with multiple spaces before body collapses → body trimmed', () => {
    expect(parse('#frontend   hello   world')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello   world',
    });
  });

  it('multi-mention space-separated at start → mention list + body', () => {
    expect(parse('#frontend #api sync implementation')).toEqual({
      type: 'mention',
      mentions: ['frontend', 'api'],
      body: 'sync implementation',
    });
  });

  it('#<id-hash> $-prefix preserved verbatim in mention token', () => {
    expect(parse('#$abc1234 hello')).toEqual({
      type: 'mention',
      mentions: ['$abc1234'],
      body: 'hello',
    });
  });

  it('#=<exact> = prefix preserved verbatim', () => {
    expect(parse('#=frontend hello')).toEqual({
      type: 'mention',
      mentions: ['=frontend'],
      body: 'hello',
    });
  });

  it('#<glob> * preserved verbatim', () => {
    expect(parse('#front* hello')).toEqual({
      type: 'mention',
      mentions: ['front*'],
      body: 'hello',
    });
  });

  it('#all alone → broadcast (no body)', () => {
    expect(parse('#all')).toEqual({ type: 'broadcast', body: '' });
  });

  it('#all + body → broadcast with body', () => {
    expect(parse('#all stop everything')).toEqual({
      type: 'broadcast',
      body: 'stop everything',
    });
  });

  it('#all combined with other # → error (broadcast is exclusive)', () => {
    expect(parse('#all #frontend hello')).toEqual({
      type: 'error',
      message: expect.stringMatching(/#all.*exclusive/i),
    });
  });

  // ==========================================================================
  // Bareword controls (#list / #help / #current) are plain mentions — they
  // would collide with cc tab titles named via /rename. Bridge commands live
  // under the bare-slash namespace (`/list`, `/help`, etc.).
  // ==========================================================================

  it('#list (bareword) → parses as mention', () => {
    expect(parse('#list')).toEqual({
      type: 'mention',
      mentions: ['list'],
      body: '',
    });
  });

  it('#help (bareword) → parses as mention', () => {
    expect(parse('#help')).toEqual({
      type: 'mention',
      mentions: ['help'],
      body: '',
    });
  });

  it('#current (bareword) → parses as mention', () => {
    expect(parse('#current')).toEqual({
      type: 'mention',
      mentions: ['current'],
      body: '',
    });
  });

  // ==========================================================================
  // Bridge commands: bare `/<command> [args]` (per DD #73).
  // ==========================================================================

  it('/list → bridge_command list', () => {
    expect(parse('/list')).toEqual({
      type: 'bridge_command',
      command: 'list',
      args: '',
    });
  });

  it('/help → bridge_command help', () => {
    expect(parse('/help')).toEqual({
      type: 'bridge_command',
      command: 'help',
      args: '',
    });
  });

  it('/current → bridge_command current', () => {
    expect(parse('/current')).toEqual({
      type: 'bridge_command',
      command: 'current',
      args: '',
    });
  });

  it('/start → bridge_command start (no args)', () => {
    expect(parse('/start')).toEqual({
      type: 'bridge_command',
      command: 'start',
      args: '',
    });
  });

  it('/start off → bridge_command start with args=off', () => {
    expect(parse('/start off')).toEqual({
      type: 'bridge_command',
      command: 'start',
      args: 'off',
    });
  });

  it('/stop → bridge_command stop', () => {
    expect(parse('/stop')).toEqual({
      type: 'bridge_command',
      command: 'stop',
      args: '',
    });
  });

  it('/rename auth fix more args → args is everything after first whitespace', () => {
    expect(parse('/rename auth fix more args')).toEqual({
      type: 'bridge_command',
      command: 'rename',
      args: 'auth fix more args',
    });
  });

  it('/ (empty after slash) → error /<command>/', () => {
    expect(parse('/')).toEqual({
      type: 'error',
      message: expect.stringMatching(/expected \/<command>/),
    });
  });

  it('leading whitespace before /list still recognized', () => {
    expect(parse('  /list')).toEqual({
      type: 'bridge_command',
      command: 'list',
      args: '',
    });
  });

  // Per DD 2026-05-12: `@` is no longer a routing prefix. A message starting
  // with `@` (which Feishu rewrites into a mention object anyway, so it never
  // reaches the bridge as literal text) parses as plain — falls through to
  // the AI router path on the production code side.
  it('legacy `@`-prefixed text → plain (no longer a routing token)', () => {
    expect(parse('@frontend hello')).toEqual({
      type: 'plain',
      body: '@frontend hello',
    });
  });

  it('#<name> mid-message → NOT a mention (only start matters)', () => {
    expect(parse('hello #frontend world')).toEqual({
      type: 'plain',
      body: 'hello #frontend world',
    });
  });

  it('## double hash → first # leads, second # is part of name', () => {
    // `##frontend` parses as token `#frontend` (the "name" is `#frontend`),
    // which will fail matching downstream → router returns error.
    expect(parse('##frontend hello')).toEqual({
      type: 'mention',
      mentions: ['#frontend'],
      body: 'hello',
    });
  });

  it('Unicode + emoji friendly_name preserved', () => {
    expect(parse('#前端 写文档 ✨')).toEqual({
      type: 'mention',
      mentions: ['前端'],
      body: '写文档 ✨',
    });
  });

  it('newlines in body preserved', () => {
    expect(parse('#frontend line1\nline2')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'line1\nline2',
    });
  });

  it('leading newlines / tabs trimmed before parsing', () => {
    expect(parse('\n\t#frontend hello')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello',
    });
  });

  it('mention list with #all in middle → error (still exclusive)', () => {
    expect(parse('#a #all #b')).toEqual({
      type: 'error',
      message: expect.stringMatching(/#all.*exclusive/i),
    });
  });

  it('#all with mid-message position → broadcast still triggered (last token decides)', () => {
    // Edge: `#all #all body` — both are #all, treat as broadcast
    expect(parse('#all #all stop')).toEqual({
      type: 'broadcast',
      body: 'stop',
    });
  });
});

describe('parser — permission_response (#<tab> /1 | /2)', () => {
  it('#<name> /1 → permission_response allow', () => {
    expect(parse('#frontend /1')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'allow',
    });
  });

  it('#<name> /2 → permission_response deny', () => {
    expect(parse('#frontend /2')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'deny',
    });
  });

  it('#<name> /1 with surrounding whitespace still parses as permission_response', () => {
    expect(parse('#frontend   /1   ')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'allow',
    });
  });

  it('#<name> /3 → mention (not permission_response — only /1 /2 are reserved)', () => {
    expect(parse('#frontend /3')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '/3',
    });
  });

  it('#<name> /1 with extra body → mention (only exact /1 is reserved)', () => {
    expect(parse('#frontend /1 extra')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '/1 extra',
    });
  });

  it('#all /1 → broadcast (not permission — broadcast wins for #all)', () => {
    expect(parse('#all /1')).toEqual({
      type: 'broadcast',
      body: '/1',
    });
  });

  it('#a #b /1 → mention (multi-mention disqualifies permission shortcut)', () => {
    expect(parse('#a #b /1')).toEqual({
      type: 'mention',
      mentions: ['a', 'b'],
      body: '/1',
    });
  });

  it('bare /1 → bridge_command "1" (parser is layer-pure; router echoes unknown)', () => {
    // `1` is not a defined bridge command, but parser stays at the parse layer.
    // Router's handleBridgeCommand reports the unknown-command error.
    expect(parse('/1')).toEqual({
      type: 'bridge_command',
      command: '1',
      args: '',
    });
  });

  it('#<name> /1 with $-prefix tabname preserved', () => {
    expect(parse('#$abc12345 /2')).toEqual({
      type: 'permission_response',
      tabName: '$abc12345',
      decision: 'deny',
    });
  });
});
