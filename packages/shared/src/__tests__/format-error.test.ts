import { describe, expect, it } from 'vitest';
import { formatErrorWithCause } from '../format-error.js';

describe('formatErrorWithCause', () => {
  it('plain Error → just the message (no cause)', () => {
    expect(formatErrorWithCause(new Error('boom'))).toBe('boom');
  });

  it('Error with Error cause → message + cause line', () => {
    const inner = new Error('connect ECONNREFUSED 1.2.3.4:443');
    const outer = new Error('fetch failed', { cause: inner });
    expect(formatErrorWithCause(outer)).toBe(
      'fetch failed (cause: connect ECONNREFUSED 1.2.3.4:443)',
    );
  });

  it('Error with cause carrying `code` → appends [code=...]', () => {
    const inner = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const outer = new Error('fetch failed', { cause: inner });
    expect(formatErrorWithCause(outer)).toBe(
      'fetch failed (cause: ECONNREFUSED [code=ECONNREFUSED])',
    );
  });

  it('walks nested cause chain up to depth 5', () => {
    const e1 = new Error('layer-1');
    const e2 = new Error('layer-2', { cause: e1 });
    const e3 = new Error('layer-3', { cause: e2 });
    const e4 = new Error('layer-4', { cause: e3 });
    const out = formatErrorWithCause(e4);
    expect(out).toContain('layer-4');
    expect(out).toContain('cause: layer-3');
    expect(out).toContain('cause: layer-2');
    expect(out).toContain('cause: layer-1');
  });

  it('depth-limits at 5 (prevents infinite walk on circular chains)', () => {
    // Build chain longer than 5; check that we don't crash and we cap.
    const errs = Array.from({ length: 10 }, (_, i) => new Error(`l${i}`));
    for (let i = 1; i < errs.length; i++) {
      (errs[i] as Error & { cause?: unknown }).cause = errs[i - 1];
    }
    const out = formatErrorWithCause(errs[errs.length - 1]!);
    // Top message + at most 5 cause lines
    const causeCount = (out.match(/cause:/g) ?? []).length;
    expect(causeCount).toBeLessThanOrEqual(5);
  });

  it('non-Error value (string) → String(value)', () => {
    expect(formatErrorWithCause('plain string')).toBe('plain string');
  });

  it('non-Error value (number) → String(value)', () => {
    expect(formatErrorWithCause(42)).toBe('42');
  });

  it('null → "null"', () => {
    expect(formatErrorWithCause(null)).toBe('null');
  });

  it('undefined → "undefined"', () => {
    expect(formatErrorWithCause(undefined)).toBe('undefined');
  });

  it('cause is non-Error (e.g. a string) → renders verbatim and stops walking', () => {
    const outer = new Error('outer', { cause: 'plain reason string' });
    expect(formatErrorWithCause(outer)).toBe(
      'outer (cause: plain reason string)',
    );
  });

  it('cause is an object without message → String(obj) representation', () => {
    const outer = new Error('outer', { cause: { foo: 'bar' } });
    const out = formatErrorWithCause(outer);
    expect(out).toContain('outer');
    expect(out).toContain('cause:');
  });

  it('typical undici-style fetch failure shape', () => {
    // Mimic: TypeError("fetch failed") → cause Error("ECONNRESET") with code
    const cause = Object.assign(new Error('ECONNRESET'), {
      code: 'UND_ERR_SOCKET',
    });
    const top = new TypeError('fetch failed');
    (top as Error & { cause?: unknown }).cause = cause;
    expect(formatErrorWithCause(top)).toBe(
      'fetch failed (cause: ECONNRESET [code=UND_ERR_SOCKET])',
    );
  });
});
