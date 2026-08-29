import type { NodeStatusSnapshot } from '../services/nodeStatus.js';

/**
 * The page a node serves about itself.
 *
 * Written out here as one string rather than built by the SPA toolchain, and
 * that is the whole point of it. A node has no accounts, no settings and no
 * catalog of record, so shipping it the admin bundle would mean shipping an
 * admin panel over an empty database — a second, wrong copy of the panel the
 * coordinator owns, complete with its own "create the first administrator"
 * screen. This is a few kilobytes of HTML that says what this machine is and
 * whether it is working, which is all a node has to say.
 *
 * No scripts beyond the one that refreshes it, no fonts, no requests anywhere:
 * a page about whether the network is reachable must render when it is not.
 */
export function renderNodePage(status: NodeStatusSnapshot): string {
  const link = status.coordinatorUrl
    ? `<a href="${escapeHtml(status.coordinatorUrl)}">${escapeHtml(status.coordinatorUrl)}</a>`
    : '<span class="bad">not configured</span>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>GameBlade node</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0e1116;
        --raised: #161b22;
        --border: #262d36;
        --text: #e6edf3;
        --muted: #8b949e;
        --ok: #3fb950;
        --warn: #d29922;
        --bad: #f85149;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f6f8fa;
          --raised: #fff;
          --border: #d0d7de;
          --text: #1f2328;
          --muted: #656d76;
          --ok: #1a7f37;
          --warn: #9a6700;
          --bad: #cf222e;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 32px 20px 64px;
        background: var(--bg);
        color: var(--text);
        font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      main { max-width: 760px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
      .sub { color: var(--muted); margin: 0 0 28px; font-size: 14px; }
      section {
        background: var(--raised);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 16px 18px;
        margin-bottom: 14px;
      }
      h2 {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--muted);
        margin: 0 0 12px;
      }
      dl { display: grid; grid-template-columns: minmax(140px, auto) 1fr; gap: 8px 20px; margin: 0; }
      dt { color: var(--muted); }
      dd { margin: 0; overflow-wrap: anywhere; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.92em; }
      .ok { color: var(--ok); }
      .warn { color: var(--warn); }
      .bad { color: var(--bad); }
      .dot { font-size: 11px; vertical-align: 1px; margin-right: 5px; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; color: var(--muted); font-weight: 500; font-size: 13px; }
      th, td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--border); }
      tr:last-child th, tr:last-child td { border-bottom: 0; }
      .empty { color: var(--muted); margin: 0; }
      footer { color: var(--muted); font-size: 13px; text-align: center; margin-top: 26px; }
      a { color: inherit; }
    </style>
  </head>
  <body>
    <main>
      <h1>GameBlade node</h1>
      <p class="sub">
        This machine holds game files and serves them to players directly. It has no
        catalog, no accounts and no settings of its own — those live on the coordinator.
      </p>

      <section>
        <h2>Coordinator</h2>
        <dl>
          <dt>Reports to</dt><dd>${link}</dd>
          <dt>Enrolment</dt><dd>${enrolment(status)}</dd>
          <dt>Node ID</dt>
          <dd>${status.nodeId ? `<code>${escapeHtml(status.nodeId)}</code>` : '<span class="muted">—</span>'}</dd>
          <dt>Last report</dt><dd>${lastReport(status)}</dd>
        </dl>
      </section>

      <section>
        <h2>Library</h2>
        ${libraryTable(status)}
      </section>

      <section>
        <h2>Serving</h2>
        <dl>
          <dt>Games held</dt><dd>${status.games.toLocaleString('en')}</dd>
          <dt>Files hashed</dt><dd>${hashed(status)}</dd>
          <dt>Scan</dt>
          <dd>${status.scanning ? '<span class="warn"><span class="dot">●</span>running</span>' : 'idle'}</dd>
        </dl>
      </section>

      <footer>
        GameBlade ${escapeHtml(status.version)} · ${escapeHtml(status.role)} ·
        up since ${escapeHtml(status.startedAt)}
      </footer>
    </main>
    <script>
      // The page is a status readout, so it goes stale the moment it is drawn.
      // Reloading beats asking somebody to press F5 to find out whether the
      // thing they are waiting for has happened yet.
      setTimeout(function () { location.reload(); }, 15000);
    </script>
  </body>
</html>
`;
}

/**
 * Where this node is in the one process that has states worth naming.
 *
 * Enrolment is the only thing an operator has to do to a node by hand, and the
 * only thing that can leave it running perfectly while doing nothing at all —
 * so it says which of those it is, and what to do about it.
 */
function enrolment(status: NodeStatusSnapshot): string {
  if (status.enrolled) return '<span class="ok"><span class="dot">●</span>enrolled</span>';
  if (!status.keyPresent) {
    return '<span class="warn"><span class="dot">●</span>waiting for the mesh agent to generate this node’s key</span>';
  }
  return '<span class="warn"><span class="dot">●</span>not enrolled — set <code>ENROLMENT_TOKEN</code> to a code from Admin → Settings → Nodes</span>';
}

function lastReport(status: NodeStatusSnapshot): string {
  const report = status.lastReport;
  if (!report) return '<span class="muted">nothing sent yet</span>';

  const tone = report.ok ? 'ok' : 'bad';
  const what = report.ok
    ? `${report.games.toLocaleString('en')} games accepted`
    : escapeHtml(report.detail);

  return `<span class="${tone}"><span class="dot">●</span>${what}</span> · ${escapeHtml(report.at)}`;
}

function hashed(status: NodeStatusSnapshot): string {
  if (status.totalFiles === 0) return '<span class="muted">—</span>';

  const done = status.hashedFiles === status.totalFiles;
  const counts = `${status.hashedFiles.toLocaleString('en')} of ${status.totalFiles.toLocaleString('en')}`;

  // Unhashed files are not a fault, they are work still queued — but they are
  // also the reason a game nobody can explain refuses to come from this node,
  // so the number is worth showing rather than a tick.
  return done
    ? `<span class="ok"><span class="dot">●</span>${counts}</span>`
    : `${counts} <span class="muted">— only hashed files can be served over the mesh</span>`;
}

function libraryTable(status: NodeStatusSnapshot): string {
  if (status.libraries.length === 0) {
    const configured = status.configuredPaths.length > 0;
    return configured
      ? `<p class="empty">Nothing scanned yet from <code>${status.configuredPaths.map(escapeHtml).join('</code>, <code>')}</code>.</p>`
      : '<p class="empty bad">No library configured. Set <code>LIBRARY_PATHS</code> and mount the games read-only.</p>';
  }

  const rows = status.libraries
    .map(
      (library) => `
          <tr>
            <td>${escapeHtml(library.name)}<br /><code class="muted">${escapeHtml(library.path)}</code></td>
            <td>${library.games.toLocaleString('en')}</td>
            <td>${library.lastScanAt ? escapeHtml(library.lastScanAt) : '<span class="muted">never</span>'}</td>
          </tr>`,
    )
    .join('');

  return `<table>
          <tr><th>Library</th><th>Games</th><th>Last scan</th></tr>${rows}
        </table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
