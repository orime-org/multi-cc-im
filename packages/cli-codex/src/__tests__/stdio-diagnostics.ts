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
  errors = errors.map(error => {
    if (!(error instanceof Error) || !error.message.startsWith('Codex App Server metadata reader cleanup failed (version: ')) return error;
    expect(error.message).toMatch(/^Codex App Server metadata reader cleanup failed \(version: [^\s)]+\): /);
    expect(error.message).toContain('codex app-server --help');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain((error.cause as Error).message);
    return error.cause;
  });
  const cleanup = errors.filter(error => String(error).startsWith('Error: Codex App Server metadata reader cleanup required intervention'));
  expect(cleanup.length).toBeLessThanOrEqual(1);
  for (const error of cleanup) {
    expect(error).toBeInstanceOf(Error);
    const status = String(error).match(/^Error: Codex App Server metadata reader cleanup required intervention \(code=(null|-?\d+), signal=(null|SIG[A-Z0-9]+)\); metadata was received\.$/);
    expect(status).not.toBeNull();
    expect(status?.slice(1)).not.toEqual(['0', 'null']);
  }
  expect(errors.filter(error => !cleanup.includes(error)).map(String)).toEqual(expected);
}
