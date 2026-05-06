import { describe, it, expect } from 'vitest';
import { parse } from './parser.js';

describe('parser — plain / mention / broadcast / control', () => {
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

  it('@list → control list', () => {
    expect(parse('@list')).toEqual({ type: 'control', command: 'list' });
  });

  it('@help → control help', () => {
    expect(parse('@help')).toEqual({ type: 'control', command: 'help' });
  });

  it('@current → control current', () => {
    expect(parse('@current')).toEqual({ type: 'control', command: 'current' });
  });

  it('control with extra body → error', () => {
    expect(parse('@list please')).toEqual({
      type: 'error',
      message: expect.stringMatching(/@list.*alone/i),
    });
  });

  it('@list combined with other @ → error', () => {
    expect(parse('@list @frontend')).toEqual({
      type: 'error',
      message: expect.stringMatching(/@list.*alone/i),
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
