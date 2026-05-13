import { describe, it, expect } from 'vitest';
import {
  detectIterm2PaneId,
  detectWezTermPaneId,
  runDetectors,
  DEFAULT_DETECTORS,
  type PaneIdDetector,
} from './pane-id-detectors.js';

describe('detectWezTermPaneId', () => {
  it('returns numeric PaneId when WEZTERM_PANE is a digit string', () => {
    const result = detectWezTermPaneId({ WEZTERM_PANE: '42' });
    expect(result).toBe(42);
  });

  it('returns PaneId 0 (truthy edge case) when WEZTERM_PANE is "0"', () => {
    const result = detectWezTermPaneId({ WEZTERM_PANE: '0' });
    expect(result).toBe(0);
  });

  it('returns undefined when WEZTERM_PANE is unset', () => {
    expect(detectWezTermPaneId({})).toBeUndefined();
  });

  it('returns undefined when WEZTERM_PANE is empty string', () => {
    expect(detectWezTermPaneId({ WEZTERM_PANE: '' })).toBeUndefined();
  });

  it('returns undefined when WEZTERM_PANE contains non-digits', () => {
    // Defends against corrupt envs / future iTerm2 detector misfire onto
    // wezterm's slot. Strict digit-only match.
    expect(detectWezTermPaneId({ WEZTERM_PANE: '4a' })).toBeUndefined();
    expect(detectWezTermPaneId({ WEZTERM_PANE: '4 ' })).toBeUndefined();
    expect(
      detectWezTermPaneId({
        WEZTERM_PANE: 'C3D91F33-3805-47E2-A3F6-B8AED6EC2209',
      }),
    ).toBeUndefined();
  });
});

describe('detectIterm2PaneId', () => {
  const UUID = 'C3D91F33-3805-47E2-A3F6-B8AED6EC2209';

  it('extracts UUID from "w<W>t<T>p<P>:UUID" form', () => {
    const result = detectIterm2PaneId({ ITERM_SESSION_ID: `w0t1p0:${UUID}` });
    expect(result).toBe(UUID);
  });

  it('accepts bare UUID (no w/t/p prefix)', () => {
    const result = detectIterm2PaneId({ ITERM_SESSION_ID: UUID });
    expect(result).toBe(UUID);
  });

  it('returns undefined when ITERM_SESSION_ID is unset', () => {
    expect(detectIterm2PaneId({})).toBeUndefined();
  });

  it('returns undefined when ITERM_SESSION_ID is empty string', () => {
    expect(detectIterm2PaneId({ ITERM_SESSION_ID: '' })).toBeUndefined();
  });

  it('returns undefined when UUID portion is malformed', () => {
    // Defends against corrupt envs / unexpected format upstream.
    expect(
      detectIterm2PaneId({ ITERM_SESSION_ID: 'w0t1p0:not-a-uuid' }),
    ).toBeUndefined();
    expect(
      detectIterm2PaneId({ ITERM_SESSION_ID: 'w0t1p0:' }),
    ).toBeUndefined();
    expect(
      detectIterm2PaneId({ ITERM_SESSION_ID: 'garbage' }),
    ).toBeUndefined();
  });

  it('returns undefined for a wezterm-style numeric value', () => {
    // A numeric "42" would fail the iTerm2 UUID regex — letting the
    // wezterm detector win when both env vars somehow co-exist.
    expect(detectIterm2PaneId({ ITERM_SESSION_ID: '42' })).toBeUndefined();
  });
});

describe('runDetectors', () => {
  it('returns first non-undefined detector result', () => {
    const a: PaneIdDetector = () => undefined;
    const b: PaneIdDetector = () => 7 as never;
    const c: PaneIdDetector = () => 13 as never;
    expect(runDetectors([a, b, c], {})).toBe(7);
  });

  it('returns undefined when every detector returns undefined', () => {
    const a: PaneIdDetector = () => undefined;
    const b: PaneIdDetector = () => undefined;
    expect(runDetectors([a, b], {})).toBeUndefined();
  });

  it('does not call detectors past the first non-undefined hit', () => {
    let calledC = false;
    const a: PaneIdDetector = () => undefined;
    const b: PaneIdDetector = () => 7 as never;
    const c: PaneIdDetector = () => {
      calledC = true;
      return undefined;
    };
    runDetectors([a, b, c], {});
    expect(calledC).toBe(false);
  });

  it('returns undefined for empty detector list', () => {
    expect(runDetectors([], { WEZTERM_PANE: '42' })).toBeUndefined();
  });
});

describe('DEFAULT_DETECTORS', () => {
  const UUID = 'C3D91F33-3805-47E2-A3F6-B8AED6EC2209';

  it('includes both terminal detectors in order (wezterm then iterm2)', () => {
    expect(DEFAULT_DETECTORS).toEqual([detectWezTermPaneId, detectIterm2PaneId]);
  });

  it('resolves WEZTERM_PANE via the default chain', () => {
    expect(runDetectors(DEFAULT_DETECTORS, { WEZTERM_PANE: '99' })).toBe(99);
  });

  it('resolves ITERM_SESSION_ID via the default chain', () => {
    expect(
      runDetectors(DEFAULT_DETECTORS, {
        ITERM_SESSION_ID: `w0t1p0:${UUID}`,
      }),
    ).toBe(UUID);
  });

  it('wezterm wins when both env vars are co-present', () => {
    // Detector order makes this deterministic — see DEFAULT_DETECTORS
    // TSDoc rationale.
    expect(
      runDetectors(DEFAULT_DETECTORS, {
        WEZTERM_PANE: '7',
        ITERM_SESSION_ID: `w0t1p0:${UUID}`,
      }),
    ).toBe(7);
  });

  it('returns undefined when no supported env var is present', () => {
    expect(runDetectors(DEFAULT_DETECTORS, {})).toBeUndefined();
  });
});
