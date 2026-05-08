import type {
  Adapter as IMAdapter,
  ImageSender,
  FileSender,
  VoiceSender,
  TypingIndicator,
} from './adapter/im.js';
import type { Adapter as TermAdapter, ListPanes } from './adapter/term.js';

/**
 * Type guards for adapter capabilities. Per adapter DD (TS-first hybrid),
 * caller narrows `Adapter` to a capability-extended interface using these
 * before calling capability methods.
 */

export function isImageSender(a: IMAdapter): a is ImageSender {
  return typeof (a as Partial<ImageSender>).sendImage === 'function';
}

export function isFileSender(a: IMAdapter): a is FileSender {
  return typeof (a as Partial<FileSender>).sendFile === 'function';
}

export function isVoiceSender(a: IMAdapter): a is VoiceSender {
  return typeof (a as Partial<VoiceSender>).sendVoice === 'function';
}

export function isTypingIndicator(a: IMAdapter): a is TypingIndicator {
  return typeof (a as Partial<TypingIndicator>).startTyping === 'function';
}

export function isListPanes(a: TermAdapter): a is ListPanes {
  return typeof (a as Partial<ListPanes>).listPanes === 'function';
}
