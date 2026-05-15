/** @jsxImportSource hono/jsx */

/**
 * HTML shell for the monitor dashboard. SSR-only.
 *
 * Per [DD 2026-05-15 §4](../../../docs/superpowers/specs/2026-05-15-cc-monitor-dashboard-dd.md):
 * C1 = `<meta http-equiv="refresh" content="5">` — full-page reload
 * every 5 seconds. No client JS, no build step. User accepts the
 * 5s flicker on the "扫一眼" usage pattern.
 */

import type { FC, PropsWithChildren } from 'hono/jsx';

interface LayoutProps {
  title: string;
  /**
   * Refresh interval in seconds. Default 5. Pass 0 to disable
   * auto-refresh (useful for the JSON-only `/api/*` routes that bypass
   * Layout entirely; included here only for completeness).
   */
  refreshSeconds?: number;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = (props) => {
  const refresh = props.refreshSeconds ?? 5;
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title}</title>
        {refresh > 0 && (
          <meta http-equiv="refresh" content={String(refresh)} />
        )}
        <style>{`
          :root {
            color-scheme: light dark;
            --fg: #1a1a1a;
            --bg: #fafafa;
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
            padding: 1.5rem;
            max-width: 1100px;
          }
          h1 { font-size: 1.4rem; margin: 0 0 0.25rem 0; }
          h2 {
            font-size: 1rem;
            margin: 1.5rem 0 0.5rem 0;
            color: var(--muted);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; }
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
