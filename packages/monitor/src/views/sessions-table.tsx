/** @jsxImportSource hono/jsx */

import type { FC } from 'hono/jsx';
import type { SessionSnapshot } from '../types.js';

interface Props {
  sessions: SessionSnapshot[];
}

export const SessionsTable: FC<Props> = ({ sessions }) => {
  if (sessions.length === 0) {
    return (
      <div class="empty">
        no cc tabs detected — open a cc TUI in the active terminal (the
        daemon polls <code>listPanes()</code> each render).
      </div>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>title</th>
          <th>paneId</th>
          <th>cwd</th>
          <th>addressable</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr>
            <td>{s.title || <span class="meta">(unnamed)</span>}</td>
            <td><code>{s.paneId.length > 20 ? `${s.paneId.slice(0, 8)}…` : s.paneId}</code></td>
            <td><code>{s.cwd}</code></td>
            <td>
              {s.addressable ? (
                <span class="pill pill-ok">#{s.title}</span>
              ) : (
                <span class="pill pill-warn">/rename needed</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
