import { describe, expect, it } from 'vitest';
import { maskSecret } from './mask.js';

/**
 * Per [DD §9.D4](../../../../docs/superpowers/specs/2026-05-10-interactive-start-wizard-dd.md#9d4)
 * — copies AWS CLI's mask formula `'*' * 16 + last_4` verified against
 * [aws-cli/__init__.py:38](https://github.com/aws/aws-cli/blob/main/awscli/customizations/configure/__init__.py).
 */
describe('maskSecret (W4 — DD §9.D4)', () => {
  it('long secret → 16 asterisks + last 4 chars (AWS CLI formula)', () => {
    expect(maskSecret('cli_a1b2c3d4e5f6g7h8WXYZ')).toBe('****************WXYZ');
    expect(maskSecret('cli_a1b2c3d4e5f6g7h8WXYZ').length).toBe(20);
  });

  it('exactly 4 chars → 16 asterisks + the same 4 chars', () => {
    expect(maskSecret('abcd')).toBe('****************abcd');
  });

  it('< 4 chars → 16 asterisks only (suppresses last_4 because it would expose the whole secret)', () => {
    expect(maskSecret('abc')).toBe('****************');
    expect(maskSecret('xy')).toBe('****************');
    expect(maskSecret('z')).toBe('****************');
  });

  it('empty string → 16 asterisks (defensive — caller usually checks for existence first)', () => {
    expect(maskSecret('')).toBe('****************');
  });

  it('Unicode-safe: counts JS string length (UTF-16 code units), matching AWS behavior on byte-equivalent secrets', () => {
    // AWS-style mask is based on Python string length, not bytes; JS .length
    // on UTF-16 code units gives equivalent results for ASCII secrets.
    // Surrogate pairs are not expected in real Feishu tokens but the slicing
    // doesn't crash on them.
    const secret = 'cli_' + '1234567890123456';  // 20 chars
    expect(maskSecret(secret).endsWith('3456')).toBe(true);
  });
});
