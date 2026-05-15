/** @jsxImportSource hono/jsx */

import type { FC } from 'hono/jsx';
import { relativeTime } from '../metrics.js';
import type { ErrorEntry } from '../types.js';

interface Props {
  errors: ErrorEntry[];
}

export const ErrorsTable: FC<Props> = ({ errors }) => {
  if (errors.length === 0) {
    return <div class="empty">no errors since daemon start ✓</div>;
  }
  // Newest first (buffer order is oldest-first; reverse for display).
  const display = [...errors].reverse();
  return (
    <table>
      <thead>
        <tr>
          <th>when</th>
          <th>phase</th>
          <th>message</th>
        </tr>
      </thead>
      <tbody>
        {display.map((e) => (
          <tr>
            <td><span class="meta">{relativeTime(e.timestamp)}</span></td>
            <td><code>{e.phase}</code></td>
            <td>{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
