/** @jsxImportSource hono/jsx */

/**
 * HTML shell for the monitor dashboard. SSR-only.
 *
 * Per [DD 2026-05-15 §6 revision (2026-05-15)](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md#6-revision-2026-05-15--manual-refresh--css-tabs):
 * the original C1 = `<meta refresh content="5">` was replaced after live
 * dogfooding: user prefers manual `↻ refresh` button + CSS-only tab nav
 * (no client JS, just `<input type="radio">` + `:checked ~` sibling
 * selector). Page reload now happens on user action only — data
 * freshness is user-driven, tab state lives in DOM radio inputs.
 */

import type { FC, PropsWithChildren } from 'hono/jsx';

interface LayoutProps {
  title: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title}</title>
        <style>{`
          :root {
            color-scheme: light dark;
            --fg: #1a1a1a;
            --bg: #fafafa;
            --bg-elev: #ffffff;
            --muted: #6b6b6b;
            --border: #d0d0d0;
            --accent: #2563eb;
            --error: #b91c1c;
            --ok: #16a34a;
            --warn: #d97706;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --fg: #e5e5e5;
              --bg: #1a1a1a;
              --bg-elev: #242424;
              --muted: #9b9b9b;
              --border: #3a3a3a;
              --accent: #60a5fa;
              --error: #f87171;
              --ok: #4ade80;
              --warn: #fbbf24;
            }
          }
          * { box-sizing: border-box; }
          body {
            font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI",
                  Helvetica, Arial, sans-serif;
            color: var(--fg);
            background: var(--bg);
            margin: 0;
            padding: 0;
          }
          .page { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
          h1 { font-size: 1.4rem; margin: 0 0 0.25rem 0; }
          .meta-row {
            color: var(--muted);
            font-size: 0.85rem;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }
          .meta-row .grow { flex: 1; }
          .refresh-btn {
            display: inline-block;
            padding: 0.3rem 0.75rem;
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--fg);
            background: var(--bg-elev);
            text-decoration: none;
            font-size: 0.85rem;
            font-weight: 500;
          }
          .refresh-btn:hover {
            border-color: var(--accent);
            color: var(--accent);
          }

          /* ===== Sticky daemon-state header ===== */
          .daemon-header {
            background: var(--bg-elev);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.75rem 1rem;
            margin-bottom: 1rem;
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem 1.25rem;
            align-items: center;
            font-size: 0.9rem;
          }
          .kv { display: inline-flex; gap: 0.4rem; align-items: center; }
          .kv-key { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
          .kv-val { color: var(--fg); }

          /* ===== Tabs (CSS radio hack: no JS) ===== */
          .tabs input[type="radio"] {
            position: absolute;
            opacity: 0;
            pointer-events: none;
          }
          .tab-nav {
            display: flex;
            gap: 0.25rem;
            border-bottom: 1px solid var(--border);
            margin-bottom: 1rem;
          }
          .tab-nav label {
            display: inline-block;
            padding: 0.5rem 1rem;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            color: var(--muted);
            font-size: 0.9rem;
            font-weight: 500;
            user-select: none;
          }
          .tab-nav label:hover { color: var(--fg); }
          .tab-nav .badge {
            display: inline-block;
            margin-left: 0.4rem;
            padding: 0.05rem 0.45rem;
            font-size: 0.75rem;
            background: color-mix(in srgb, var(--muted) 18%, transparent);
            border-radius: 9999px;
          }

          #tab-sessions:checked ~ .tab-nav label[for="tab-sessions"],
          #tab-cost:checked     ~ .tab-nav label[for="tab-cost"],
          #tab-errors:checked   ~ .tab-nav label[for="tab-errors"] {
            color: var(--fg);
            border-bottom-color: var(--accent);
            font-weight: 600;
          }

          .panel { display: none; }
          #tab-sessions:checked ~ .panels #panel-sessions,
          #tab-cost:checked     ~ .panels #panel-cost,
          #tab-errors:checked   ~ .panels #panel-errors {
            display: block;
          }

          /* ===== Tables (panel content) ===== */
          table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
          th, td {
            text-align: left;
            padding: 0.35rem 0.75rem;
            border-bottom: 1px solid var(--border);
          }
          th { font-weight: 600; color: var(--muted); }
          td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
          code { font: 0.85em ui-monospace, SFMono-Regular, Menlo, monospace; }
          .pill {
            display: inline-block;
            padding: 0.1rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
          }
          .pill-ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
          .pill-warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
          .pill-error { background: color-mix(in srgb, var(--error) 20%, transparent); color: var(--error); }
          .empty { color: var(--muted); font-style: italic; padding: 0.5rem 0; }
        `}</style>
      </head>
      <body>{props.children}</body>
    </html>
  );
};
