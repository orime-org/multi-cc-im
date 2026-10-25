import { resolve } from 'node:path';
import { z } from 'zod';

/** Native App Server envelope shared by local transports. */
export const CodexEnvelope = z.object({ id: z.union([z.string(), z.number().int()]).optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
const Initialized = z.object({ codexHome: z.string(), platformFamily: z.literal('unix'), platformOs: z.string() });
const RpcError = z.object({ code: z.number().int(), message: z.string() });
class CodexRuntimeError extends Error {}

/** Native initialization parameters for the verified experimental protocol. */
export const codexInitializeParams = {
  clientInfo: { name: 'multi_cc_im_bridge', version: '0.2.3' }, capabilities: { experimentalApi: true },
};

/**
 * Check the selected native home and platform without version admission.
 * @param value Native initialize response.
 * @param home Selected absolute native home.
 * @returns Nothing when the native identity matches.
 * @throws Invalid response, unsupported platform or a different home.
 * @example validateCodexInitialization(result, home);
 */
export function validateCodexInitialization(value: unknown, home: string): void {
  const info = Initialized.parse(value);
  if (resolve(info.codexHome) !== resolve(home)) {
    throw new Error('Codex App Server returned a different home from the selected CODEX_HOME');
  }
}

/**
 * Extract diagnostic metadata without making it a protocol precondition.
 * @param value Untrusted initialize result.
 * @returns Observed version token, or explicit unknown when unavailable.
 * @example const version = getCodexVersion(result);
 */
export function getCodexVersion(value: unknown): string {
  const info = z.object({ userAgent: z.string() }).safeParse(value);
  return info.success ? info.data.userAgent.match(/^[^/\s]+\/([^\s]+)/)?.[1] ?? 'unknown' : 'unknown';
}

/**
 * Preserve native RPC code/message without exposing optional error data.
 * @param value Untrusted native error response.
 * @returns Native failure or a malformed-error diagnostic.
 * @example throw parseCodexRpcError(message.error);
 */
export function parseCodexRpcError(value: unknown): Error {
  const parsed = RpcError.safeParse(value);
  return new Error(parsed.success ? `RPC ${parsed.data.code}: ${parsed.data.message}` : 'Invalid Codex RPC error: expected integer code and string message');
}

/**
 * Describe an actual failure with its runtime context and recovery action.
 * @param operation Failed native method or transport stage.
 * @param version Observed runtime version; unknown before usable initialization.
 * @param error Original failure, retained as cause.
 * @returns Contextual error; existing contextual errors retain their identity.
 * @example onError(codexRuntimeError('thread/read', version, err));
 */
export function codexRuntimeError(operation: string, version: string, error: unknown): Error {
  if (error instanceof CodexRuntimeError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new CodexRuntimeError(`Codex App Server ${operation} failed (version: ${version}): ${detail}. Check the selected CODEX_HOME; run codex --version and codex app-server --help in the terminal, then retry there.`, { cause: error });
}
