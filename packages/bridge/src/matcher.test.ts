import { describe, it, expect } from 'vitest';
import type { CwdAbs, PaneId, SessionId } from '@multi-cc-im/shared';
import { matchSession, RESERVED_BRIDGE_NAME, type SessionInfo } from './matcher.js';

function s(
  shortIdHex: string,
  tabTitle: string | undefined,
  paneId = 1,
): SessionInfo {
  // Build a UUID-shape SessionId where the first 8 hex chars match the short
  // hash, so id-prefix matching can be tested deterministically.
  const padded = shortIdHex.padEnd(8, '0').slice(0, 8);
  const sessionId = `${padded}-3606-4fe4-b01d-${'0'.repeat(12)}` as SessionId;
  return {
    sessionId,
    paneId: paneId as PaneId,
    tabTitle,
    cwd: '/tmp/proj' as CwdAbs,
  };
}

describe('matchSession — tmux 4-level fallback', () => {
  it('empty session list → none', () => {
    expect(matchSession('frontend', [])).toEqual({ type: 'none' });
  });

  describe('Level 1: $<id-prefix> session_id short hash', () => {
    it('matches by exact id prefix (4+ chars)', () => {
      const a = s('abc12345', 'frontend');
      const b = s('def67890', 'api');
      expect(matchSession('$abc12345', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('matches partial id prefix (uses startsWith)', () => {
      const a = s('abc12345', 'frontend');
      const b = s('def67890', 'api');
      expect(matchSession('$abc1', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('id-prefix with no match → none', () => {
      const a = s('abc12345', 'frontend');
      expect(matchSession('$xyz', [a])).toEqual({ type: 'none' });
    });

    it('id-prefix with multiple matches → ambiguous', () => {
      const a = s('abc12345', 'frontend');
      const b = s('abc67890', 'api');
      expect(matchSession('$abc', [a, b])).toEqual({
        type: 'ambiguous',
        candidates: [a, b],
      });
    });

    it('id-prefix never falls through to tabTitle (strict)', () => {
      const a = s('99999999', 'frontend');
      // $frontend looks like an id-prefix even though "frontend" matches a
      // tabTitle — `$` mode is strict id-only.
      expect(matchSession('$frontend', [a])).toEqual({ type: 'none' });
    });
  });

  describe('Level 2: =<exact> strict tabTitle (no fallback)', () => {
    it('matches exact tabTitle', () => {
      const a = s('aaaa', 'frontend');
      expect(matchSession('=frontend', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('rejects prefix when using = (strict mode)', () => {
      const a = s('aaaa', 'frontend');
      expect(matchSession('=front', [a])).toEqual({ type: 'none' });
    });

    it('rejects glob when using =', () => {
      const a = s('aaaa', 'frontend');
      expect(matchSession('=front*', [a])).toEqual({ type: 'none' });
    });
  });

  describe('Level 3: exact tabTitle', () => {
    it('matches exact tabTitle (case-sensitive)', () => {
      const a = s('aaaa', 'frontend');
      const b = s('bbbb', 'api');
      expect(matchSession('frontend', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('case mismatch → falls through to prefix', () => {
      const a = s('aaaa', 'Frontend');
      // No exact match for "frontend" (lowercase); also no prefix of "Frontend"
      // starts with "frontend" (case-sensitive) → none
      expect(matchSession('frontend', [a])).toEqual({ type: 'none' });
    });

    it('exact wins over prefix when both apply', () => {
      // Two tabTitles: "fe" exact, "front" prefix-could-match if "fe" not
      // exact. Querying "fe" → exact match wins.
      const exact = s('aaaa', 'fe');
      const prefix = s('bbbb', 'front');
      expect(matchSession('fe', [exact, prefix])).toEqual({
        type: 'unique',
        session: exact,
      });
    });
  });

  describe('Level 4: prefix tabTitle', () => {
    it('matches unique prefix', () => {
      const a = s('aaaa', 'frontend');
      const b = s('bbbb', 'api');
      expect(matchSession('fr', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('one-character prefix uniquely matches', () => {
      const a = s('aaaa', 'frontend');
      const b = s('bbbb', 'api');
      expect(matchSession('a', [a, b])).toEqual({
        type: 'unique',
        session: b,
      });
    });

    it('ambiguous prefix → ambiguous + candidates', () => {
      const a = s('aaaa', 'frontend');
      const b = s('bbbb', 'frame');
      expect(matchSession('fr', [a, b])).toEqual({
        type: 'ambiguous',
        candidates: [a, b],
      });
    });

    it('ambiguous candidates preserve registry order', () => {
      const c = s('cccc', 'frame');
      const a = s('aaaa', 'frontend');
      const result = matchSession('fr', [c, a]);
      expect(result).toEqual({ type: 'ambiguous', candidates: [c, a] });
    });
  });

  describe('Level 5: glob tabTitle (fnmatch * and ?)', () => {
    it('* glob matches multiple in middle', () => {
      const a = s('aaaa', 'frontend');
      const b = s('bbbb', 'api-frontend');
      expect(matchSession('*frontend', [a, b])).toEqual({
        type: 'ambiguous',
        candidates: [a, b],
      });
    });

    it('* glob matches uniquely', () => {
      const a = s('aaaa', 'main-api');
      const b = s('bbbb', 'auxiliary');
      expect(matchSession('*-api', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('? glob matches single char', () => {
      const a = s('aaaa', 'fe1');
      const b = s('bbbb', 'fe22');
      expect(matchSession('fe?', [a, b])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('glob with no match → none', () => {
      const a = s('aaaa', 'frontend');
      expect(matchSession('*xyz*', [a])).toEqual({ type: 'none' });
    });
  });

  describe('Sessions without tabTitle fall back to id-prefix only', () => {
    it('session with no tabTitle not matched by name query', () => {
      const a = s('abc12345', undefined);
      expect(matchSession('frontend', [a])).toEqual({ type: 'none' });
    });

    it('session with no tabTitle still matched by $ id-prefix', () => {
      const a = s('abc12345', undefined);
      expect(matchSession('$abc', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });
  });

  describe('Reserved bridge name', () => {
    it('reserved name multi-cc-im → never resolves to a session', () => {
      // Even if a user manages to /rename a cc to the reserved name, the
      // matcher must NOT resolve `multi-cc-im` to that session — the router
      // owns that string for bridge commands.
      expect(RESERVED_BRIDGE_NAME).toBe('multi-cc-im');
      const a = s('aaaa', 'multi-cc-im');
      expect(matchSession('multi-cc-im', [a])).toEqual({ type: 'none' });
    });
  });

  describe('Edge cases', () => {
    it('Unicode tabTitle (CJK) matches exact', () => {
      const a = s('aaaa', '前端');
      expect(matchSession('前端', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });

    it('empty query → none', () => {
      const a = s('aaaa', 'frontend');
      expect(matchSession('', [a])).toEqual({ type: 'none' });
    });

    it('single-session prefix self-match', () => {
      const a = s('aaaa', 'main');
      expect(matchSession('m', [a])).toEqual({
        type: 'unique',
        session: a,
      });
    });
  });
});
