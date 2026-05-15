/**
 * Frozen Claude 4.x price table — subset of LiteLLM
 * `model_prices_and_context_window_backup.json` (verified 2026-05-15).
 *
 * Per [DD 2026-05-15 §2](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md):
 * we vendor a frozen snapshot rather than fetch at runtime — LiteLLM
 * URL was live + 200 OK at DD time, but a daemon should not pin its
 * cost display to an upstream that could rate-limit / drift.
 *
 * Re-sync command (manual, run when Anthropic adjusts list price):
 *   curl -sL https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/model_prices_and_context_window_backup.json \
 *     | jq '[to_entries[] | select(.key|test("claude-(opus|sonnet|haiku)-4"))] | from_entries'
 *
 * Prices are USD per token. To compute cost: tokens × cost_per_token.
 */

export interface ClaudeModelPrice {
  input_cost_per_token: number;
  output_cost_per_token: number;
  /** Cache READ (cheaper than input, ~10× discount). */
  cache_read_input_token_cost: number;
  /** Cache CREATE (writes the cache; LiteLLM 2026-05 returns a single flat number, no 5m/1h split). */
  cache_creation_input_token_cost: number;
}

/**
 * Map of cc model id (as appears in transcript jsonl `model` field) →
 * unit prices. Keys cover the Claude 4.x family available in cc as of
 * 2026-05-15. Anthropic backends (vendor prefix) collapsed onto the
 * model-only key for convenience — cc's `model` field is usually the
 * canonical short id (`claude-opus-4-1`).
 */
export const CLAUDE_4_PRICES: Readonly<Record<string, ClaudeModelPrice>> = Object.freeze({
  // Opus 4.x family
  'claude-opus-4-1': {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
  },
  'claude-opus-4-1-20250805': {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
  },
  'claude-opus-4-5': {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
  },
  'claude-opus-4-6': {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
  },
  'claude-opus-4-7': {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
  },
  // Sonnet 4.x family
  'claude-sonnet-4-5': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  'claude-sonnet-4-6': {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  // Haiku 4.x family
  'claude-haiku-4-5': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
});

/**
 * Pick a price entry for a model id. Tolerates the long vendor-prefixed
 * form Anthropic / Bedrock sometimes return (`anthropic.claude-opus-4-7-...`)
 * by best-effort substring match against canonical keys.
 *
 * Returns null if no match — caller's job to fall back to "unknown
 * model, $— shown".
 */
export function priceForModel(model: string | null): ClaudeModelPrice | null {
  if (!model) return null;
  const direct = CLAUDE_4_PRICES[model];
  if (direct) return direct;
  // Fuzzy: pick the longest key that appears as a substring of `model`
  // — works for `anthropic.claude-opus-4-1-20250805-v1:0` and similar.
  let best: { key: string; price: ClaudeModelPrice } | null = null;
  for (const [k, v] of Object.entries(CLAUDE_4_PRICES)) {
    if (model.includes(k) && (!best || k.length > best.key.length)) {
      best = { key: k, price: v };
    }
  }
  return best ? best.price : null;
}

/**
 * Compute USD cost from raw token counts. Always non-negative.
 * Missing-price case: returns 0 (caller renders "—" when model unknown).
 */
export function computeUsd(
  price: ClaudeModelPrice | null,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  },
): number {
  if (!price) return 0;
  return (
    tokens.inputTokens * price.input_cost_per_token +
    tokens.outputTokens * price.output_cost_per_token +
    tokens.cacheCreationInputTokens * price.cache_creation_input_token_cost +
    tokens.cacheReadInputTokens * price.cache_read_input_token_cost
  );
}
