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
 * No fonts and no requests anywhere but back to this node: a page about whether
 * the network is reachable must render when it is not.
 *
 * The one script it needs is served as a file rather than inlined. It used to
 * be inline, and the content security policy this server sets on every response
 * says `script-src 'self'` — so the browser dropped it, silently, and the page
 * neither refreshed itself nor did anything at all when somebody pressed
 * "Connect this node". Nothing was logged anywhere except the browser console,
 * on the one screen an operator reaches before anything else works.
 */
export function renderNodePage(status: NodeStatusSnapshot, basePath = ''): string {
  const link = status.coordinatorUrl
    ? `<a href="${escapeHtml(status.coordinatorUrl)}">${escapeHtml(status.coordinatorUrl)}</a>`
    : '<span class="bad">not configured</span>';

  // Absolute, so every request works from whatever URL this page was reached
  // at — including the 404 handler, which serves it at paths that do not exist.
  const asset = (name: string) => escapeHtml(`${basePath}/${name}`);

  return `<!doctype html>
<html lang="en" data-base="${escapeHtml(basePath)}" data-refresh="${refreshInterval(status)}">
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
      main { max-width: 820px; margin: 0 auto; }
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
      .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      dl { display: grid; grid-template-columns: minmax(140px, auto) 1fr; gap: 8px 20px; margin: 0; }
      dt { color: var(--muted); }
      dd { margin: 0; overflow-wrap: anywhere; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.92em; }
      .ok { color: var(--ok); }
      .warn { color: var(--warn); }
      .bad { color: var(--bad); }
      .muted { color: var(--muted); }
      .dot { font-size: 11px; vertical-align: 1px; margin-right: 5px; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; color: var(--muted); font-weight: 500; font-size: 13px; }
      th, td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
      tr:last-child th, tr:last-child td { border-bottom: 0; }
      td.num { text-align: right; white-space: nowrap; }
      .empty { color: var(--muted); margin: 0; }
      footer { color: var(--muted); font-size: 13px; text-align: center; margin-top: 26px; }
      a { color: inherit; }

      .note {
        margin: 12px 0 0;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .note code { color: var(--text); }
      .note pre { margin: 8px 0 0; white-space: pre-wrap; color: var(--text); }

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
      button.ghost {
        color: var(--text);
        background: transparent;
        border: 1px solid var(--border);
        font-weight: 500;
      }
      button[disabled] { opacity: 0.6; cursor: not-allowed; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
      .msg { margin: 12px 0 0; font-size: 13px; }
      ol.steps { margin: 0 0 16px; padding-left: 20px; color: var(--muted); font-size: 13px; }
      ol.steps li { margin-bottom: 4px; }

      .bar {
        height: 6px;
        border-radius: 3px;
        background: var(--border);
        overflow: hidden;
        margin: 8px 0 4px;
      }
      .bar > i { display: block; height: 100%; background: var(--accent); }
      .job { margin-bottom: 18px; }
      .job:last-child { margin-bottom: 0; }
      .job h3 { font-size: 14px; margin: 0 0 2px; }
      .job p { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
      /* The live readout under the hashing bar. Monospaced paths, because a
         file name is the one thing here somebody may want to copy exactly. */
      .hashing-now { font-size: 12px; line-height: 1.7; margin: 0 0 8px; }
      .hashing-now code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all;
        color: var(--fg);
      }
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
        <h2>Libraries</h2>
        ${libraryTable(status)}
        ${mountHint(status)}
      </section>

      <section>
        <h2>Getting this library ready</h2>
        ${jobs(status)}
        <p class="msg" id="job-msg"></p>
      </section>

      <section>
        <h2>Serving</h2>
        <dl>
          <dt>Games held</dt><dd>${status.games.toLocaleString('en')} · ${formatBytes(status.bytes)}</dd>
          <dt>Ready to serve</dt><dd>${servable(status)}</dd>
          <dt>Files hashed</dt><dd>${hashed(status)}</dd>
        </dl>
      </section>

      <footer>
        GameBlade ${escapeHtml(status.version)} · ${escapeHtml(status.role)} ·
        up since ${escapeHtml(status.startedAt)}
      </footer>
    </main>
    <script src="${asset('node.js')}"></script>
  </body>
</html>
`;
}

/**
 * The page's behaviour, served as a file.
 *
 * A file rather than an inline block because the content security policy on
 * every response from this server is `script-src 'self'`, which drops an inline
 * script without a word to anyone but the browser console. That is how the
 * setup form came to do nothing at all when it was submitted.
 */
export const NODE_PAGE_SCRIPT = `(function () {
  var base = document.documentElement.getAttribute('data-base') || '';
  var refreshIn = Number(document.documentElement.getAttribute('data-refresh')) || 15000;
  var form = document.getElementById('setup');
  var initialSetup = form ? {
    coordinatorUrl: form.elements.coordinatorUrl.value,
    enrolmentToken: form.elements.enrolmentToken.value
  } : null;
  var timer;

  function setupInProgress() {
    if (!form || !initialSetup) return false;

    // A status refresh must never steal focus or throw away an enrolment code.
    // Compare with what the server rendered so a saved coordinator URL does
    // not pause refreshes by itself while the node is still registering.
    return form.contains(document.activeElement) ||
      form.elements.coordinatorUrl.value !== initialSetup.coordinatorUrl ||
      form.elements.enrolmentToken.value !== initialSetup.enrolmentToken;
  }

  function scheduleRefresh(delay) {
    clearTimeout(timer);
    timer = setTimeout(function refreshWhenIdle() {
      if (setupInProgress()) {
        timer = setTimeout(refreshWhenIdle, 1000);
        return;
      }
      location.reload();
    }, delay);
  }

  // The page is a status readout, so it goes stale the moment it is drawn.
  // Reloading beats asking somebody to press F5 to find out whether the thing
  // they are waiting for has happened. The interval comes from the server,
  // which knows whether anything is currently moving.
  scheduleRefresh(refreshIn);

  function post(path, onDone) {
    clearTimeout(timer);
    return fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(
            (result.data && result.data.error && result.data.error.message) ||
            'The node refused that.'
          );
        }
        return result.data;
      })
      .then(function (data) { onDone(null, data); })
      .catch(function (error) { onDone(error); });
  }

  /* ------------------------------------------------------------ scan / hash */

  var jobMessage = document.getElementById('job-msg');

  function say(text, tone) {
    if (!jobMessage) return;
    jobMessage.className = 'msg' + (tone ? ' ' + tone : '');
    jobMessage.textContent = text;
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-post]'), function (button) {
    button.addEventListener('click', function () {
      var path = button.getAttribute('data-post');
      button.disabled = true;
      say(button.getAttribute('data-busy') || 'Working…');

      post(path, function (error, data) {
        if (error) {
          say(error.message, 'bad');
          button.disabled = false;
          scheduleRefresh(8000);
          return;
        }
        say((data && data.message) || 'Done.', 'ok');
        // Straight away rather than on the next tick: the whole point of
        // pressing this was to watch it start.
        setTimeout(function () { location.reload(); }, 600);
      });
    });
  });

  /* ----------------------------------------------------------------- setup */

  if (!form) return;

  var message = document.getElementById('setup-msg');
  var button = form.querySelector('button');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    // Whatever happens next, a reload mid-request would throw away what was
    // typed and the answer at the same time.
    clearTimeout(timer);

    var body = {
      coordinatorUrl: form.elements.coordinatorUrl.value.trim(),
      enrolmentToken: form.elements.enrolmentToken.value.trim()
    };

    button.disabled = true;
    message.className = 'msg';
    message.textContent = 'Saving…';

    fetch(base + '/api/node/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
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
        scheduleRefresh(15000);
      });
  });
})();
`;

/**
 * How soon the page should draw itself again.
 *
 * Fast while something is moving — a scan, a hashing pass, somebody at the
 * setup form waiting for it to go green — and slow when the answer is not going
 * to change. A fixed interval has to be one or the other.
 */
function refreshInterval(status: NodeStatusSnapshot): number {
  if (status.scanning || status.hashing.running) return 3000;
  if (!status.enrolled) return 5000;
  return 15000;
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

  const banner = status.enrolmentError
    ? `<p class="msg bad"><span class="dot">●</span>${escapeHtml(status.enrolmentError)}</p>`
    : waiting
      ? `<p class="msg warn"><span class="dot">●</span>Trying to enrol with
         ${status.coordinatorUrl ? `<code>${escapeHtml(status.coordinatorUrl)}</code>` : 'the coordinator'}.
         This page refreshes itself; if it stays here, check the address is reachable from this
         machine and that the code has not already been used.</p>`
      : '';

  return `
      <section class="setup">
        <h2>Set this node up</h2>
        <ol class="steps">
          <li>On the coordinator, open <strong>Admin → Nodes</strong>.</li>
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
  if (status.enrolmentError) {
    return '<span class="bad"><span class="dot">●</span>enrolment failed — correct the form above and try again</span>';
  }
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

/**
 * The two pieces of work between a mounted drive and a servable library.
 *
 * Both used to happen only on timers, which is right for a node that has been
 * running for a month and badly wrong for one somebody has just plugged in:
 * the first scan waits, then hours of hashing start on their own schedule, and
 * the only way to know any of it is happening was `docker logs`. These are the
 * same two passes, startable now, with the numbers on screen.
 */
function jobs(status: NodeStatusSnapshot): string {
  const scan = status.scan;
  const scanning = status.scanning;

  const scanDetail = scanning
    ? `${escapeHtml(scanPhase(status))}${
        scan.total > 0
          ? ` — ${scan.processed.toLocaleString('en')} of ${scan.total.toLocaleString('en')}`
          : ''
      }`
    : scan.finishedAt
      ? `Last run finished ${escapeHtml(scan.finishedAt)} · ${scan.added} added, ${scan.updated} updated, ${scan.removed} missing`
      : 'Not run yet since this node started.';

  const hashing = status.hashing;
  const hashDone = hashing.total - hashing.remaining;
  const hashDetail = hashing.running
    ? `${hashDone.toLocaleString('en')} of ${hashing.total.toLocaleString('en')} games${
        hashing.stopping ? ' — stopping after this one' : ''
      }`
    : hashing.finishedAt
      ? `Last pass hashed ${hashing.hashed.toLocaleString('en')}${
          hashing.failed > 0 ? `, failed ${hashing.failed.toLocaleString('en')}` : ''
        }${hashing.note ? ` (${escapeHtml(hashing.note)})` : ''} · ${escapeHtml(hashing.finishedAt)}`
      : 'Not run yet since this node started.';

  return `
        <div class="job">
          <h3>Scan the libraries</h3>
          <p>Walks every mounted root and works out what games are here. Picks up new
             mounts too, so a drive attached after this container started is found without
             restarting it.</p>
          ${scanning ? progressBar(scan.processed, scan.total) : ''}
          <p>${scanDetail}</p>
          <div class="actions">
            <button type="button" data-post="/api/node/scan" data-busy="Starting the scan…"
                    ${scanning ? 'disabled' : ''}>
              ${scanning ? 'Scanning…' : 'Scan now'}
            </button>
            ${
              scanning
                ? `<button type="button" class="ghost" data-post="/api/node/scan/cancel"
                        data-busy="Stopping…" ${scan.canceling ? 'disabled' : ''}>
                     ${scan.canceling ? 'Stopping…' : 'Stop the scan'}
                   </button>`
                : ''
            }
          </div>
        </div>

        <div class="job">
          <h3>Hash the files</h3>
          <p>Reads every ZIP package and records a hash per 10 MiB piece. Nothing on
             this node can be served over the mesh until its game is hashed, and on a real
             archive the first pass takes hours — so it is worth starting now rather than
             waiting for the timer.</p>
          ${
            hashing.running
              ? progressBar(hashing.bytesHashed, hashing.bytesTotal) + hashingNow(status)
              : ''
          }
          <p>${hashDetail}</p>
          <div class="actions">
            <button type="button" data-post="/api/node/hash" data-busy="Starting the pass…"
                    ${hashing.running ? 'disabled' : ''}>
              ${hashing.running ? 'Hashing…' : 'Hash everything now'}
            </button>
            ${
              hashing.running
                ? `<button type="button" class="ghost" data-post="/api/node/hash/cancel"
                        data-busy="Stopping…" ${hashing.stopping ? 'disabled' : ''}>
                     ${hashing.stopping ? 'Stopping…' : 'Stop after this game'}
                   </button>`
                : ''
            }
          </div>
        </div>
`;
}

function scanPhase(status: NodeStatusSnapshot): string {
  const scan = status.scan;
  const where =
    scan.libraryCount > 1 && scan.library
      ? `${scan.library} (${scan.libraryIndex} of ${scan.libraryCount})`
      : (scan.library ?? 'library');

  if (scan.phase === 'reading') return `Reading ${where}`;
  if (scan.phase === 'indexing') return `Indexing ${where}`;
  if (scan.phase === 'matching') return 'Fetching metadata';
  return 'Working';
}

function progressBar(done: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return `<div class="bar"><i style="width:${percent}%"></i></div>`;
}

/**
 * What the hashing pass is actually doing this second.
 *
 * The bar above is a percentage of a number nobody can feel. This is the part
 * an operator was reading `docker logs` for: the title being read, the files
 * open inside it, how fast the bytes are coming off the disk, and how long
 * that leaves. All of it is already in memory; none of it was on screen.
 */
function hashingNow(status: NodeStatusSnapshot): string {
  const sweep = status.hashing;
  const game = status.hashingGame;

  const title = sweep.currentGameTitle ?? game.gameTitle;
  const lines: string[] = [];

  if (title) {
    const within =
      game.total > 0
        ? ` — file ${Math.min(game.processed + 1, game.total).toLocaleString('en')} of ${game.total.toLocaleString('en')}`
        : '';
    lines.push(`<strong>${escapeHtml(title)}</strong>${within}`);
  }

  for (const file of game.currentFiles.slice(0, 4)) {
    lines.push(`<code>${escapeHtml(file)}</code>`);
  }
  if (game.currentFiles.length > 4) {
    lines.push(`<span class="muted">and ${game.currentFiles.length - 4} more</span>`);
  }

  const rate = sweep.bytesPerSecond > 0 ? `${formatBytes(sweep.bytesPerSecond)}/s` : null;
  const done = `${formatBytes(sweep.bytesHashed)} of ${formatBytes(sweep.bytesTotal)}`;
  const eta = sweep.etaSeconds === null ? null : `${formatDuration(sweep.etaSeconds)} left`;
  const workers = `${game.concurrency} at a time${game.threaded ? '' : ' (in-process)'}`;

  lines.push(
    `<span class="muted">${[done, rate, eta, workers].filter(Boolean).join(' · ')}</span>`,
  );

  return `<div class="hashing-now">${lines.join('<br>')}</div>`;
}

function servable(status: NodeStatusSnapshot): string {
  if (status.games === 0) return '<span class="muted">—</span>';

  const counts = `${status.servableGames.toLocaleString('en')} of ${status.games.toLocaleString('en')} games`;
  if (status.servableGames === status.games) {
    return `<span class="ok"><span class="dot">●</span>${counts}</span>`;
  }
  return `${counts} <span class="muted">— the rest are still waiting to be hashed</span>`;
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
      : `<p class="empty bad">No library is mounted. Mount your games read-only at
           <code>/library</code>, or one per drive under
           <code>${escapeHtml(status.multiLibraryRoot)}</code>.</p>`;
  }

  const rows = status.libraries
    .map(
      (library) => `
          <tr>
            <td>${escapeHtml(library.name)}${mountBadge(library)}<br />
                <code class="muted">${escapeHtml(library.path)}</code></td>
            <td class="num">${library.games.toLocaleString('en')}</td>
            <td class="num">${formatBytes(library.bytes)}</td>
            <td>${library.lastScanAt ? escapeHtml(library.lastScanAt) : '<span class="muted">never</span>'}</td>
          </tr>`,
    )
    .join('');

  return `<table>
          <tr><th>Library</th><th class="num">Games</th><th class="num">Size</th><th>Last scan</th></tr>${rows}
        </table>`;
}

function mountBadge(library: NodeStatusSnapshot['libraries'][number]): string {
  if (library.mounted) return '';
  return ' <span class="bad">· not mounted</span>';
}

/**
 * How to add another drive, said where somebody is looking at the first one.
 *
 * Worth its own paragraph because the failure it prevents is silent: two
 * volumes mounted at the same `/library` is a compose file Docker accepts and
 * a node that reads one of them, so the operator sees half a library and no
 * error anywhere. Only shown while it is still news — a node already holding
 * several roots has clearly worked it out.
 */
function mountHint(status: NodeStatusSnapshot): string {
  if (!status.pathsDiscovered || status.libraries.length > 1) return '';

  return `<div class="note">
          <strong>Holding more than one drive?</strong> Mount each one under
          <code>${escapeHtml(status.multiLibraryRoot)}</code> — the directory name becomes the
          library's name — and restart the container. Two volumes mounted at the same
          <code>/library</code> is not an error to Docker; it simply keeps one of them.
          <pre>volumes:
  - /mnt/3TB:${escapeHtml(status.multiLibraryRoot)}/3TB:ro
  - /mnt/E:${escapeHtml(status.multiLibraryRoot)}/E:ro</pre>
        </div>`;
}

/** A duration in seconds as hours and minutes, for the hashing estimate. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Bytes, at the precision a person reads rather than the one a disk reports. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value.toFixed(power === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[power]}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
