import { describe, it, expect } from 'vitest';
import {
  isImageSender,
  isFileSender,
  isVoiceSender,
  isTypingIndicator,
  isListPanes,
} from '../guards.js';
import type {
  Adapter as IMAdapter,
  ImageSender,
  FileSender,
  VoiceSender,
  TypingIndicator,
} from '../adapter/im.js';
import type { Adapter as TermAdapter, ListPanes } from '../adapter/term.js';

const baseIM: IMAdapter = {
  name: 'mock-im',
  start: async () => undefined,
  send: async () => undefined,
  stop: async () => undefined,
};

const baseTerm: TermAdapter = {
  name: 'mock-term',
  start: async () => undefined,
  sendText: async () => undefined,
  sendKeystroke: async () => undefined,
  stop: async () => undefined,
};

describe('isImageSender', () => {
  it('returns true when sendImage method exists', () => {
    const adapter: ImageSender = {
      ...baseIM,
      sendImage: async () => undefined,
    };
    expect(isImageSender(adapter)).toBe(true);
  });

  it('returns false when sendImage is missing', () => {
    expect(isImageSender(baseIM)).toBe(false);
  });

  it('narrows type for caller', () => {
    const adapter: IMAdapter = {
      ...baseIM,
      sendImage: async () => undefined,
    } as ImageSender;

    if (isImageSender(adapter)) {
      // narrowed; sendImage callable without cast
      expect(typeof adapter.sendImage).toBe('function');
    } else {
      throw new Error('expected narrowed ImageSender');
    }
  });
});

describe('isFileSender', () => {
  it('returns true when sendFile exists', () => {
    const adapter: FileSender = { ...baseIM, sendFile: async () => undefined };
    expect(isFileSender(adapter)).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(isFileSender(baseIM)).toBe(false);
  });
});

describe('isVoiceSender', () => {
  it('returns true when sendVoice exists', () => {
    const adapter: VoiceSender = { ...baseIM, sendVoice: async () => undefined };
    expect(isVoiceSender(adapter)).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(isVoiceSender(baseIM)).toBe(false);
  });
});

describe('isTypingIndicator', () => {
  it('returns true when startTyping exists', () => {
    const adapter: TypingIndicator = {
      ...baseIM,
      startTyping: async () => () => undefined,
    };
    expect(isTypingIndicator(adapter)).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(isTypingIndicator(baseIM)).toBe(false);
  });
});

describe('isListPanes', () => {
  it('returns true when listPanes method exists', () => {
    const adapter: ListPanes = {
      ...baseTerm,
      listPanes: async () => [],
    };
    expect(isListPanes(adapter)).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(isListPanes(baseTerm)).toBe(false);
  });

  it('narrows type for caller', () => {
    const adapter: TermAdapter = {
      ...baseTerm,
      listPanes: async () => [],
    } as ListPanes;

    if (isListPanes(adapter)) {
      expect(typeof adapter.listPanes).toBe('function');
    } else {
      throw new Error('expected narrowed ListPanes');
    }
  });
});
