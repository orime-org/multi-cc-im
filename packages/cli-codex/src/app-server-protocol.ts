import { resolve } from 'node:path';
import { z } from 'zod';

/** Native App Server envelope shared by local transports. */
export const CodexEnvelope = z.object({ id: z.union([z.string(), z.number().int()]).optional(), method: z.string().optional(),
  params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
const Initialized = z.object({ codexHome: z.string(), userAgent: z.string(), platformFamily: z.literal('unix'), platformOs: z.string() });

/** Native initialization parameters for the verified experimental protocol. */
export const codexInitializeParams = {
  clientInfo: { name: 'multi_cc_im_bridge', version: '0.2.3' }, capabilities: { experimentalApi: true },
};

/**
 * Check the selected native home and the supported App Server version.
 * @param value Native initialize response.
 * @param home Selected absolute native home.
 * @returns Nothing when the native identity matches.
 * @throws Invalid response, unsupported platform/version or a different home.
 * @example validateCodexInitialization(result, home);
 */
export function validateCodexInitialization(value: unknown, home: string): void {
  const info = Initialized.parse(value);
  if (resolve(info.codexHome) !== resolve(home) || !/\/0\.163\.0(?:\s|$)/.test(info.userAgent)) {
    throw new Error('Unsupported Codex App Server version or home; use the terminal (verified: 0.163.0)');
  }
}
