import { describe, it, expect } from 'vitest';
import {
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
  it('includes the wezterm detector', () => {
    // Order-stable contract: wezterm-first. iTerm2 detector will append in
    // P2 of the iTerm2 adapter milestone chain.
    expect(DEFAULT_DETECTORS).toContain(detectWezTermPaneId);
  });

  it('resolves WEZTERM_PANE via the default chain', () => {
    expect(runDetectors(DEFAULT_DETECTORS, { WEZTERM_PANE: '99' })).toBe(99);
  });

  it('returns undefined when no supported env var is present', () => {
    expect(runDetectors(DEFAULT_DETECTORS, {})).toBeUndefined();
    expect(
      runDetectors(DEFAULT_DETECTORS, {
        // iTerm2 env present but no iTerm2 detector wired yet (P2 work)
        ITERM_SESSION_ID: 'w0t0p0:C3D91F33-3805-47E2-A3F6-B8AED6EC2209',
      }),
    ).toBeUndefined();
  });
});
