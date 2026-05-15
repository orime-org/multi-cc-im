import { describe, it, expect } from 'vitest';
import {
  CLAUDE_4_PRICES,
  computeUsd,
  priceForModel,
  type ClaudeModelPrice,
} from './prices.js';

describe('CLAUDE_4_PRICES', () => {
  it('frozen — direct mutation forbidden', () => {
    expect(Object.isFrozen(CLAUDE_4_PRICES)).toBe(true);
  });

  it('every entry has all 4 cost fields as positive numbers', () => {
    const requiredKeys: (keyof ClaudeModelPrice)[] = [
      'input_cost_per_token',
      'output_cost_per_token',
      'cache_read_input_token_cost',
      'cache_creation_input_token_cost',
    ];
    for (const [model, price] of Object.entries(CLAUDE_4_PRICES)) {
      for (const k of requiredKeys) {
        expect(price[k], `${model}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('Opus 4.7 priced 5× Sonnet 4.6 on input (canonical Anthropic ratio)', () => {
    const opus = CLAUDE_4_PRICES['claude-opus-4-7']!;
    const sonnet = CLAUDE_4_PRICES['claude-sonnet-4-6']!;
    expect(opus.input_cost_per_token / sonnet.input_cost_per_token).toBeCloseTo(5, 1);
  });
});

describe('priceForModel', () => {
  it('null model → null', () => {
    expect(priceForModel(null)).toBeNull();
  });

  it('exact key hit', () => {
    expect(priceForModel('claude-opus-4-7')).toBe(CLAUDE_4_PRICES['claude-opus-4-7']);
  });

  it('fuzzy match strips vendor prefix + date suffix', () => {
    // LiteLLM-style long form
    expect(priceForModel('anthropic.claude-opus-4-1-20250805-v1:0')).toBe(
      CLAUDE_4_PRICES['claude-opus-4-1-20250805'],
    );
  });

  it('fuzzy match picks the LONGEST overlapping key', () => {
    // Both `claude-opus-4-1` and `claude-opus-4-1-20250805` could match;
    // longer key wins so we don't lose the date specificity when it's there.
    expect(priceForModel('anthropic.claude-opus-4-1-20250805-v1:0')!).toBe(
      CLAUDE_4_PRICES['claude-opus-4-1-20250805'],
    );
  });

  it('unrelated model id → null', () => {
    expect(priceForModel('gpt-5-turbo')).toBeNull();
  });
});

describe('computeUsd', () => {
  const price: ClaudeModelPrice = {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
  };

  it('null price → 0', () => {
    expect(computeUsd(null, {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 1000,
    })).toBe(0);
  });

  it('linear sum across all 4 token classes', () => {
    const got = computeUsd(price, {
      inputTokens: 1000,
      outputTokens: 2000,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 8000,
    });
    // 1000*1e-5 + 2000*5e-5 + 4000*1.25e-5 + 8000*1e-6
    // = 0.01 + 0.10 + 0.05 + 0.008 = 0.168
    expect(got).toBeCloseTo(0.168, 6);
  });

  it('zero tokens → 0', () => {
    expect(computeUsd(price, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })).toBe(0);
  });
});
