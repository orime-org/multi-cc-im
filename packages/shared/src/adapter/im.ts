import type { IncomingMessage } from '../types.js';

/**
 * Handler that an IMAdapter pushes events into.
 * Per adapter DD (TS-first hybrid): callback inject via `start(handler)`,
 * not EventEmitter / AsyncIterator.
 */
export interface Handler {
  /** Called when a new message arrives from the IM channel. */
  onMessage(msg: IncomingMessage): Promise<void>;
  /** Called when the IM connection is dropped. */
  onDisconnect?: (reason: string) => Promise<void>;
  /** Called for non-fatal adapter errors that the bridge should be aware of. */
  onError?: (err: Error) => Promise<void>;
}

/**
 * Opaque, adapter-specific reply context.
 *
 * Each IMAdapter passes a value of its own choosing back to the bridge as
 * part of `IncomingMessage` routing. The bridge stores it but never inspects
 * it; it's handed back unchanged on `send()` so the adapter can match it to
 * the original conversation thread / message id.
 *
 * Modeled as `unknown` (rather than generic) to keep core/router type-erased
 * — same approach as cc-connect's `replyCtx any` (Go).
 */
export type ReplyContext = unknown;

/**
 * Core IMAdapter interface — every IM channel implementation (wechat / telegram /
 * slack / etc.) must satisfy this. Capabilities below extend this with optional
 * features; use type guards in `../guards.ts` to narrow before calling them.
 */
export interface Adapter {
  /** Stable identifier for log / config keys (e.g. `'wechat'`). */
  readonly name: string;
  /** Begin polling / connecting. Hands events to the supplied handler. */
  start(handler: Handler): Promise<void>;
  /** Send plain text back to the conversation identified by `replyCtx`. */
  send(content: string, replyCtx: ReplyContext): Promise<void>;
  /** Stop polling, drain in-flight requests, release sockets. */
  stop(): Promise<void>;
}

/** Capability: send an image attachment to a conversation. */
export interface ImageSender extends Adapter {
  sendImage(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/** Capability: send a generic file attachment to a conversation. */
export interface FileSender extends Adapter {
  sendFile(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/** Capability: send a voice attachment to a conversation. */
export interface VoiceSender extends Adapter {
  sendVoice(localPath: string, replyCtx: ReplyContext): Promise<void>;
}

/**
 * Capability: show a "typing" indicator. Returns a function that the caller
 * MUST invoke when processing finishes (turn-scoped, not session-scoped).
 */
export interface TypingIndicator extends Adapter {
  startTyping(replyCtx: ReplyContext): Promise<() => void>;
}
