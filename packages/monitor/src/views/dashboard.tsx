/** @jsxImportSource hono/jsx */

/**
 * Top-level dashboard view. Composes the four panels:
 *   1. Daemon state header (PID / uptime / IM connection)
 *   2. cc sessions table (one row per pane / tab)
 *   3. Recent errors (rolling ring buffer)
 *   4. Per-session cost (LiteLLM-priced)
 *
 * SSR-only. Refresh every 5s via Layout's `<meta refresh>` (DD §4 C1).
 */

import type { FC } from 'hono/jsx';
import { Layout } from './layout.js';
import { DaemonStateView } from './daemon-state.js';
import { SessionsTable } from './sessions-table.js';
import { ErrorsTable } from './errors-table.js';
import { CostTable } from './cost-table.js';
import type {
  DaemonStateSnapshot,
  ErrorEntry,
  SessionCost,
  SessionSnapshot,
} from '../types.js';

export interface DashboardProps {
  state: DaemonStateSnapshot;
  sessions: SessionSnapshot[];
  errors: ErrorEntry[];
  costs: SessionCost[];
  /** Rendered "as-of" timestamp for the page header. */
  renderedAt: string;
}

export const Dashboard: FC<DashboardProps> = (props) => (
  <Layout title="multi-cc-im monitor">
    <h1>multi-cc-im monitor</h1>
    <div class="meta">
      rendered {props.renderedAt} · auto-refresh every 5s
    </div>

    <DaemonStateView state={props.state} />

    <h2>cc sessions ({props.sessions.length})</h2>
    <SessionsTable sessions={props.sessions} />

    <h2>cost (cc transcript jsonl)</h2>
    <CostTable costs={props.costs} />

    <h2>recent errors ({props.errors.length})</h2>
    <ErrorsTable errors={props.errors} />
  </Layout>
);
