import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';

describe('parser — plain / mention / broadcast / bridge_command', () => {
  it('empty string → plain with empty body', () => {
    expect(parse('')).toEqual({ type: 'plain', body: '' });
  });

  it('whitespace-only → plain with empty body (after trim)', () => {
    expect(parse('   ')).toEqual({ type: 'plain', body: '' });
  });

  it('no @ at start → plain', () => {
    expect(parse('hello world')).toEqual({ type: 'plain', body: 'hello world' });
  });

  it('@<name> at start → mention', () => {
    expect(parse('@frontend hello')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello',
    });
  });

  it('@<name> only (no body) → mention with empty body', () => {
    expect(parse('@frontend')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '',
    });
  });

  it('@<name> with multiple spaces before body collapses → body trimmed', () => {
    expect(parse('@frontend   hello   world')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello   world',
    });
  });

  it('multi-mention space-separated at start → mention list + body', () => {
    expect(parse('@frontend @api sync implementation')).toEqual({
      type: 'mention',
      mentions: ['frontend', 'api'],
      body: 'sync implementation',
    });
  });

  it('@<id-hash> $-prefix preserved verbatim in mention token', () => {
    expect(parse('@$abc1234 hello')).toEqual({
      type: 'mention',
      mentions: ['$abc1234'],
      body: 'hello',
    });
  });

  it('@=<exact> = prefix preserved verbatim', () => {
    expect(parse('@=frontend hello')).toEqual({
      type: 'mention',
      mentions: ['=frontend'],
      body: 'hello',
    });
  });

  it('@<glob> * preserved verbatim', () => {
    expect(parse('@front* hello')).toEqual({
      type: 'mention',
      mentions: ['front*'],
      body: 'hello',
    });
  });

  it('@all alone → broadcast (no body)', () => {
    expect(parse('@all')).toEqual({ type: 'broadcast', body: '' });
  });

  it('@all + body → broadcast with body', () => {
    expect(parse('@all stop everything')).toEqual({
      type: 'broadcast',
      body: 'stop everything',
    });
  });

  it('@all combined with other @ → error (broadcast is exclusive)', () => {
    expect(parse('@all @frontend hello')).toEqual({
      type: 'error',
      message: expect.stringMatching(/@all.*exclusive/i),
    });
  });

  // ==========================================================================
  // Old bareword controls (@list / @help / @current) are now plain mentions.
  // The DD G' control-command syntax was dropped because it collided with cc
  // tab titles set via /rename. Replaced by @multi-cc-im /<command>.
  // These cases verify the OLD bareword form is now treated as a normal
  // mention — router will report "not found" (expected, no cc named "list").
  // ==========================================================================

  it('@list (old bareword control) → now parses as mention', () => {
    expect(parse('@list')).toEqual({
      type: 'mention',
      mentions: ['list'],
      body: '',
    });
  });

  it('@help (old bareword control) → now parses as mention', () => {
    expect(parse('@help')).toEqual({
      type: 'mention',
      mentions: ['help'],
      body: '',
    });
  });

  it('@current (old bareword control) → now parses as mention', () => {
    expect(parse('@current')).toEqual({
      type: 'mention',
      mentions: ['current'],
      body: '',
    });
  });

  // ==========================================================================
  // Bridge commands: @multi-cc-im /<command> [args]
  // ==========================================================================

  it('@multi-cc-im /list → bridge_command list', () => {
    expect(parse('@multi-cc-im /list')).toEqual({
      type: 'bridge_command',
      command: 'list',
      args: '',
    });
  });

  it('@multi-cc-im /help → bridge_command help', () => {
    expect(parse('@multi-cc-im /help')).toEqual({
      type: 'bridge_command',
      command: 'help',
      args: '',
    });
  });

  it('@multi-cc-im /current → bridge_command current', () => {
    expect(parse('@multi-cc-im /current')).toEqual({
      type: 'bridge_command',
      command: 'current',
      args: '',
    });
  });

  it('@multi-cc-im /rename auth-fix → bridge_command rename with single-word args', () => {
    expect(parse('@multi-cc-im /rename auth-fix')).toEqual({
      type: 'bridge_command',
      command: 'rename',
      args: 'auth-fix',
    });
  });

  it('@multi-cc-im /rename auth fix more args → args is everything after first whitespace', () => {
    expect(parse('@multi-cc-im /rename auth fix more args')).toEqual({
      type: 'bridge_command',
      command: 'rename',
      args: 'auth fix more args',
    });
  });

  it('@multi-cc-im (no body) → error /expects a /<command>/', () => {
    expect(parse('@multi-cc-im')).toEqual({
      type: 'error',
      message: expect.stringMatching(/expects a \/<command>/),
    });
  });

  it('@multi-cc-im hello (body without /) → error /expects a /<command>/', () => {
    expect(parse('@multi-cc-im hello')).toEqual({
      type: 'error',
      message: expect.stringMatching(/expects a \/<command>/),
    });
  });

  it('@multi-cc-im / (empty after slash) → error /empty command after `/`/', () => {
    expect(parse('@multi-cc-im /')).toEqual({
      type: 'error',
      message: expect.stringMatching(/empty command after `\/`/),
    });
  });

  it('@multi-cc-im @api /list → error (multi-cc-im is exclusive)', () => {
    expect(parse('@multi-cc-im @api /list')).toEqual({
      type: 'error',
      message: expect.stringMatching(/exclusive — cannot combine/),
    });
  });

  it('@api @multi-cc-im /list → error (multi-cc-im is exclusive even when not first)', () => {
    expect(parse('@api @multi-cc-im /list')).toEqual({
      type: 'error',
      message: expect.stringMatching(/exclusive — cannot combine/),
    });
  });

  it('@<name> mid-message → NOT a mention (only start matters)', () => {
    expect(parse('hello @frontend world')).toEqual({
      type: 'plain',
      body: 'hello @frontend world',
    });
  });

  it('@@ double at → not a valid mention, treat as plain', () => {
    // First @ leads, second @ is part of name → token is "@frontend" body? No,
    // a leading mention token is `@<name>` where name is non-empty non-space.
    // `@@frontend` parses as token `@frontend` (the "name" is `@frontend`),
    // which will fail matching downstream → router returns error.
    expect(parse('@@frontend hello')).toEqual({
      type: 'mention',
      mentions: ['@frontend'],
      body: 'hello',
    });
  });

  it('Unicode + emoji friendly_name preserved', () => {
    expect(parse('@前端 写文档 ✨')).toEqual({
      type: 'mention',
      mentions: ['前端'],
      body: '写文档 ✨',
    });
  });

  it('newlines in body preserved', () => {
    expect(parse('@frontend line1\nline2')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'line1\nline2',
    });
  });

  it('leading newlines / tabs trimmed before parsing', () => {
    expect(parse('\n\t@frontend hello')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: 'hello',
    });
  });

  it('mention list with @all in middle → error (still exclusive)', () => {
    expect(parse('@a @all @b')).toEqual({
      type: 'error',
      message: expect.stringMatching(/@all.*exclusive/i),
    });
  });

  it('@all with mid-message position → broadcast still triggered (last token decides)', () => {
    // Edge: `@all @all body` — both are @all, treat as broadcast
    expect(parse('@all @all stop')).toEqual({
      type: 'broadcast',
      body: 'stop',
    });
  });
});

describe('parser — permission_response (@<tab> /1 | /2)', () => {
  it('@<name> /1 → permission_response allow', () => {
    expect(parse('@frontend /1')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'allow',
    });
  });

  it('@<name> /2 → permission_response deny', () => {
    expect(parse('@frontend /2')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'deny',
    });
  });

  it('@<name> /1 with surrounding whitespace still parses as permission_response', () => {
    expect(parse('@frontend   /1   ')).toEqual({
      type: 'permission_response',
      tabName: 'frontend',
      decision: 'allow',
    });
  });

  it('@<name> /3 → mention (not permission_response — only /1 /2 are reserved)', () => {
    expect(parse('@frontend /3')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '/3',
    });
  });

  it('@<name> /1 with extra body → mention (only exact /1 is reserved)', () => {
    expect(parse('@frontend /1 extra')).toEqual({
      type: 'mention',
      mentions: ['frontend'],
      body: '/1 extra',
    });
  });

  it('@all /1 → broadcast (not permission — broadcast wins for @all)', () => {
    expect(parse('@all /1')).toEqual({
      type: 'broadcast',
      body: '/1',
    });
  });

  it('@a @b /1 → mention (multi-mention disqualifies permission shortcut)', () => {
    expect(parse('@a @b /1')).toEqual({
      type: 'mention',
      mentions: ['a', 'b'],
      body: '/1',
    });
  });

  it('@multi-cc-im /1 → bridge_command "1" (reserved name takes precedence)', () => {
    // `1` is not a defined bridge command, but parser stays at the parse layer.
    // Router's handleBridgeCommand reports the unknown-command error.
    expect(parse('@multi-cc-im /1')).toEqual({
      type: 'bridge_command',
      command: '1',
      args: '',
    });
  });

  it('@<name> /1 with $-prefix tabname preserved', () => {
    expect(parse('@$abc12345 /2')).toEqual({
      type: 'permission_response',
      tabName: '$abc12345',
      decision: 'deny',
    });
  });
});
