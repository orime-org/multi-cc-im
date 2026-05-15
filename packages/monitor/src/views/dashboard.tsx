/** @jsxImportSource hono/jsx */

/**
 * Top-level dashboard view. Composes:
 *   1. Sticky daemon-state header (always visible) — pid / uptime / terminal / IM
 *   2. Tab nav with 3 tabs: sessions / cost / errors
 *   3. Three tab panels, only the one whose radio is `:checked` displays
 *
 * SSR-only. **No client JS** — tab switching uses the CSS
 * `<input type="radio">` + sibling-combinator hack (see layout.tsx CSS).
 * Data freshness is user-driven: click `↻ refresh` (or browser reload)
 * to fetch new state. Per
 * [DD 2026-05-15 §6 revision](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md#6-revision-2026-05-15--manual-refresh--css-tabs).
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
    <div class="page">
      <h1>multi-cc-im monitor</h1>
      <div class="meta-row">
        <span>rendered {props.renderedAt}</span>
        <span class="grow" />
        <a href="/" class="refresh-btn">↻ refresh</a>
      </div>

      <DaemonStateView state={props.state} />

      <div class="tabs">
        {/* Radio inputs MUST be siblings of .tab-nav + .panels for the
            `:checked ~` sibling selector to resolve. Default = sessions. */}
        <input type="radio" name="tab" id="tab-sessions" checked />
        <input type="radio" name="tab" id="tab-cost" />
        <input type="radio" name="tab" id="tab-errors" />

        <nav class="tab-nav">
          <label for="tab-sessions">
            sessions<span class="badge">{props.sessions.length}</span>
          </label>
          <label for="tab-cost">
            cost<span class="badge">{props.costs.length}</span>
          </label>
          <label for="tab-errors">
            errors<span class="badge">{props.errors.length}</span>
          </label>
        </nav>

        <div class="panels">
          <section id="panel-sessions" class="panel">
            <SessionsTable sessions={props.sessions} />
          </section>
          <section id="panel-cost" class="panel">
            <CostTable costs={props.costs} />
          </section>
          <section id="panel-errors" class="panel">
            <ErrorsTable errors={props.errors} />
          </section>
        </div>
      </div>
    </div>
  </Layout>
);
