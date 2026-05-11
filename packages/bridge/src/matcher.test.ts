import { describe, it, expect } from 'vitest';
import type { PaneId } from '@multi-cc-im/shared';
import { matchSession, RESERVED_BRIDGE_NAME, type SessionInfo } from './matcher.js';

function s(tabTitle: string, paneId = 1): SessionInfo {
  return {
    paneId: paneId as PaneId,
    tabTitle,
    cwd: '/tmp/proj',
  };
}

describe('matchSession — tmux-style 4-level fallback over tabTitle', () => {
  it('empty session list → none', () => {
    expect(matchSession('frontend', [])).toEqual({ type: 'none' });
  });

  describe('Level 1: =<exact> strict tabTitle', () => {
    it('matches verbatim only', () => {
      const a = s('frontend');
      const b = s('frontend-prod');
      expect(matchSession('=frontend', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('does NOT fall through to prefix when no strict match', () => {
      const a = s('frontend');
      expect(matchSession('=front', [a])).toEqual({ type: 'none' });
    });

    it('=front matching multiple → ambiguous (caller reports list)', () => {
      const a = s('front', 1);
      const b = s('front', 2);
      const result = matchSession('=front', [a, b]);
      expect(result.type).toBe('ambiguous');
    });
  });

  describe('Level 2: exact tabTitle (no = prefix)', () => {
    it('frontend matches "frontend" exactly', () => {
      const a = s('frontend');
      const b = s('frontend-prod');
      expect(matchSession('frontend', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('case-sensitive: Frontend ≠ frontend', () => {
      const a = s('frontend');
      const result = matchSession('Frontend', [a]);
      // Falls through to prefix (no exact + no prefix on case-sensitive) → none.
      expect(result.type).toBe('none');
    });
  });

  describe('Level 3: prefix tabTitle', () => {
    it('front matches "frontend" by prefix', () => {
      const a = s('frontend');
      expect(matchSession('front', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('multiple prefix candidates → ambiguous', () => {
      const a = s('frontend', 1);
      const b = s('frontmatter', 2);
      const result = matchSession('front', [a, b]);
      expect(result.type).toBe('ambiguous');
      if (result.type === 'ambiguous') {
        expect(result.candidates).toHaveLength(2);
      }
    });
  });

  describe('Level 4: glob tabTitle (* / ? wildcards)', () => {
    it('*end matches "frontend"', () => {
      const a = s('frontend');
      const b = s('backend');
      const result = matchSession('*end', [a, b]);
      expect(result.type).toBe('ambiguous');
    });

    it('front* matches "frontend"', () => {
      const a = s('frontend');
      expect(matchSession('front*', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('? matches single char', () => {
      const a = s('api1');
      const b = s('api2');
      const result = matchSession('api?', [a, b]);
      expect(result.type).toBe('ambiguous');
    });

    it('glob with no match → none', () => {
      const a = s('frontend');
      expect(matchSession('back*', [a])).toEqual({ type: 'none' });
    });
  });

  describe('panes without /rename (empty tabTitle)', () => {
    it('empty tabTitle is not addressable from IM', () => {
      const a = s('', 1);
      const b = s('frontend', 2);
      // exact match for empty query is excluded; prefix/glob also skip empty titles.
      expect(matchSession('frontend', [a, b])).toEqual({
        type: 'unique',
        session: b,
      });
    });

    it('empty query → none even when panes exist', () => {
      const a = s('frontend');
      expect(matchSession('', [a])).toEqual({ type: 'none' });
    });
  });

  describe('reserved bridge name', () => {
    it('#multi-cc-im never resolves to a session', () => {
      const a = s(RESERVED_BRIDGE_NAME);
      expect(matchSession(RESERVED_BRIDGE_NAME, [a])).toEqual({
        type: 'none',
      });
    });
  });

  describe('precedence: each level is final (no fall-through)', () => {
    it('exact match found → does NOT also consider prefix / glob', () => {
      const exact = s('front', 1);
      const longer = s('frontend', 2);
      // "front" exact-matches `exact` only; `longer` would prefix-match but
      // we stop at level 2.
      expect(matchSession('front', [exact, longer])).toEqual({
        type: 'unique',
        session: exact,
      });
    });

    it('prefix match found → does NOT fall through to glob (which might widen)', () => {
      const a = s('frontend', 1);
      const b = s('backend', 2);
      // "front" prefix-matches `a` only; glob would widen to anything but
      // level 3 returns unique.
      expect(matchSession('front', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });
  });
});
