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

export const DaemonStateView: FC<Props> = ({ state }) => {
  const imPillClass =
    state.imConnection === 'connected'
      ? 'pill-ok'
      : state.imConnection === 'connecting'
        ? 'pill-warn'
        : 'pill-error';
  return (
    <table>
      <tbody>
        <tr>
          <th>daemon pid</th>
          <td><code>{state.pid}</code></td>
        </tr>
        <tr>
          <th>uptime</th>
          <td>{formatUptime(state.uptimeSeconds)}</td>
        </tr>
        <tr>
          <th>active terminal</th>
          <td><code>{state.activeTerminal}</code></td>
        </tr>
        <tr>
          <th>IM ({state.imAdapter})</th>
          <td>
            <span class={`pill ${imPillClass}`}>{state.imConnection}</span>
            {state.imReconnectAttempts > 0 && (
              <span class="meta"> · {state.imReconnectAttempts} reconnect(s)
                {state.imLastReconnectAt &&
                  ` · last ${relativeTime(state.imLastReconnectAt)}`}
              </span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
};
