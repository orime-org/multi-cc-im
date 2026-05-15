/** @jsxImportSource hono/jsx */

import type { FC } from 'hono/jsx';
import type { SessionCost } from '../types.js';

interface Props {
  costs: SessionCost[];
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  if (n === 0) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export const CostTable: FC<Props> = ({ costs }) => {
  if (costs.length === 0) {
    return (
      <div class="empty">
        no recent cc session transcripts found under
        <code> ~/.claude/projects/</code>
      </div>
    );
  }
  const totalUsd = costs.reduce((s, c) => s + c.usdEstimate, 0);
  return (
    <table>
      <thead>
        <tr>
          <th>session</th>
          <th>model</th>
          <th class="num">input</th>
          <th class="num">output</th>
          <th class="num">cache-create</th>
          <th class="num">cache-read</th>
          <th class="num">USD est.</th>
        </tr>
      </thead>
      <tbody>
        {costs.map((c) => (
          <tr>
            <td><code>{c.sessionId.slice(0, 8)}…</code></td>
            <td>{c.model ? <code>{c.model}</code> : <span class="meta">unknown</span>}</td>
            <td class="num">{fmtTokens(c.inputTokens)}</td>
            <td class="num">{fmtTokens(c.outputTokens)}</td>
            <td class="num">{fmtTokens(c.cacheCreationInputTokens)}</td>
            <td class="num">{fmtTokens(c.cacheReadInputTokens)}</td>
            <td class="num">{fmtUsd(c.usdEstimate)}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={6}><strong>total</strong></td>
          <td class="num"><strong>{fmtUsd(totalUsd)}</strong></td>
        </tr>
      </tbody>
    </table>
  );
};
