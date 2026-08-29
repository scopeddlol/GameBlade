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
        --accent: #2f81f7;
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
          --accent: #0969da;
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

      /* Setup. Only ever drawn while this node has not enrolled. */
      .setup { border-color: var(--accent); }
      .setup h2 { color: var(--accent); }
      label { display: block; margin-bottom: 14px; }
      label span { display: block; margin-bottom: 5px; font-size: 13px; }
      label small { display: block; color: var(--muted); font-weight: 400; margin-top: 4px; }
      input {
        width: 100%;
        padding: 9px 11px;
        font: inherit;
        color: var(--text);
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 7px;
      }
      input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      button {
        font: inherit;
        font-weight: 600;
        color: #fff;
        background: var(--accent);
        border: 0;
        border-radius: 7px;
        padding: 9px 16px;
        cursor: pointer;
      }
      button[disabled] { opacity: 0.6; cursor: progress; }
      .msg { margin: 12px 0 0; font-size: 13px; }
      ol.steps { margin: 0 0 16px; padding-left: 20px; color: var(--muted); font-size: 13px; }
      ol.steps li { margin-bottom: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>GameBlade node</h1>
      <p class="sub">
        This machine holds game files and serves them to players directly. It has no
        catalog, no accounts and no settings of its own — those live on the coordinator.
      </p>

      ${setupPanel(status)}

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
      (function () {
        var form = document.getElementById('setup');
        var reloadIn = form ? 5000 : 15000;

        // The page is a status readout, so it goes stale the moment it is
        // drawn. Reloading beats asking somebody to press F5 to find out
        // whether the thing they are waiting for has happened. Faster while
        // setup is on screen, because that is somebody waiting rather than
        // somebody glancing.
        var timer = setTimeout(function () { location.reload(); }, reloadIn);

        if (!form) return;

        var message = document.getElementById('setup-msg');
        var button = form.querySelector('button');

        form.addEventListener('submit', function (event) {
          event.preventDefault();
          // Whatever happens next, a reload mid-request would throw away what
          // was typed and the answer at the same time.
          clearTimeout(timer);

          var body = {
            coordinatorUrl: form.elements.coordinatorUrl.value.trim(),
            enrolmentToken: form.elements.enrolmentToken.value.trim()
          };

          button.disabled = true;
          message.className = 'msg';
          message.textContent = 'Saving…';

          fetch('api/node/setup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          })
            .then(function (response) {
              return response.json().then(function (data) {
                return { ok: response.ok, data: data };
              });
            })
            .then(function (result) {
              if (!result.ok) throw new Error(
                (result.data && result.data.error && result.data.error.message) ||
                'The node refused that.'
              );
              message.className = 'msg ok';
              message.textContent =
                'Saved. Registering with the coordinator — this page will update by itself.';
              setTimeout(function () { location.reload(); }, 3000);
            })
            .catch(function (error) {
              message.className = 'msg bad';
              message.textContent = error.message;
              button.disabled = false;
              // Back to the slow refresh so a failed attempt is readable.
              timer = setTimeout(function () { location.reload(); }, 15000);
            });
        });
      })();
    </script>
  </body>
</html>
`;
}

/**
 * The setup form, drawn only while this node has not enrolled.
 *
 * Joining a node to a coordinator is two values entered once, and doing it
 * through the environment means editing a compose file on the machine with the
 * games on it and restarting the container — for something that is, in every
 * other respect, a first-run screen. So it is a first-run screen. It disappears
 * the moment the node is enrolled and does not come back.
 *
 * Two states, and they are told apart because they are fixed differently:
 * nothing entered yet, and entered but not yet accepted — a coordinator that is
 * down, an address with a typo in it, a code already spent. The second keeps
 * the form on screen with the reason above it rather than replacing it with a
 * spinner that never resolves.
 */
function setupPanel(status: NodeStatusSnapshot): string {
  if (status.enrolled) return '';

  const waiting = status.configured || status.enrolmentPending;

  const banner = waiting
    ? `<p class="msg warn"><span class="dot">●</span>Trying to enrol with
         ${status.coordinatorUrl ? `<code>${escapeHtml(status.coordinatorUrl)}</code>` : 'the coordinator'}.
         This page refreshes itself; if it stays here, check the address is reachable from this
         machine and that the code has not already been used.</p>`
    : '';

  return `
      <section class="setup">
        <h2>Set this node up</h2>
        <ol class="steps">
          <li>On the coordinator, open <strong>Admin → Settings → Nodes</strong>.</li>
          <li>Give the node a name, pick the role <strong>Origin</strong>, and press
              <strong>Generate code</strong>.</li>
          <li>Paste both below. The code is shown once and expires in 24 hours.</li>
        </ol>

        <form id="setup" autocomplete="off">
          <label>
            <span>Coordinator address</span>
            <input name="coordinatorUrl" type="url" required spellcheck="false"
                   placeholder="https://games.example.com"
                   value="${status.coordinatorUrl ? escapeHtml(status.coordinatorUrl) : ''}" />
            <small>Where players sign in. This machine has to be able to reach it.</small>
          </label>
          <label>
            <span>Enrolment code</span>
            <input name="enrolmentToken" type="text" required spellcheck="false"
                   placeholder="paste the code" />
            <small>Spent the moment this node registers, and not kept afterwards.</small>
          </label>
          <button type="submit">Connect this node</button>
          <p class="msg" id="setup-msg"></p>
        </form>
        ${banner}
      </section>
`;
}

/**
 * Where this node is in the one process that has states worth naming.
 *
 * Enrolment is the only thing that can leave a node running perfectly while
 * doing nothing at all, so it says which of those it is and what to do about
 * it. Once the setup form above exists, "not enrolled" points there rather than
 * naming an environment variable — the form is the answer, and it is on screen.
 */
function enrolment(status: NodeStatusSnapshot): string {
  if (status.enrolled) return '<span class="ok"><span class="dot">●</span>enrolled</span>';
  if (!status.keyPresent) {
    return '<span class="warn"><span class="dot">●</span>waiting for the mesh agent to generate this node’s key</span>';
  }
  if (status.configured || status.enrolmentPending) {
    return '<span class="warn"><span class="dot">●</span>registering…</span>';
  }
  return '<span class="warn"><span class="dot">●</span>not enrolled — fill in the setup form above</span>';
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
      : '<p class="empty bad">No library configured. The node image reads <code>/library</code>; mount the games there, read-only.</p>';
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
