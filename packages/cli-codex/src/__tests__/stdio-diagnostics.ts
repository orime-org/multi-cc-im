import { expect } from 'vitest';

/**
 * Verify query diagnostics while allowing the documented cleanup intervention.
 * @param errors Diagnostics emitted after the owned process closes.
 * @param expected Expected diagnostics independent of process exit timing.
 * @returns Nothing when every diagnostic matches the query and cleanup contract.
 * @throws Assertion failures for unexpected, malformed or duplicate diagnostics.
 * @example expectMetadataDiagnostics(errors, ['Error: Injected IO failure']);
 */
export function expectMetadataDiagnostics(errors: unknown[], expected: string[] = []): void {
  const cleanup = errors.filter(error => String(error).startsWith('Error: Codex App Server metadata reader cleanup required intervention'));
  expect(cleanup.length).toBeLessThanOrEqual(1);
  for (const error of cleanup) {
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/^Error: Codex App Server metadata reader cleanup required intervention \(code=(?:null|-?\d+), signal=(?:null|SIG[A-Z0-9]+)\); metadata was received\.$/);
  }
  expect(errors.filter(error => !cleanup.includes(error)).map(String)).toEqual(expected);
}
