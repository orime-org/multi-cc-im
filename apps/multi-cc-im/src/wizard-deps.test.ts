import { describe, expect, it } from 'vitest';
import * as clack from '@clack/prompts';
import terminalLink from 'terminal-link';
import open from 'open';

/**
 * W1 smoke — locks in the three setup-wizard dependencies and asserts the
 * exports we'll consume in W4 / W6 actually load. A regression here means
 * either the package was uninstalled, ESM resolution broke, or upstream
 * renamed an export — caught at typecheck + test time, not at first user
 * interaction.
 *
 * Per [interactive start wizard DD §10.1 W1](../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#101-implementation-milestones-post-dd).
 */
describe('wizard deps — ESM resolution smoke', () => {
  it('@clack/prompts exports the prompt primitives we picked in DD §9.D2', () => {
    expect(typeof clack.select).toBe('function');
    expect(typeof clack.text).toBe('function');
    expect(typeof clack.password).toBe('function');
    expect(typeof clack.confirm).toBe('function');
    expect(typeof clack.isCancel).toBe('function');
  });

  it('terminal-link is callable (D3 inline + ANSI hyperlink)', () => {
    expect(typeof terminalLink).toBe('function');
    const rendered = terminalLink('label', 'https://example.com', {
      fallback: (text, url) => `${text} (${url})`,
    });
    expect(rendered).toContain('label');
  });

  it('open is callable (D3 optional browser fallback)', () => {
    expect(typeof open).toBe('function');
  });
});
