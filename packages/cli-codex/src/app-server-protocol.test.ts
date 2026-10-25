import { describe, expect, it } from 'vitest';
import { codexRuntimeError, getCodexVersion, parseCodexRpcError, validateCodexInitialization } from './app-server-protocol.js';

const home = '/tmp/native-home';
const initialized = { codexHome: home, platformFamily: 'unix', platformOs: 'macos' };

describe('native runtime diagnostics', () => {
  it.each(['0.164.0', '0.1.0', 'future-build', '', undefined, null, 42])('does not admit or reject by version metadata %j', userAgent => {
    expect(() => validateCodexInitialization({ ...initialized, userAgent }, home)).not.toThrow();
  });

  it('extracts observed version tokens without validating a supported version', () => {
    expect(getCodexVersion({ userAgent: 'client/0.164.0 (Mac OS; arm64)' })).toBe('0.164.0');
    expect(getCodexVersion({ userAgent: 'client/future-build extra' })).toBe('future-build');
    for (const value of [null, {}, { userAgent: 42 }, { userAgent: 'unfamiliar' }]) expect(getCodexVersion(value)).toBe('unknown');
  });

  it('retains home and platform validation', () => {
    expect(() => validateCodexInitialization({ ...initialized, codexHome: '/tmp/other' }, home)).toThrow(/home/i);
    expect(() => validateCodexInitialization({ ...initialized, platformFamily: 'windows' }, home)).toThrow();
  });

  it('retains the actual RPC code and message without optional error data', () => {
    const cause = parseCodexRpcError({ code: -32600, message: 'thread not loaded', data: { secret: 'private fixture' } });
    const error = codexRuntimeError('thread/read', '0.164.0', cause);
    expect(error.message).toContain('thread/read');
    expect(error.message).toContain('version: 0.164.0');
    expect(error.message).toContain('RPC -32600: thread not loaded');
    expect(error.message).toContain('codex app-server --help');
    expect(error.message).not.toContain('private fixture');
    expect(error.cause).toBe(cause);
    expect(codexRuntimeError('initialize', 'unknown', error)).toBe(error);
  });

  it('diagnoses malformed RPC error fields', () => {
    expect(parseCodexRpcError({ code: 'bad', message: 42 }).message).toContain('Invalid Codex RPC error');
  });
});
