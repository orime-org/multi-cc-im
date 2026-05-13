import { describe, it, expect } from 'vitest';
import { cleanTitle, cleanCwd } from './tab-title.js';

describe('cleanTitle', () => {
  it('passes a plain user-renamed title through verbatim', () => {
    expect(cleanTitle('frontend')).toBe('frontend');
    expect(cleanTitle('my-app v2')).toBe('my-app v2');
  });

  it('strips cc cyan-burst status glyph + trailing space', () => {
    // U+2733 ✳ is the "running" indicator — outside Emoji_Presentation,
    // covered by the dingbats range in the regex.
    expect(cleanTitle('✳ frontend')).toBe('frontend');
  });

  it('strips cc braille spinner glyphs', () => {
    expect(cleanTitle('⠐ frontend')).toBe('frontend');
    expect(cleanTitle('⡀ frontend')).toBe('frontend');
  });

  it('strips broader emoji presentation glyphs', () => {
    expect(cleanTitle('🚀 frontend')).toBe('frontend');
  });

  it('collapses default cc title "Claude Code" to empty', () => {
    expect(cleanTitle('Claude Code')).toBe('');
  });

  it('collapses default cc title with model annotation to empty', () => {
    expect(cleanTitle('Claude Code [1m]')).toBe('');
    expect(cleanTitle('Claude Code [opus-4-7]')).toBe('');
  });

  it('collapses default cc title even after status-prefix strip', () => {
    expect(cleanTitle('✳ Claude Code')).toBe('');
    expect(cleanTitle('⠐ Claude Code [1m]')).toBe('');
  });

  it('keeps user titles that happen to contain "Claude Code" but not equal it', () => {
    expect(cleanTitle('Claude Code Demo')).toBe('Claude Code Demo');
    expect(cleanTitle('my-Claude Code')).toBe('my-Claude Code');
  });

  it('returns empty string for empty input', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle('   ')).toBe('');
  });
});

describe('cleanCwd', () => {
  it('passes absolute path through verbatim', () => {
    expect(cleanCwd('/Users/foo/proj')).toBe('/Users/foo/proj');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanCwd('  /tmp/x  ')).toBe('/tmp/x');
  });

  it('returns empty string for empty input', () => {
    expect(cleanCwd('')).toBe('');
    expect(cleanCwd('   ')).toBe('');
  });
});
