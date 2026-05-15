/** @jsxImportSource hono/jsx */
/**
 * JSX → HTML string boundary. Kept isolated in a `.tsx` file so that
 * consumer packages (e.g. `apps/multi-cc-im`) can import the package
 * entry as plain `.ts` without needing `--jsx` set on their tsconfig.
 *
 * `index.ts` calls `renderDashboard(...)` to get a `Promise<string>`
 * suitable for `c.html()` — JSX never leaks across the package boundary.
 */

import { Dashboard } from './views/dashboard.js';
import type {
  DaemonStateSnapshot,
  ErrorEntry,
  SessionCost,
  SessionSnapshot,
} from './types.js';

export interface RenderDashboardInput {
  state: DaemonStateSnapshot;
  sessions: SessionSnapshot[];
  errors: ErrorEntry[];
  costs: SessionCost[];
  renderedAt: string;
}

/**
 * Render the dashboard JSX tree to an HTML string. Caller passes the
 * result to `c.html()`. The cast to string is safe because hono/jsx's
 * server runtime stringifies the tree synchronously when serialized.
 */
export function renderDashboard(input: RenderDashboardInput): string {
  const tree = (
    <Dashboard
      state={input.state}
      sessions={input.sessions}
      errors={input.errors}
      costs={input.costs}
      renderedAt={input.renderedAt}
    />
  );
  return String(tree);
}
