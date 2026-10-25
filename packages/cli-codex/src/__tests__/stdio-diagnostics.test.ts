import { expect, it } from 'vitest';
import { expectMetadataDiagnostics } from './stdio-diagnostics.js';

const warning = (status: string): Error => new Error(`Codex App Server metadata reader cleanup required intervention ${status}; metadata was received.`);

it.each([
  '(code=null, signal=SIGTERM)',
  '(code=null, signal=SIGKILL)',
  '(code=17, signal=null)',
  '(code=0, signal=SIGTERM)',
  '(code=null, signal=null)',
])('accepts a cleanup warning for intervention status %s', status => {
  expect(() => expectMetadataDiagnostics([warning(status)])).not.toThrow();
});

it.each([
  [new Error('Unrelated failure')],
  [new Error('Codex App Server metadata reader cleanup required intervention malformed')],
  [warning('(code=null, signal=SIGTERM)'), warning('(code=null, signal=SIGTERM)')],
  [String(warning('(code=null, signal=SIGTERM)'))],
  [warning('(code=null, signal=SIGTERM)'), new Error('Unrelated failure')],
].map(errors => ({ errors })))('rejects unexpected or malformed diagnostics $errors', ({ errors }) => {
  expect(() => expectMetadataDiagnostics(errors)).toThrow();
});

it('requires each injected diagnostic in order', () => {
  const first = new Error('First');
  const second = new Error('Second');
  expect(() => expectMetadataDiagnostics([first, warning('(code=null, signal=SIGTERM)'), second], ['Error: First', 'Error: Second'])).not.toThrow();
  expect(() => expectMetadataDiagnostics([first], ['Error: First', 'Error: Second'])).toThrow();
  expect(() => expectMetadataDiagnostics([second, first], ['Error: First', 'Error: Second'])).toThrow();
  expect(() => expectMetadataDiagnostics([first, first], ['Error: First'])).toThrow();
});

it('rejects a cleanup warning for a clean zero exit', () => {
  expect(() => expectMetadataDiagnostics([warning('(code=0, signal=null)')])).toThrow();
});

it('validates contextual cleanup diagnostics without hiding their original errors', () => {
  const cause = warning('(code=null, signal=SIGTERM)');
  const contextual = new Error(`Codex App Server metadata reader cleanup failed (version: 0.164.0): ${cause.message} Check codex app-server --help`, { cause });
  expect(() => expectMetadataDiagnostics([contextual])).not.toThrow();
  expect(() => expectMetadataDiagnostics([new Error(contextual.message)])).toThrow();
  expect(() => expectMetadataDiagnostics([new Error(contextual.message, { cause: new Error('Unexpected IO error') })])).toThrow();
});
