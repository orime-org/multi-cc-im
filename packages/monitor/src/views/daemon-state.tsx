/** @jsxImportSource hono/jsx */

import type { FC } from 'hono/jsx';
import { relativeTime } from '../metrics.js';
import type { DaemonStateSnapshot } from '../types.js';

interface Props {
  state: DaemonStateSnapshot;
}

/**
 * Format uptime seconds → `1h 23m` or `45s`.
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Single-line KV pills inside the sticky `.daemon-header` band — replaces
 * the previous 4-row stacked table. The 4 fields users always want to see
 * (pid / uptime / terminal / IM connection) stay above the tab nav so they
 * never get hidden when switching tabs.
 */
export const DaemonStateView: FC<Props> = ({ state }) => {
  const imPillClass =
    state.imConnection === 'connected'
      ? 'pill-ok'
      : state.imConnection === 'connecting'
        ? 'pill-warn'
        : 'pill-error';
  return (
    <div class="daemon-header">
      <span class="kv">
        <span class="kv-key">pid</span>
        <span class="kv-val"><code>{state.pid}</code></span>
      </span>
      <span class="kv">
        <span class="kv-key">uptime</span>
        <span class="kv-val">{formatUptime(state.uptimeSeconds)}</span>
      </span>
      <span class="kv">
        <span class="kv-key">terminal</span>
        <span class="kv-val"><code>{state.activeTerminal}</code></span>
      </span>
      <span class="kv">
        <span class="kv-key">IM ({state.imAdapter})</span>
        <span class={`pill ${imPillClass}`}>{state.imConnection}</span>
        {state.imReconnectAttempts > 0 && (
          <span class="kv-key">
            {state.imReconnectAttempts} reconnect(s)
            {state.imLastReconnectAt &&
              ` · last ${relativeTime(state.imLastReconnectAt)}`}
          </span>
        )}
      </span>
    </div>
  );
};
