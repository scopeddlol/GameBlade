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
        --bg: #080a0f;
        --raised: rgba(20, 23, 31, 0.9);
        --raised-strong: #171a23;
        --soft: #202430;
        --border: rgba(255, 255, 255, 0.09);
        --border-strong: rgba(255, 255, 255, 0.16);
        --text: #f5f6fa;
        --muted: #969baa;
        --ok: #5ee8a2;
        --warn: #ffc96b;
        --bad: #ff7c86;
        --accent: #a78bfa;
        --accent-strong: #8b5cf6;
        --accent-soft: rgba(139, 92, 246, 0.14);
        --blue: #6eb7ff;
        --shadow: 0 24px 70px rgba(0, 0, 0, 0.26);
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f5f4f8;
          --raised: rgba(255, 255, 255, 0.92);
          --raised-strong: #fff;
          --soft: #efedf5;
          --border: rgba(34, 25, 54, 0.1);
          --border-strong: rgba(34, 25, 54, 0.18);
          --text: #201a2b;
          --muted: #706a7b;
          --ok: #087a46;
          --warn: #9b5f00;
          --bad: #c52d3b;
          --accent: #7047c8;
          --accent-strong: #6136ba;
          --accent-soft: rgba(112, 71, 200, 0.1);
          --blue: #1769aa;
          --shadow: 0 24px 70px rgba(50, 36, 74, 0.1);
        }
      }
      * { box-sizing: border-box; }
      html { min-height: 100%; }
      body {
        margin: 0;
        min-height: 100vh;
        padding: 0 20px 56px;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
        background-image:
          radial-gradient(circle at 12% -8%, rgba(139, 92, 246, 0.22), transparent 32rem),
          radial-gradient(circle at 90% 5%, rgba(46, 132, 255, 0.12), transparent 27rem);
        background-attachment: fixed;
      }
      main { max-width: 1160px; margin: 0 auto; }
      .topbar {
        min-height: 76px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--border);
      }
      .brand, .top-status, .hero-line, .metric-head, .panel-head, .path,
      .file-main, .file-actions, .backup-main { display: flex; align-items: center; }
      .brand { gap: 11px; font-weight: 750; letter-spacing: -0.02em; }
      .mark {
        width: 31px; height: 31px; border-radius: 10px; display: grid; place-items: center;
        color: white; font-size: 16px; background: linear-gradient(145deg, #b7a2ff, #6d3fe0);
        box-shadow: 0 9px 28px rgba(124, 79, 220, 0.35);
      }
      .top-status { gap: 9px; color: var(--muted); font-size: 12px; }
      .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 5px rgba(94,232,162,.1); }
      .hero { padding: 42px 0 28px; }
      .hero-line { justify-content: space-between; gap: 24px; align-items: flex-end; }
      .eyebrow { margin: 0 0 6px; color: var(--accent); font-weight: 750; font-size: 11px; text-transform: uppercase; letter-spacing: .14em; }
      h1 { font-size: clamp(30px, 5vw, 48px); line-height: 1.05; margin: 0; letter-spacing: -0.055em; }
      .sub { color: var(--muted); margin: 13px 0 0; max-width: 660px; font-size: 15px; }
      .node-id { color: var(--muted); font-size: 12px; text-align: right; }
      .node-id code { display: block; color: var(--text); margin-top: 4px; }
      .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
      .metric { padding: 17px 18px; border-radius: 16px; background: var(--raised); border: 1px solid var(--border); box-shadow: var(--shadow); }
      .metric-head { gap: 8px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
      .metric-icon { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
      .metric strong { display: block; font-size: 23px; line-height: 1.2; margin-top: 10px; letter-spacing: -.035em; }
      .metric small { color: var(--muted); }
      .tabs { display: flex; gap: 5px; margin: 0 0 16px; padding: 5px; width: fit-content; border-radius: 13px; background: var(--raised); border: 1px solid var(--border); }
      .tab { color: var(--muted); background: transparent; border: 0; box-shadow: none; padding: 8px 14px; }
      .tab.active { color: var(--text); background: var(--soft); }
      .tab-panel { display: none; }
      .tab-panel.active { display: block; animation: enter .18s ease-out; }
      @keyframes enter { from { opacity: .4; transform: translateY(3px); } }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      section {
        background: var(--raised);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 21px 22px;
        margin-bottom: 14px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }
      h2 {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--muted);
        margin: 0;
      }
      .panel-head { justify-content: space-between; gap: 16px; margin-bottom: 17px; }
      .panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
      .panel-head h2 + p { margin-top: 5px; }
      dl { display: grid; grid-template-columns: minmax(120px, auto) 1fr; gap: 10px 20px; margin: 0; }
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
      th, td { padding: 10px 10px 10px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
      tr:last-child th, tr:last-child td { border-bottom: 0; }
      td.num { text-align: right; white-space: nowrap; }
      .empty { color: var(--muted); margin: 0; }
      footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 30px; }
      a { color: var(--blue); text-decoration: none; }
      a:hover { text-decoration: underline; }

      .note {
        margin: 12px 0 0;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        color: var(--muted);
        font-size: 13px;
      }
      .note code { color: var(--text); }
      .note pre { margin: 8px 0 0; white-space: pre-wrap; color: var(--text); }

      /* Setup. Only ever drawn while this node has not enrolled. */
      .setup { border-color: rgba(167,139,250,.55); background: linear-gradient(145deg, var(--raised), var(--accent-soft)); }
      .setup h2 { color: var(--accent); }
      label { display: block; margin-bottom: 14px; }
      label span { display: block; margin-bottom: 5px; font-size: 13px; }
      label small { display: block; color: var(--muted); font-weight: 400; margin-top: 4px; }
      input, select {
        width: 100%;
        padding: 10px 12px;
        font: inherit;
        color: var(--text);
        background: var(--soft);
        border: 1px solid var(--border);
        border-radius: 10px;
      }
      input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button {
        font: inherit;
        font-weight: 600;
        color: #fff;
        background: var(--accent-strong);
        border: 0;
        border-radius: 10px;
        padding: 9px 14px;
        cursor: pointer;
        transition: transform .15s ease, border-color .15s ease, background .15s ease;
      }
      button:hover:not([disabled]) { transform: translateY(-1px); }
      button.ghost {
        color: var(--text);
        background: var(--soft);
        border: 1px solid var(--border);
        font-weight: 500;
      }
      button.danger { color: var(--bad); }
      button.small { padding: 6px 9px; border-radius: 8px; font-size: 12px; }
      button[disabled] { opacity: 0.6; cursor: not-allowed; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
      .msg { margin: 12px 0 0; font-size: 13px; }
      ol.steps { margin: 0 0 16px; padding-left: 20px; color: var(--muted); font-size: 13px; }
      ol.steps li { margin-bottom: 4px; }

      .bar {
        height: 7px;
        border-radius: 20px;
        background: var(--soft);
        overflow: hidden;
        margin: 10px 0 6px;
      }
      .bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-strong), #5ab5ff); border-radius: inherit; }
      .job { margin-bottom: 21px; padding-bottom: 21px; border-bottom: 1px solid var(--border); }
      .job:last-child { margin-bottom: 0; }
      .job:last-child { padding-bottom: 0; border-bottom: 0; }
      .job h3 { font-size: 15px; margin: 0 0 3px; }
      .job p { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
      /* The live readout under the hashing bar. Monospaced paths, because a
         file name is the one thing here somebody may want to copy exactly. */
      .hashing-now { font-size: 12px; line-height: 1.7; margin: 0 0 8px; }
      .hashing-now code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all;
        color: var(--text);
      }
      .browser-toolbar { display: grid; grid-template-columns: minmax(180px, .7fr) minmax(220px, 1fr); gap: 10px; margin-bottom: 12px; }
      .filters { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
      .filter { color: var(--muted); background: transparent; border: 1px solid var(--border); padding: 6px 10px; font-size: 12px; }
      .filter.active { color: var(--text); background: var(--accent-soft); border-color: rgba(167,139,250,.35); }
      .path { gap: 8px; margin-bottom: 12px; color: var(--muted); font-size: 12px; min-width: 0; }
      .path code { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .file-list, .backup-list { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: rgba(0,0,0,.06); }
      .file-row, .backup-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 13px 14px; border-bottom: 1px solid var(--border); }
      .file-row:last-child, .backup-row:last-child { border-bottom: 0; }
      .file-main, .backup-main { gap: 12px; min-width: 0; }
      .file-icon { width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 10px; background: var(--soft); color: var(--muted); font-size: 16px; }
      .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 620; }
      .file-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
      .file-actions { gap: 7px; }
      .badge { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 99px; padding: 2px 7px; margin-left: 6px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; vertical-align: 1px; }
      .badge.approved { color: var(--ok); border-color: rgba(94,232,162,.25); background: rgba(94,232,162,.07); }
      .badge.ignored { color: var(--bad); border-color: rgba(255,124,134,.25); background: rgba(255,124,134,.07); }
      .browser-empty { padding: 38px 20px; text-align: center; color: var(--muted); }
      .backup-copy { min-width: 0; }
      .backup-copy strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .backup-copy span { color: var(--muted); font-size: 12px; }
      .backup-callout { padding: 15px; border-radius: 13px; margin-bottom: 14px; background: var(--accent-soft); border: 1px solid rgba(167,139,250,.22); }
      .backup-callout p { margin: 4px 0 0; color: var(--muted); }
      .wide { grid-column: 1 / -1; }
      @media (max-width: 760px) {
        body { padding-inline: 14px; }
        .topbar { min-height: 64px; }
        .hero { padding-top: 30px; }
        .hero-line { align-items: flex-start; }
        .node-id { display: none; }
        .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .grid { grid-template-columns: 1fr; }
        .wide { grid-column: auto; }
        .browser-toolbar { grid-template-columns: 1fr; }
        .file-row, .backup-row { grid-template-columns: 1fr; }
        .file-actions { padding-left: 46px; }
      }
      @media (max-width: 430px) {
        .metrics { grid-template-columns: 1fr; }
        .tabs { width: 100%; }
        .tab { flex: 1; padding-inline: 8px; }
        section { padding: 18px 16px; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="topbar">
        <div class="brand"><span class="mark">◆</span> GameBlade</div>
        <div class="top-status"><span class="live-dot"></span>${status.enrolled ? 'Node connected' : 'Setup needed'}</div>
      </div>

      <header class="hero">
        <div class="hero-line">
          <div>
            <p class="eyebrow">Node control center</p>
            <h1>Your archive, at a glance.</h1>
            <p class="sub">Review what this machine reads, keep its library ready to serve, and hold complete off-machine copies of the Coordinator.</p>
          </div>
          <div class="node-id">Node identity
            <code>${status.nodeId ? escapeHtml(status.nodeId) : 'waiting for enrolment'}</code>
          </div>
        </div>
      </header>

      ${setupPanel(status)}

      <div class="metrics">
        ${metric('◫', 'Games held', status.games.toLocaleString('en'), formatBytes(status.bytes))}
        ${metric('✓', 'Ready to serve', status.servableGames.toLocaleString('en'), `of ${status.games.toLocaleString('en')} games`)}
        ${metric('⌁', 'Libraries', status.libraries.length.toLocaleString('en'), status.libraries.every((library) => library.mounted) ? 'all mounted' : 'mount needs attention')}
        ${metric('↗', 'Node backups', status.backups.copies.length.toLocaleString('en'), formatBytes(status.backups.totalBytes))}
      </div>

      <nav class="tabs" aria-label="Node workspaces">
        <button class="tab active" type="button" data-tab="overview">Overview</button>
        <button class="tab" type="button" data-tab="games">Game intake</button>
        <button class="tab" type="button" data-tab="backups">Backups</button>
      </nav>

      <div class="tab-panel active" data-panel="overview">
        <div class="grid">
          <section>
            <div class="panel-head"><div><h2>Coordinator</h2><p>Where this Node publishes and serves.</p></div></div>
            <dl>
              <dt>Reports to</dt><dd>${link}</dd>
              <dt>Enrolment</dt><dd>${enrolment(status)}</dd>
              <dt>Last report</dt><dd>${lastReport(status)}</dd>
            </dl>
          </section>

          <section>
            <div class="panel-head"><div><h2>Serving health</h2><p>What players can fetch right now.</p></div></div>
            <dl>
              <dt>Ready to serve</dt><dd>${servable(status)}</dd>
              <dt>Files hashed</dt><dd>${hashed(status)}</dd>
              <dt>Stored locally</dt><dd>${formatBytes(status.bytes)}</dd>
            </dl>
          </section>

          <section class="wide">
            <div class="panel-head"><div><h2>Libraries</h2><p>Every mounted root managed by this Node.</p></div></div>
            ${libraryTable(status)}
            ${mountHint(status)}
          </section>

          <section class="wide">
            <div class="panel-head"><div><h2>Prepare the archive</h2><p>Scan what is mounted, then hash it for verified transfers.</p></div></div>
            ${jobs(status)}
            <p class="msg" id="job-msg"></p>
          </section>
        </div>
      </div>

      <div class="tab-panel" data-panel="games">
        ${gameIntakePanel(status)}
      </div>

      <div class="tab-panel" data-panel="backups">
        ${backupPanel(status)}
      </div>

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
  var root = document.documentElement;
  var base = root.getAttribute('data-base') || '';
  var refreshIn = Number(root.getAttribute('data-refresh')) || 15000;
  var form = document.getElementById('setup');
  var initialSetup = form ? {
    coordinatorUrl: form.elements.coordinatorUrl.value,
    enrolmentToken: form.elements.enrolmentToken.value
  } : null;
  var timer;

  function setupInProgress() {
    if (!form || !initialSetup) return false;
    return form.contains(document.activeElement) ||
      form.elements.coordinatorUrl.value !== initialSetup.coordinatorUrl ||
      form.elements.enrolmentToken.value !== initialSetup.enrolmentToken;
  }

  function scheduleRefresh(delay) {
    clearTimeout(timer);
    timer = setTimeout(function refreshWhenIdle() {
      var active = document.activeElement;
      var editing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT');
      if (setupInProgress() || editing || document.hidden) {
        timer = setTimeout(refreshWhenIdle, 1000);
        return;
      }
      location.reload();
    }, delay);
  }

  function request(path, options) {
    clearTimeout(timer);
    return fetch(base + path, options || {})
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) {
            throw new Error((data.error && data.error.message) || 'The Node refused that.');
          }
          return data;
        });
      });
  }

  function post(path, onDone) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }).then(function (data) { onDone(null, data); })
      .catch(function (error) { onDone(error); });
  }

  function messageAt(id, text, tone) {
    var target = document.getElementById(id || 'job-msg');
    if (!target) return;
    target.className = 'msg' + (tone ? ' ' + tone : '');
    target.textContent = text;
  }

  /* --------------------------------------------------------------- tabs */

  var savedTab = 'overview';
  try { savedTab = sessionStorage.getItem('gameblade-node-tab') || savedTab; } catch (_) {}

  function activateTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-panel') === name);
    });
    try { sessionStorage.setItem('gameblade-node-tab', name); } catch (_) {}
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (tab) {
    tab.addEventListener('click', function () { activateTab(tab.getAttribute('data-tab')); });
  });
  if (document.querySelector('[data-panel="' + savedTab + '"]')) activateTab(savedTab);

  /* ------------------------------------------------------ scan/hash/backup */

  Array.prototype.forEach.call(document.querySelectorAll('[data-post]'), function (button) {
    button.addEventListener('click', function () {
      var path = button.getAttribute('data-post');
      var messageId = button.getAttribute('data-message') || 'job-msg';
      button.disabled = true;
      messageAt(messageId, button.getAttribute('data-busy') || 'Working…');

      post(path, function (error, data) {
        if (error) {
          messageAt(messageId, error.message, 'bad');
          button.disabled = false;
          scheduleRefresh(8000);
          return;
        }
        messageAt(messageId, (data && data.message) || 'Done.', 'ok');
        setTimeout(function () { location.reload(); }, 700);
      });
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-delete-backup]'), function (button) {
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-delete-backup');
      if (!confirm('Remove this backup from this Node?\\n\\n' + name)) return;
      button.disabled = true;
      request('/api/node/backups/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function (data) {
          messageAt('backup-msg', data.message || 'Backup removed.', 'ok');
          setTimeout(function () { location.reload(); }, 500);
        })
        .catch(function (error) {
          messageAt('backup-msg', error.message, 'bad');
          button.disabled = false;
          scheduleRefresh(8000);
        });
    });
  });

  /* --------------------------------------------------------- game intake */

  var librarySelect = document.getElementById('library-select');
  var fileList = document.getElementById('file-list');
  var search = document.getElementById('entry-search');
  var entries = [];
  var intakeFilter = 'all';

  function bytes(value) {
    if (!Number.isFinite(value) || value <= 0) return 'size unavailable';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    var number = value / Math.pow(1024, power);
    return number.toFixed(power === 0 ? 0 : number >= 100 ? 0 : 1) + ' ' + units[power];
  }

  function make(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function matchesFilter(entry) {
    if (intakeFilter === 'review') return entry.eligible && entry.decision === 'automatic';
    if (intakeFilter === 'approved') return entry.decision === 'approved';
    if (intakeFilter === 'ignored') return entry.decision === 'ignored';
    if (intakeFilter === 'unsupported') return !entry.eligible;
    return true;
  }

  function renderEntries() {
    if (!fileList) return;
    fileList.textContent = '';
    var term = search ? search.value.trim().toLowerCase() : '';
    var shown = entries.filter(function (entry) {
      return matchesFilter(entry) && (!term || entry.name.toLowerCase().indexOf(term) >= 0);
    });

    if (!shown.length) {
      fileList.appendChild(make('div', 'browser-empty', 'No entries match this view.'));
      return;
    }

    shown.forEach(function (entry) {
      var row = make('div', 'file-row');
      var main = make('div', 'file-main');
      main.appendChild(make('div', 'file-icon', entry.kind === 'folder' ? '▰' : entry.kind === 'archive' ? '◇' : '·'));
      var copy = make('div', 'backup-copy');
      var title = make('div', 'file-name', entry.name);
      if (entry.decision !== 'automatic') {
        title.appendChild(make('span', 'badge ' + entry.decision, entry.decision));
      } else if (entry.systemIgnored) {
        title.appendChild(make('span', 'badge ignored', 'system ignored'));
      } else if (entry.cataloged) {
        title.appendChild(make('span', 'badge approved', 'in catalog'));
      }
      copy.appendChild(title);
      copy.appendChild(make('div', 'file-meta', entry.kind + ' · ' + bytes(entry.sizeBytes) + (entry.willRead ? ' · included on scan' : ' · not read')));
      main.appendChild(copy);
      row.appendChild(main);

      var actions = make('div', 'file-actions');
      function decisionButton(label, decision, danger) {
        var control = make('button', 'ghost small' + (danger ? ' danger' : ''), label);
        control.type = 'button';
        control.addEventListener('click', function () { setDecision(entry.name, decision, control); });
        return control;
      }
      if (entry.eligible && entry.decision !== 'approved') actions.appendChild(decisionButton('Approve', 'approved'));
      if (entry.decision !== 'ignored') actions.appendChild(decisionButton('Ignore', 'ignored', true));
      if (entry.decision !== 'automatic') actions.appendChild(decisionButton('Reset', 'automatic'));
      row.appendChild(actions);
      fileList.appendChild(row);
    });
  }

  function loadEntries() {
    if (!librarySelect || !fileList || !librarySelect.value) return;
    fileList.textContent = '';
    fileList.appendChild(make('div', 'browser-empty', 'Reading this library…'));
    request('/api/node/libraries/' + encodeURIComponent(librarySelect.value) + '/entries')
      .then(function (data) {
        entries = data.entries || [];
        var path = document.getElementById('library-path');
        if (path) path.textContent = data.library.path;
        renderEntries();
        scheduleRefresh(refreshIn);
      })
      .catch(function (error) {
        fileList.textContent = '';
        fileList.appendChild(make('div', 'browser-empty bad', error.message));
        scheduleRefresh(8000);
      });
  }

  function setDecision(name, decision, control) {
    control.disabled = true;
    messageAt('intake-msg', 'Saving ' + name + '…');
    request('/api/node/libraries/' + encodeURIComponent(librarySelect.value) + '/entries/decision', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: name, decision: decision })
    }).then(function (data) {
      messageAt('intake-msg', data.message || 'Decision saved.', 'ok');
      loadEntries();
    }).catch(function (error) {
      messageAt('intake-msg', error.message, 'bad');
      control.disabled = false;
      scheduleRefresh(8000);
    });
  }

  if (librarySelect) {
    librarySelect.addEventListener('change', loadEntries);
    if (search) search.addEventListener('input', renderEntries);
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (filter) {
      filter.addEventListener('click', function () {
        intakeFilter = filter.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (candidate) {
          candidate.classList.toggle('active', candidate === filter);
        });
        renderEntries();
      });
    });
    loadEntries();
  }

  scheduleRefresh(refreshIn);

  /* --------------------------------------------------------------- setup */

  if (!form) return;
  var message = document.getElementById('setup-msg');
  var button = form.querySelector('button');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearTimeout(timer);
    var body = {
      coordinatorUrl: form.elements.coordinatorUrl.value.trim(),
      enrolmentToken: form.elements.enrolmentToken.value.trim()
    };
    button.disabled = true;
    message.className = 'msg';
    message.textContent = 'Saving…';

    request('/api/node/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      message.className = 'msg ok';
      message.textContent = 'Saved. Registering with the coordinator — this page will update by itself.';
      setTimeout(function () { location.reload(); }, 3000);
    }).catch(function (error) {
      message.className = 'msg bad';
      message.textContent = error.message;
      button.disabled = false;
      scheduleRefresh(15000);
    });
  });
})();
`;

function metric(icon: string, label: string, value: string, hint: string): string {
  return `<div class="metric">
          <div class="metric-head"><span class="metric-icon">${icon}</span>${escapeHtml(label)}</div>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(hint)}</small>
        </div>`;
}

/** The file-browser workspace; rows are populated from disk by node.js. */
function gameIntakePanel(status: NodeStatusSnapshot): string {
  const options = status.libraries
    .map(
      (library) =>
        `<option value="${escapeHtml(library.id)}">${escapeHtml(library.name)}${library.mounted ? '' : ' — not mounted'}</option>`,
    )
    .join('');
  const firstPath = status.libraries[0]?.path ?? 'No mounted library';

  return `<section>
          <div class="panel-head">
            <div>
              <h2>Game intake</h2>
              <p>Review the top-level folders and archives that become games.</p>
            </div>
            <button type="button" class="ghost" data-post="/api/node/scan"
                    data-message="intake-msg" data-busy="Starting a fresh scan…"
                    ${status.scanning || status.libraries.length === 0 ? 'disabled' : ''}>
              ${status.scanning ? 'Scanning…' : 'Scan changes'}
            </button>
          </div>
          <div class="backup-callout">
            <strong>Safe by default, controllable when you need it.</strong>
            <p>Normal folders and supported game archives remain automatic. Approve records an explicit decision; Ignore withdraws an existing game immediately and keeps it out of future scans. Nothing here changes or deletes the source file.</p>
          </div>
          <div class="browser-toolbar">
            <select id="library-select" aria-label="Library" ${status.libraries.length === 0 ? 'disabled' : ''}>
              ${options || '<option>No libraries mounted</option>'}
            </select>
            <input id="entry-search" type="search" placeholder="Search files and folders…" aria-label="Search library entries" />
          </div>
          <div class="path"><span>▰</span><code id="library-path">${escapeHtml(firstPath)}</code></div>
          <div class="filters" aria-label="Entry filters">
            <button type="button" class="filter active" data-filter="all">Everything</button>
            <button type="button" class="filter" data-filter="review">Needs review</button>
            <button type="button" class="filter" data-filter="approved">Approved</button>
            <button type="button" class="filter" data-filter="ignored">Ignored</button>
            <button type="button" class="filter" data-filter="unsupported">Other files</button>
          </div>
          <div id="file-list" class="file-list">
            <div class="browser-empty">${status.libraries.length > 0 ? 'Reading this library…' : 'Mount a library to manage its games.'}</div>
          </div>
          <p class="msg" id="intake-msg"></p>
        </section>`;
}

/** Complete Coordinator copies stored on this Node, never the game library. */
function backupPanel(status: NodeStatusSnapshot): string {
  const backup = status.backups;
  const progress = backup.progress;
  const progressDetail = progress.running
    ? `<div class="backup-callout">
         <strong>${progress.phase === 'downloading' ? 'Copying the archive to this Node…' : 'The Coordinator is preparing a complete archive…'}</strong>
         ${
           progress.phase === 'downloading' && progress.totalBytes
             ? `${progressBar(progress.bytesReceived, progress.totalBytes)}<p>${formatBytes(progress.bytesReceived)} of ${formatBytes(progress.totalBytes)}</p>`
             : '<p>Database snapshots can take a moment; this continues safely if you leave the page.</p>'
         }
       </div>`
    : progress.lastError
      ? `<div class="backup-callout"><strong class="bad">The last backup did not finish.</strong><p>${escapeHtml(progress.lastError)}</p></div>`
      : progress.lastSuccessfulAt
        ? `<div class="backup-callout"><strong class="ok">Protected by a Node copy.</strong><p>Last completed ${escapeHtml(progress.lastSuccessfulAt)}.</p></div>`
        : `<div class="backup-callout"><strong>No Coordinator copy stored yet.</strong><p>Start one now, or leave this Node running and it will keep a fresh daily copy automatically.</p></div>`;

  const copies = backup.copies
    .map(
      (copy) => `<div class="backup-row">
          <div class="backup-main">
            <div class="file-icon">▣</div>
            <div class="backup-copy">
              <strong>${escapeHtml(copy.name)} <span class="badge approved">complete</span></strong>
              <span>${formatBytes(copy.sizeBytes)} · ${escapeHtml(copy.createdAt)}</span>
            </div>
          </div>
          <button type="button" class="ghost small danger" data-delete-backup="${escapeHtml(copy.name)}">Remove</button>
        </div>`,
    )
    .join('');

  return `<section>
          <div class="panel-head">
            <div>
              <h2>Coordinator backups</h2>
              <p>Complete disaster-recovery copies stored off the Coordinator.</p>
            </div>
            <button type="button" data-post="/api/node/backups" data-message="backup-msg"
                    data-busy="Asking the Coordinator to build a backup…"
                    ${progress.running || !status.enrolled ? 'disabled' : ''}>
              ${progress.running ? 'Backup running…' : 'Back up now'}
            </button>
          </div>
          <div class="note" style="margin:0 0 14px">
            Each copy contains the SQLite database, Coordinator settings and config state, every cloud save version, uploaded media, the published client, and cached artwork. Game library packages are already held by Nodes and are not duplicated inside the archive. This Node keeps the newest ${backup.keep} copies.
          </div>
          ${progressDetail}
          <div class="backup-list">
            ${copies || '<div class="browser-empty">No backups are stored on this Node.</div>'}
          </div>
          <p class="msg" id="backup-msg"></p>
        </section>`;
}

/**
 * How soon the page should draw itself again.
 *
 * Fast while something is moving — a scan, a hashing pass, somebody at the
 * setup form waiting for it to go green — and slow when the answer is not going
 * to change. A fixed interval has to be one or the other.
 */
function refreshInterval(status: NodeStatusSnapshot): number {
  if (status.scanning || status.hashing.running || status.backups.progress.running) return 3000;
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
