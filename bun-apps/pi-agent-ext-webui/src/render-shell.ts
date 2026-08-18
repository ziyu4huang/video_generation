/**
 * render-shell.ts — the vanilla browser shell (specs/06 D4/D5). A single inline
 * HTML document (string constant, like web-access's generateCuratorPage): no
 * React, no Bun.build, no committed dist/. Served at GET / by createRenderRoutes
 * (render-routes.ts), RETIRING the ticket-04 connect-test stub (D8.3).
 *
 * Client behavior (D4):
 *   - on load: GET /api/views -> render tabs; select location.hash (or "main").
 *   - GET /api/view/:id -> md injects the server-rendered html; html sets an
 *     <iframe sandbox=""> (no allow-scripts / allow-same-origin) srcdoc (D5).
 *   - EventSource('/api/events') -> on view_update refresh tabs + re-render the
 *     affected view; a view carrying presentId auto-focuses (blocking HITL gate).
 *   - When a view JSON carries presentId + controls, renderView appends a
 *     declarative .webui-toolbar under #content; a control click sends an
 *     appexec respond frame over /ws (one response per presentation).
 *   - ask_user frames render the mirrored ask-user questionnaire dialog (§C3);
 *   - event-cards (01): card frames (live + snapshot replay) project into the
 *     Cards tab pane (#cards-pane) — textContent ONLY; the article id is the
 *     article id is the deep-link anchor (#card-<id>, ticket 03);
 *   - event-cards (02): interactive cards render a fill-in <form> (built with
 *     createElement/textContent ONLY — producer strings are untrusted); submit
 *     posts the collected answers as a loose appexec extra.kind:"card_answer"
 *     envelope over sendRaw (queued while reconnecting), with NO optimistic
 *     state — the inbound card_done tombstone (retireCard) is the only thing
 *     that retires the form; snapshot replay applies card then card_done in
 *     order, so a refreshed client renders the answered state for free;
 *   - cards-ux2 (02): blocking:false interactive cards render as DRAFT forms
 *     (a draft badge + a "Send" submit) whose submit posts a loose appexec
 *     extra.kind:"card_send" envelope (NOT card_answer — that is the MODAL
 *     answer loop); card_done FREEZES a draft instead of retiring it: every
 *     input+button disables, a `sent <HH:MM:SS>` stamp (the tombstone ts)
 *     appears, and the t01 collapsed-review toggle rides below the frozen
 *     form. Draft INPUT values are NOT persisted across refresh (v1 — the
 *     snapshot replays card structure only, never form state);
 *   - DE-CHAT (event-cards 00): chat lives in the TUI — the v2 main-session
 *     composer (prompt input + Send + Abort) is GONE; the webui keeps only
 *     web-native interaction (HITL appexec, ask-user).
 *     Enter-to-send handlers ignore IME composition (isComposing / keyCode
 *     229) — a CJK IME's confirmation Enter must never dispatch a send.
 */
export const RENDER_SHELL_HTML = `<!-- webui-render-shell -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webui render</title>
<link rel="icon" href="data:,"> <!-- no favicon request: a 404 there logged a console error on every clean boot -->
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  /* webui-v3 (dynamic shell): full-viewport app layout — body is a flex
     column; panes fill the remaining height and scroll internally, so the
     surface adapts to ANY browser size (dvh tracks mobile chrome too). */
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; gap: .5rem; padding: .5rem 1rem; border-bottom: 1px solid #8884; flex-wrap: wrap; flex: 0 0 auto; }
  .tab { padding: .35rem .7rem; border-radius: 6px; cursor: pointer; border: 1px solid transparent; background: #8882; }
  .tab.active { border-color: #6cf; background: #6cf3; }
  main { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 1rem 0; width: 100%; overflow: hidden; }
  /* dynamic shell: #content (present surface) fills + scrolls like the panes;
     entirely hidden while idle so the active pane gets the full height. */
  #content { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: .4rem; padding: 0 1rem; overflow-y: auto; }
  #content:empty { display: none; }
  /* full-bleed scroll: panes span the viewport so the scrollbar sits at the
     browser edge; the reading-measure cap moved HERE (content layer) so the
     capped-column layout is preserved on wide screens. */
  #content > *, #cards-pane .card, #report-pane article { max-width: 1500px; width: 100%; margin-left: auto; margin-right: auto; }
  /* BTW tab (demo): branch-a-question composer + pending list. */
  #btw-pane { display: flex; flex-direction: column; gap: .5rem; padding: .4rem 1rem; flex: 1; min-height: 0; overflow-y: auto; }
  #btw-pane[hidden] { display: none; }
  .btw-box, .btw-entry { border: 1px solid #8884; border-radius: 6px; padding: .6rem .7rem; max-width: 900px; width: 100%; margin-left: auto; margin-right: auto; }
  .btw-box h5 { margin: 0 0 .4rem; font-size: .8rem; }
  .btw-box textarea, .btw-box select, .btw-box input { width: 100%; padding: .3rem .5rem; border-radius: 6px; border: 1px solid #8884; background: #0000; color: inherit; font-size: .8rem; box-sizing: border-box; }
  .btw-box textarea { min-height: 3.2rem; resize: vertical; margin-top: .3rem; }
  .btw-box .btw-send, .btw-entry .btw-resolve { align-self: flex-start; margin-top: .35rem; padding: .35rem .9rem; border-radius: 6px; border: 1px solid #6cf; background: #6cf3; color: inherit; cursor: pointer; font-size: .8rem; }
  .btw-entry .btw-resolve { border-color: #8886; background: #8882; font-size: .72rem; padding: .2rem .6rem; }
  .btw-chips { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .3rem; }
  .btw-chip { padding: .15rem .55rem; border: 1px solid #6cf; border-radius: 999px; background: #6cf3; font-size: .72rem; }
  .btw-entry .meta, #data-pane .tel .meta { font-size: .7rem; color: #8b949e; }
  .tab .tab-badge { padding: 0 .4rem; margin-left: .35rem; border: 1px solid #6cf; border-radius: 999px; font-size: .65rem; background: #6cf3; }
  #data-pane .tel { border: 1px solid #8884; border-radius: 6px; padding: .6rem .7rem; max-width: 900px; width: 100%; margin-left: auto; margin-right: auto; }
  #data-pane .tel dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem .8rem; margin: 0; font-size: .78rem; }
  #data-pane .tel dt { color: #8b949e; }
  #data-pane .tel dd { margin: 0; font-family: ui-monospace, monospace; }
  .meta { color: #888; font-size: .8rem; margin-bottom: .5rem; }
  #content iframe { width: 100%; min-height: 70vh; border: 1px solid #8884; border-radius: 6px; background: #fff; }
  #content :is(pre,table) { background: #8881; padding: .5rem; border-radius: 4px; overflow:auto; }
  #content code { font-family: ui-monospace, monospace; }
  /* HITL response toolbar + on-screen response log */
  .webui-toolbar { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; flex-wrap: wrap; }
  .webui-toolbar button { padding: .2rem .55rem; border: 1px solid #8886; border-radius: 4px; background: #8882; color: inherit; cursor: pointer; }
  .webui-toolbar button:hover:not(:disabled) { background: #6cf3; }
  .webui-toolbar button:disabled { opacity: .45; cursor: default; }
  .webui-toolbar button.webui-chosen { border-color: #6cf; background: #6cf3; font-weight: 600; }
  .webui-toolbar input { padding: .2rem .4rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }
  .webui-tweak { display: inline-flex; gap: .3rem; align-items: center; }
  #webui-feedback-log { position: fixed; right: .6rem; bottom: .6rem; width: 22rem; max-width: 70vw; max-height: 38vh; overflow: auto; background: #0009; color: #eee; padding: .45rem .55rem; border-radius: 6px; font: 12px/1.45 ui-monospace, monospace; box-shadow: 0 2px 10px #0006; z-index: 50; }
  #webui-feedback-log .webui-log-head { display: flex; justify-content: space-between; align-items: center; opacity: .85; margin-bottom: .2rem; }
  #webui-feedback-log .webui-log-head a { color: #9cf; cursor: pointer; text-decoration: none; }
  #webui-feedback-log-body > div { border-bottom: 1px solid #fff2; padding: .12rem 0; word-break: break-word; }
  /* v2 live transcript (architecture v2 §3.3): the agent stream rendered as a
     mirror — message deltas, tool calls, mutex signals. De-chat (event-cards
     00): full-height — the compose bar that sat below the shell row is gone. */
  /* webui-v3 (03): the transcript scrollback is GONE — the TUI owns logs. */
  /* event-cards (01): Cards tab pane — projected card frames. Every field is
     textContent-rendered (raw HTML injection forbidden); the article id is the
     deep-link anchor; newest LAST (chronological). Badge color per attention. */
  #cards-pane { display: flex; flex-direction: column; gap: .5rem; padding: .4rem 1rem; flex: 1; min-height: 0; overflow-y: auto; }
  #cards-pane[hidden] { display: none; } /* the flex display must not defeat [hidden] */
  #report-pane, #data-pane { display: flex; flex-direction: column; gap: .4rem; padding: .4rem 1rem; flex: 1; min-height: 0; overflow-y: auto; }
  #report-pane[hidden], #data-pane[hidden] { display: none; }
  /* webui-v3 fix (report-iframe): html reports render in a sandboxed iframe
     that NO other rule sizes — the browser default is 300x150, unreadable for
     archify-class diagrams. Size it like the present-surface frames. */
  #report-pane article iframe { width: 100%; min-height: 70vh; border: 1px solid #8884; border-radius: 6px; background: #fff; }
  #cards-pane .card { border: 1px solid #8884; border-radius: 6px; padding: .5rem .6rem; }
  #cards-pane .card h4 { margin: 0 0 .25rem; font-size: .85rem; }
  #cards-pane .card-meta { display: flex; gap: .5rem; align-items: center; color: #888; font-size: .75rem; }
  #cards-pane .card .badge { padding: 0 .45rem; border: 1px solid #8886; border-radius: 999px; font-size: .7rem; }
  #cards-pane .card[data-attention="view"] .badge { border-color: #e0a030; color: #e0a030; }
  #cards-pane .card[data-attention="input"] .badge { border-color: #6cf; color: #6cf; }
  #cards-pane .card-body { margin-top: .3rem; white-space: pre-wrap; word-break: break-word; font-size: .8rem; }
  /* event-cards (02): the interactive fill-in form + the answered tombstone. */
  #cards-pane .card p.card-question { margin: .45rem 0 .3rem; font-size: .85rem; font-weight: 600; }
  form.card-form { display: flex; flex-direction: column; gap: .45rem; margin-top: .4rem; }
  form.card-form label { font-size: .75rem; color: #888; }
  form.card-form input, form.card-form select { width: 100%; padding: .3rem .5rem; border-radius: 6px; border: 1px solid #8884; background: #0000; color: inherit; font-size: .8rem; }
  form.card-form button[type='submit'] { align-self: flex-start; padding: .35rem .9rem; border-radius: 6px; border: 1px solid #6cf; background: #6cf3; color: inherit; cursor: pointer; font-size: .8rem; }
  #cards-pane .card .card-done-toggle { display: flex; gap: .5rem; align-items: baseline; margin-top: .4rem; padding: 0; border: 0; background: none; color: #888; cursor: pointer; font-size: .75rem; font-style: italic; }
  #cards-pane .card .card-done-detail { margin: .3rem 0 0; padding: .35rem .55rem; border-left: 2px solid #8886; font-size: .75rem; }
  #cards-pane .card .card-done-detail p { margin: .2rem 0; }
  #cards-pane .card p.card-answered { margin-top: .4rem; font-size: .75rem; color: #888; font-style: italic; }
  #cards-pane .card.card-answered { opacity: .65; }
  /* cards-ux2 (02): DRAFT (blocking:false) cards — the draft badge + the
     frozen sent HH:MM:SS state (the form STAYS disabled, never removed). */
  #cards-pane .card .badge.card-draft-badge { border-color: #7ec87e; color: #7ec87e; }
  #cards-pane .card .card-done-mark { font-style: normal; }
  /* event-cards (04): the sandboxed viewer frame + the confirm-gate pre. */
  #cards-pane .card iframe.card-viewer { width: 100%; min-height: 240px; border: 1px solid #8884; border-radius: 6px; background: #fff; }
  #cards-pane .card.card-confirm pre { background: #8881; padding: .4rem; border-radius: 4px; overflow: auto; font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; margin: .4rem 0; }
  /* event-cards (03): #card-<id> deep-link flash — background highlight pulse
     + fade, timed to the classList remove (~1.6s). */
  @keyframes card-flash-pulse { from { background: #6cf6; } to { background: #0000; } }
  #cards-pane .card.card-flash { animation: card-flash-pulse 1.6s ease-out; }
</style>
</head>
<body>
<header id="tabs"><span id="session-status" style="margin-left:auto;color:#888;font-size:.8rem;align-self:center"></span></header>
<main>
  <div id="content"></div>
  <section id="report-pane" hidden></section>
  <section id="cards-pane"></section>
  <section id="data-pane" hidden></section>
  <section id="btw-pane" hidden></section>
</main>
<div id="webui-feedback-log">
  <div class="webui-log-head"><span>response log</span><a id="webui-log-clear" href="#">clear</a></div>
  <div id="webui-feedback-log-body"></div>
</div>
<script>
const tabsEl = document.getElementById('tabs');
const contentEl = document.getElementById('content');
let activeId = location.hash.slice(1) || 'main';
// v2 (architecture v2 §3.6): monotonic render token — an older fetch resolving
// after a newer one must not overwrite newer content (async interleave race).
let renderSeq = 0;

function fmtTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }

// cards-ux2 (02): local-clock HH:MM:SS for the frozen-draft sent stamp.
function fmtClock(ms) {
  try {
    var d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
  } catch { return ''; }
}

async function loadViews() {
  const res = await fetch('/api/views');
  const views = res.ok ? await res.json() : [];
  tabsEl.innerHTML = '';
  for (const v of views) {
    const el = document.createElement('div');
    el.className = 'tab' + (v.id === activeId ? ' active' : '');
    el.dataset.viewId = v.id;
    el.textContent = v.title || v.id;
    el.title = v.id + ' · updated ' + fmtTime(v.updatedAt);
    el.onclick = () => {
      if (v.mode === 'url') {
        // 02-A guardrail: a url view NEVER renders into the sandbox srcdoc
        // iframe. v2 cards-first: the frame-fed url map is gone with the
        // toast/panel surfaces — a url tab is inert (nothing to open).
        return;
      }
      activeId = v.id; location.hash = v.id; renderView(v.id);
    };
    tabsEl.appendChild(el);
  }
  // event-cards (01): the Cards tab rides the SAME tab strip. loadViews owns
  // the strip (it rebuilds from scratch on every load), so the tab is created
  // here on every rebuild — its active state mirrors cardsVisible and its
  // toggle shows/hides #cards-pane (a projection pane independent of views).
  const cardsTab = document.createElement('div');
  cardsTab.className = 'tab' + (cardsVisible ? ' active' : '');
  cardsTab.id = 'cards-tab';
  cardsTab.textContent = 'Inbox';
  cardsTab.title = 'ask + event cards — the HITL inbox';
  cardsTab.onclick = function () { toggleCardsTab(); };
  tabsEl.appendChild(cardsTab);
  // tab-views (01): Report / Ask / Data tabs — same strip, exclusive panes.
  for (const spec of [['Report', 'report', 'static reports by agent/skill'], ['Data', 'data', 'interactive HTML views'], ['BTW', 'btw', 'branch a chat question from current content']]) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.id = 'pane-tab-' + spec[1];
    el.textContent = spec[0];
    el.title = spec[2];
    el.onclick = function () { setPane(activePane === spec[1] ? null : spec[1]); };
    tabsEl.appendChild(el);
  }
  if (!views.some(v => v.id === activeId)) activeId = (views[0] && views[0].id) || 'main';
  return views;
}

async function renderView(id) {
  const seq = ++renderSeq;
  const res = await fetch('/api/view/' + encodeURIComponent(id));
  if (seq !== renderSeq) return; // superseded by a newer render — drop the stale write
  if (!res.ok || res.status === 204) { contentEl.innerHTML = ''; return; } // 204 = empty main slot (boot probe)
  const v = await res.json();
  // 02-A guardrail (defensive — tab clicks already intercept url mode): a url
  // view must NEVER render into the sandbox srcdoc iframe. v2 cards-first:
  // the frame-fed url map is gone — render nothing for a url view.
  if (v.mode === 'url') { contentEl.innerHTML = ''; return; }
  // event-cards (01): scope the active toggle to VIEW tabs (.tab[data-view-id])
  // so the Cards tab (no data-view-id) keeps its own active state below.
  document.querySelectorAll('.tab[data-view-id]').forEach(function (t) {
    t.classList.toggle('active', t.dataset.viewId === id);
  });
  // v2 (architecture v2 §3.2): BOTH md and html content render inside the
  // most-restrictive sandbox="" iframe. v1 injected md into the page origin via
  // innerHTML — server-side marked output passes raw HTML through (markdown
  // may contain <img onerror=...>/<svg onload=...>), so agent-generated md
  // executed scripts with full same-origin /ws+/api access. The sandbox blocks
  // scripts/forms/popups; subresource loads (same-origin /output images) still
  // work, so image markdown keeps rendering.
  contentEl.innerHTML = '';
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', ''); // most restrictive — no scripts, no same-origin
  f.srcdoc = v.mode === 'html' ? v.content : (v.html || '');
  contentEl.appendChild(f);
  renderControls(v);
}

async function refresh() { await loadViews(); await renderView(activeId); }

function subscribe() {
  const es = new EventSource('/api/events');
  es.onmessage = async function (e) {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (!data || !data.viewId) return;
    await loadViews();
    // Auto-focus on present (blocking gate): a presenting view the user is not
    // looking at is a silent deadlock, so probe the updated view and switch to
    // it when it carries a presentId. The SSE payload shape stays
    // {viewId, updatedAt} — the probe uses the normal /api/view endpoint.
    if (data.viewId !== activeId) {
      try {
        const res = await fetch('/api/view/' + encodeURIComponent(data.viewId));
        if (res.ok) {
          const v = await res.json();
          if (v && v.presentId) { activeId = data.viewId; location.hash = data.viewId; }
        }
      } catch { /* probe failed — stay on the current view */ }
    }
    if (data.viewId === activeId) await renderView(activeId);
  };
  es.onerror = function () { es.close(); setTimeout(subscribe, 2000); };
}

// --- HITL response channel: the EXISTING inbound /ws (web-server.ts upgrade) ---
// Mirrors the SSE reconnect pattern: on close/error, retry after 2s (guarded
// against duplicate timers). sendAppexecResponse posts 'appexec' respond
// frames (protocol.ts: AppExecCommandSchema keeps 'extra' loose; parseCommand
// validates the respond sub-shape {kind:'respond', id, action, tweak?}).
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
let ws = null;
let wsRetryTimer = null;
// v2 send queue (architecture v2 §3.3): outbound frames are QUEUED while the
// socket is connecting/reconnecting and flushed on open — a HITL answer or
// prompt typed during a reconnect is never silently lost (v1 dropped it).
let wsQueue = [];

function connectWs() {
  ws = new WebSocket(wsUrl);
  ws.onopen = function () {
    console.log('[webui] response ws open');
    const q = wsQueue; wsQueue = [];
    q.forEach(function (p) { try { ws.send(p); } catch (e) { /* socket died mid-flush */ } });
  };
  ws.onclose = function () {
    console.log('[webui] response ws closed; retry in 2s');
    scheduleWsRetry();
  };
  ws.onerror = function () { console.warn('[webui] response ws error'); scheduleWsRetry(); };
  // Inbound consumers of the /ws socket: the v2 connect-time snapshot
  // (history replay), and every other frame -> the live transcript mirror
  // (v1 dropped all frames — mutex signals and the agent stream were
  // invisible in the browser).
  ws.onmessage = function (message) {
    let frame; try { frame = JSON.parse(message.data); } catch { return; }
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'snapshot' && frame.state) { txRenderSnapshot(frame.state); return; }
    txApply(frame);
  };
}

function scheduleWsRetry() {
  if (wsRetryTimer !== null) return; // one in-flight retry timer at most
  wsRetryTimer = setTimeout(function () { wsRetryTimer = null; connectWs(); }, 2000);
}

connectWs();

function logResponse(text) {
  const body = document.getElementById('webui-feedback-log-body');
  if (!body) return;
  const line = document.createElement('div');
  const shown = text.length > 120 ? text.slice(0, 117) + '...' : text;
  line.textContent = '\u2192 ' + fmtTime(Date.now()) + ' \u00b7 ' + shown;
  body.appendChild(line);
  // v2: bound the log DOM — a long session must not grow the page forever.
  while (body.children.length > 50) body.removeChild(body.firstChild);
}

function sendRaw(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
    return true;
  }
  wsQueue.push(payload); // v2: queue, never drop (flushed on open)
  return false;
}

function sendAppexecResponse(id, action, tweak) {
  const extra = { kind: 'respond', id: id, action: action };
  if (tweak) extra.tweak = tweak; // omit the key when absent (present-tool details semantics)
  const frame = { type: 'appexec', extra: extra };
  sendRaw(JSON.stringify(frame));
  logResponse(action + (tweak ? ' (tweak: ' + tweak + ')' : ''));
}

// v2 HITL cancel (architecture v2 §3.4): {type:'appexec', extra:{kind:'cancel',
// id}} resolves the ONE pending presentation as {cancelled:true} — the
// browser's Cancel button, without dropping the WS (which would abort EVERY
// pending and force a re-present).
function sendAppexecCancel(id) {
  const frame = { type: 'appexec', extra: { kind: 'cancel', id: id } };
  sendRaw(JSON.stringify(frame));
  logResponse('cancel requested');
}

// --- v2 live transcript mirror (architecture v2 §3.3) -----------------------
// webui-v3 (03): the transcript scrollback (txEl/txAppend/txLine) is GONE —
// log frames are TUI-only (t02 diet); the shell renders HITL surfaces only.
function txEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function txApply(frame) {
  switch (frame.type) {
    // webui-v3 (03): the log/mutex case family is GONE — those frames never
    // arrive (t02 diet); the TUI owns logs and mutex feedback.
    case 'ask_user': renderAskUser(frame);
      break;
    case 'ask_user_done':
      if (askUserEl && askUserPromptId === frame.promptId) { askUserEl.remove(); askUserEl = null; askUserPromptId = null; }
      break;
    case 'session_info': {
      var ss = document.getElementById('session-status');
      if (ss) ss.textContent = (frame.cwd || '') + (frame.branch ? ' (' + frame.branch + ')' : '');
      break;
    }
    case 'card': renderCard(frame); break;
    case 'card_done': retireCard(frame); break; // event-cards (02) tombstone
    case 'report': renderReport(frame); break; // tab-views (01)
    default: break; // other frames handled elsewhere
  }
}

function txRenderSnapshot(state) {
  // webui-v3 (03): authoritative replay — panes reset, then txApply re-appends
  // (kept-family frames only: cards / reports / ask / status).
  if (cardsPaneEl) cardsPaneEl.textContent = '';
  if (reportPaneEl) reportPaneEl.textContent = '';
  if (dataPaneEl) dataPaneEl.textContent = '';
  if (state && Array.isArray(state.transcript)) state.transcript.forEach(txApply);
}

// --- event-cards (01): Cards tab projection --------------------------------
// Every card frame (live or snapshot replay) appends an <article> to
// #cards-pane. ALL fields render via textContent ONLY — card titles/bodies
// are bus-sourced and treated as UNTRUSTED (raw HTML injection is FORBIDDEN on this
// path; a body containing <script>/<img onerror> renders as literal text).
// The article id IS the deep-link anchor (ticket 03 routes #card-<id>).
// Newest LAST — chronological; ticket 03 can scroll to a card.
const cardsPaneEl = document.getElementById('cards-pane');
const reportPaneEl = document.getElementById('report-pane');
const dataPaneEl = document.getElementById('data-pane');
let activePane = 'events'; // webui-v3 (03): 'report'|'events'(Inbox)|'data'|null — Inbox at boot
let cardsVisible = false;

// toggleCardsTab: the ONE tab-activation path the Cards tab click AND the
// #card-<id> deep link share (event-cards 03). force=true ACTIVATES (deep
// link — never toggles a visible pane away); undefined toggles. The tab is
// looked up by id on every call — loadViews rebuilds the strip, so no stale
// element closure survives a rebuild.
// Hash-addressable panes (shareable tab URLs + back/forward + refresh-stable):
// #inbox / #report / #data / #btw map onto setPane; #card-<id> deep links keep
// precedence (a card hash owns routing — the pane sync never clobbers it).
function paneHashOf(name) {
  if (name === 'events') return '#inbox';
  if (name === 'report' || name === 'data' || name === 'btw') return '#' + name;
  return null; // collapsed (null) — clear the hash without a history entry
}
function syncPaneHash() {
  try {
    if (parseCardHashInline(location.hash) !== null) return; // card link owns it
    var want = paneHashOf(activePane);
    if (want === null) {
      if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    if (location.hash !== want) location.hash = want; // history entry -> back/forward
  } catch { /* never break a tab switch */ }
}
function handlePaneHash() {
  try {
    if (parseCardHashInline(location.hash) !== null) return;
    var h = location.hash.replace(/^#/, '');
    if (h === 'inbox') h = 'events';
    if (h === 'report' || h === 'data' || h === 'btw' || h === 'events') {
      if (activePane !== h) setPane(h);
    }
  } catch { /* never break boot */ }
}
function setPane(name) {
  activePane = name;
  cardsVisible = name === 'events';
  if (reportPaneEl) reportPaneEl.hidden = name !== 'report';
  if (cardsPaneEl) cardsPaneEl.hidden = name !== 'events';
  if (dataPaneEl) dataPaneEl.hidden = name !== 'data';
  var btwPaneEl = document.getElementById('btw-pane');
  if (btwPaneEl) btwPaneEl.hidden = name !== 'btw';
  if (name === 'btw') { renderBtwPane(); btwPollStart(); } else { btwPollStop(); }
  if (name === 'data') renderDataPane();
  for (const tn of ['report', 'data', 'btw']) {
    const el = document.getElementById('pane-tab-' + tn);
    if (el) el.classList.toggle('active', name === tn);
  }
  const ct = document.getElementById('cards-tab');
  if (ct) ct.classList.toggle('active', name === 'events');
  syncPaneHash(); // hash-addressable panes: the URL follows the tab (and vice versa)
}
function toggleCardsTab(force) { setPane(typeof force === 'boolean' && !force ? null : 'events'); }

// The frame id already carries the card- prefix when wiring-generated
// (card-<n>, per-session counter); prefix only foreign producer ids so EVERY
// anchor is #card-<x>.
function cardDomId(id) { return /^card-/.test(id) ? id : 'card-' + id; }

function renderCard(frame) {
  if (!cardsPaneEl || !dataPaneEl) return;
  const rawId = typeof frame.id === 'string' ? frame.id : '';
  const domId = cardDomId(rawId);
  if (domId && document.getElementById(domId)) return; // live/replay interleave dedupe
  const attention = frame.attention === 'view' || frame.attention === 'input' ? frame.attention : 'silent';
  const kind = frame.kind === 'interactive' || frame.kind === 'viewer' ? frame.kind : 'readonly';
  // webui-v3 (03): route — viewer cards to Data, EVERYTHING else (ask + event
  // cards) to the Inbox. card_done finds articles document-wide.
  const pane = kind === 'viewer' ? dataPaneEl : cardsPaneEl;
  const art = document.createElement('article');
  art.id = domId;
  art.className = 'card';
  art.setAttribute('data-kind', kind);
  art.setAttribute('data-attention', attention);
  const h = document.createElement('h4');
  h.textContent = typeof frame.title === 'string' ? frame.title : '';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const t = document.createElement('time');
  if (typeof frame.ts === 'number' && isFinite(frame.ts)) {
    try { t.setAttribute('datetime', new Date(frame.ts).toISOString()); } catch { /* invalid ts — skip the machine attr */ }
  }
  t.textContent = fmtTime(typeof frame.ts === 'number' ? frame.ts : 0);
  const badge = document.createElement('span');
  badge.className = 'badge'; // inert — a label, never a control
  badge.textContent = attention;
  meta.appendChild(t);
  meta.appendChild(badge);
  const body = document.createElement('div');
  body.className = 'card-body';
  body.textContent = frame.body && typeof frame.body.text === 'string' ? frame.body.text : '';
  // event-cards (05): an optional body.url deep link (archify cards) renders
  // as a createElement anchor — href/target/rel via property assignment ONLY,
  // never setAttribute (url is producer-sourced, i.e. UNTRUSTED; a javascript:
  // href string displays as text at worst — same sink discipline as the rest
  // of the card path: no markup sink exists).
  if (frame.body && typeof frame.body.url === 'string' && frame.body.url) {
    var link = document.createElement('a');
    link.href = frame.body.url;
    link.textContent = frame.body.url;
    link.target = '_blank';
    link.rel = 'noopener';
    body.appendChild(link);
  }
  art.appendChild(h);
  art.appendChild(meta);
  art.appendChild(body);
  // event-cards (02): interactive cards carry { question, fields } instead of
  // { text } — the body div stays empty and the fill-in form appends after it
  // (an absent/malformed interactive body degrades to the inert card above).
  if (kind === 'interactive') appendCardForm(art, frame);
  // event-cards (04): viewer cards carry { html } — the body div stays empty
  // and the sandboxed iframe appends after it.
  if (kind === 'viewer') appendViewerFrame(art, frame);
  pane.appendChild(art); // newest LAST — chronological
}

// --- event-cards (02): interactive fill-in form + card_done tombstone --------
// appendCardForm: EVERY string rides createElement/textContent ONLY — no
// markup sinks exist (question/labels/options are producer-sourced, i.e.
// UNTRUSTED; same contract as the readonly body text). The data-card-id
// attribute carries the RAW frame id — the same key handleCardAnswer
// correlates on (never the prefixed dom id). Invalid fields are SKIPPED, not
// fatal.
// isAskCard: the pilot ask cards (event-cards 05) — wiring mints id
// ask-<promptId> for questionnaire cards. Their submit posts the EXISTING
// ask_user_answer envelope (the ask-user bridge), NOT card_answer: one answer
// path per card kind (the unify choice — the t02 JSONL decision log stays
// generic-interactive-only; the wiring-side card_done tombstone from
// rpiv:ask-user:answered retires the form).
function isAskCard(id) { return /^ask-/.test(id); }

function appendCardForm(art, frame) {
  var b = frame.body;
  if (!b || typeof b.question !== 'string' || !Array.isArray(b.fields)) return; // malformed — inert text card
  const cardId = typeof frame.id === 'string' ? frame.id : '';
  // The RENDERED fields only (invalid entries are skipped below — the submit
  // envelope maps over exactly what the user can fill, in render order).
  var fields = [];
  const form = document.createElement('form');
  form.className = 'card-form';
  form.setAttribute('data-card-id', cardId);
  // cards-ux2 (02): blocking === false = DRAFT — the SAME field builder as
  // the modal form, plus a draft badge and a "Send" submit that posts the
  // card_send envelope (never card_answer — that loop is MODAL-only). The
  // data-draft attribute is retireCard's freeze probe on the card_done
  // tombstone (absent/true keeps the modal retire semantics untouched).
  const draft = frame.blocking === false;
  if (draft) {
    form.setAttribute('data-draft', '1');
    const draftBadge = document.createElement('span');
    draftBadge.className = 'badge card-draft-badge';
    draftBadge.textContent = 'draft';
    form.appendChild(draftBadge);
  }
  const q = document.createElement('p');
  q.className = 'card-question';
  q.textContent = b.question;
  form.appendChild(q);
  for (const f of b.fields) {
    if (!f || typeof f.name !== 'string' || !f.name) continue; // skip invalid fields
    if (f.type !== 'text' && f.type !== 'select') continue; // unknown field type — skip
    fields.push(f);
    const lab = document.createElement('label');
    lab.textContent = typeof f.label === 'string' ? f.label : f.name;
    form.appendChild(lab);
    if (f.type === 'text') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.name = f.name;
      if (typeof f.placeholder === 'string' && f.placeholder) inp.placeholder = f.placeholder;
      form.appendChild(inp);
    } else {
      const sel = document.createElement('select');
      sel.name = f.name;
      const opts = Array.isArray(f.options) ? f.options : [];
      for (const o of opts) {
        if (typeof o !== 'string') continue;
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      }
      form.appendChild(sel);
    }
  }
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.textContent = 'Submit';
  if (draft) btn.textContent = 'Send'; // cards-ux2 (02): drafts SEND state, not answer
  form.appendChild(btn);
  // Submit collects EVERY named field in one shot (FormData) and posts ONE
  // loose appexec envelope over sendRaw. ASK CARDS (unify choice, event-cards
  // 05): the ask_user_answer envelope — same channel + payload shape as the
  // ask dialog's submit (promptId = cardId minus the ask- prefix; answers as
  // proper {questionIndex, question, kind, answer} rows the ask-user envelope
  // formatter consumes). Generic interactive cards: the card_answer envelope.
  // Both go through sendRaw, NOT raw ws.send — sendRaw queues while the WS is
  // reconnecting (v2 queue-never-drop), so an answer typed during a retry
  // lands instead of dropping. NO optimistic local state: card_done drives
  // the retire (first answer wins, enforced server-side).
  form.onsubmit = function (ev) {
    ev.preventDefault(); // never navigate — the answer rides /ws
    var answers = Object.fromEntries(new FormData(form));
    // cards-ux2 01: stash the COLLECTED answers on the article — retireCard
    // renders the read-only review block from this on the card_done
    // tombstone (LIVE only; snapshot replay has no submit and degrades to
    // the collapsed summary). Still NO optimistic retire — card_done drives.
    art.cardAnswers = {
      question: b.question,
      rows: fields.map(function (f) {
        return { label: typeof f.label === 'string' ? f.label : f.name, answer: answers[f.name] !== undefined && answers[f.name] !== '' ? answers[f.name] : null };
      })
    };
    // cards-ux2 (02): DRAFT — one-shot card_send envelope over sendRaw
    // (queued while reconnecting). NEVER card_answer, and NO optimistic
    // retire: the form stays live until the inbound card_done tombstone
    // FREEZES it (first-send-wins is enforced host-side).
    if (draft) {
      sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_send', cardId: cardId, answers: answers } }));
      return false;
    }
    if (isAskCard(cardId)) {
      sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'ask_user_answer', promptId: cardId.slice(4), result: { cancelled: false, answers: fields.map(function (f, i) { return { questionIndex: i, question: typeof f.label === 'string' ? f.label : f.name, kind: f.type === 'select' ? 'option' : 'custom', answer: answers[f.name] !== undefined ? answers[f.name] : null }; }) } } }));
      return false;
    }
    sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: cardId, answers: answers } }));
    return false;
  };
  art.appendChild(form);
}

// retireCard: the card_done tombstone (live + snapshot replay — the replay
// applies card then card_done IN ORDER, so a refreshed client renders the
// answered state for free). cards-ux2 01: the form swaps for a COLLAPSED
// reviewable summary (title + answered marker); clicking toggles a read-only
// question + per-field "label: answer" block built from the submit-time stash
// (art.cardAnswers — LIVE only; replay degrades to the collapsed summary).
// createElement/textContent ONLY — producer/user strings stay inert. An
// ABSENT article (ordering anomaly, a card that fell out of the transcript
// cap) is IGNORED — never an error.
function renderReport(frame) {
  if (!reportPaneEl) return;
  const art = document.createElement('article');
  art.className = 'card';
  art.id = 'report-' + (typeof frame.id === 'string' ? frame.id : String(frame.ts || Date.now()));
  const h = document.createElement('h4');
  h.textContent = typeof frame.title === 'string' ? frame.title : '';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const ms = document.createElement('span');
  ms.textContent = fmtClock(frame.ts) + ' · ' + (typeof frame.source === 'string' ? frame.source : '');
  meta.appendChild(ms);
  art.appendChild(h); art.appendChild(meta);
  const body = document.createElement('div');
  body.className = 'card-body';
  if (typeof frame.html === 'string' && frame.html !== '') {
    const ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', 'allow-scripts allow-downloads'); // NO allow-same-origin — allow-downloads unblocks export menus (archify PNG/SVG)
    ifr.srcdoc = frame.html; // property assignment — untrusted HTML stays sandboxed
    body.appendChild(ifr);
    // webui-v3 fix: a tall sandboxed doc scrolls INSIDE the frame (opaque
    // origin — the parent can never measure it) — give readers a fullscreen
    // escape hatch instead of forcing nested-scroll archaeology.
    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.textContent = 'fullscreen';
    fsBtn.style.cssText = 'margin-top:.35rem;align-self:flex-start;padding:.2rem .6rem;border:1px solid #8886;border-radius:4px;background:#8882;color:inherit;cursor:pointer;font-size:.75rem';
    fsBtn.addEventListener('click', function () { if (ifr.requestFullscreen) ifr.requestFullscreen(); });
    body.appendChild(fsBtn);
    // standalone door: /api/report/<id>/raw serves this frame as a TOP-LEVEL
    // page (native browser-edge scrolling + the same CSP as /files) — the
    // parent window opens it, so no sandbox/popups constraint applies.
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'open standalone \u2197';
    openBtn.style.cssText = 'margin-top:.35rem;align-self:flex-start;padding:.2rem .6rem;border:1px solid #8886;border-radius:4px;background:#8882;color:inherit;cursor:pointer;font-size:.75rem;margin-left:.4rem';
    openBtn.addEventListener('click', function () { window.open('/api/report/' + encodeURIComponent(frame.id) + '/raw', '_blank'); });
    body.appendChild(openBtn);
  } else if (typeof frame.markdown === 'string') {
    body.appendChild(renderMarkdown(frame.markdown));
  }
  art.appendChild(body);
  reportPaneEl.appendChild(art);
}

// tab-views (01): minimal markdown to DOM (createElement/textContent ONLY —
// md is producer-authored but untrusted; no HTML parsing on this path).
// FENCE avoids backticks: render-shell's JS lives inside a template literal.
function appendInline(el, text) {
  const parts = String(text).split(/(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*)/g);
  for (const p of parts) {
    if (!p) continue;
    if (p.indexOf('**') === 0 && p.lastIndexOf('**') === p.length - 2 && p.length > 4) { const b = document.createElement('strong'); b.textContent = p.slice(2, -2); el.appendChild(b); }
    else if (p.charAt(0) === '*' && p.charAt(p.length - 1) === '*' && p.length > 2) { const em = document.createElement('em'); em.textContent = p.slice(1, -1); el.appendChild(em); }
    else el.appendChild(document.createTextNode(p));
  }
}
function renderMarkdown(md) {
  const FENCE = String.fromCharCode(96, 96, 96);
  const wrap = document.createElement('div');
  wrap.className = 'md';
  const lines = String(md).split('\\n');
  let list = null, para = [], code = null;
  const flushPara = function () { if (para.length) { const p = document.createElement('p'); p.textContent = para.join(' '); wrap.appendChild(p); para = []; } };
  for (const raw of lines) {
    const line = raw.replace(/\\s+$/, '');
    if (code !== null) { if (line.indexOf(FENCE) === 0) { const pre = document.createElement('pre'); const c = document.createElement('code'); c.textContent = code.join('\\n'); pre.appendChild(c); wrap.appendChild(pre); code = null; } else code.push(line); continue; }
    if (line.indexOf(FENCE) === 0) { flushPara(); list = null; code = []; continue; }
    const hm = /^(#{1,3})\\s+(.*)$/.exec(line);
    if (hm) { flushPara(); list = null; const el = document.createElement('h' + String(hm[1].length + 1)); el.textContent = hm[2]; wrap.appendChild(el); continue; }
    const lim = /^[-*]\\s+(.*)$/.exec(line);
    if (lim) { flushPara(); if (!list) { list = document.createElement('ul'); wrap.appendChild(list); } const it = document.createElement('li'); appendInline(it, lim[1]); list.appendChild(it); continue; }
    if (line.trim() === '') { flushPara(); list = null; continue; }
    para.push(line.trim());
  }
  flushPara();
  if (code !== null) { const pre = document.createElement('pre'); pre.textContent = code.join('\\n'); wrap.appendChild(pre); }
  return wrap;
}

function retireCard(frame) {
  if (!cardsPaneEl) return;
  if (typeof frame.id !== 'string' || !frame.id) return;
  const art = document.getElementById(cardDomId(frame.id));
  if (!art) return; // ordering anomaly — ignore
  const form = art.querySelector('form.card-form');
  // cards-ux2 (02): a DRAFT card (blocking:false) FREEZES on card_done — it
  // never retires to the collapsed summary. The form STAYS (every input +
  // button disabled), a sent HH:MM:SS stamp (the tombstone ts) appears,
  // and the t01 collapsed-review toggle rides below the frozen form.
  if (form && form.getAttribute('data-draft') === '1') { freezeDraftCard(art, form, frame.ts); return; }
  if (form) {
    const stash = art.cardAnswers;
    // cards-ux2 (04): replay path — the tombstone carries answers rows.
    const frameRows = Array.isArray(frame.answers)
      ? frame.answers
          .filter(function (r) { return r != null && typeof r.label === 'string'; })
          .map(function (r) { return { label: r.label, answer: r.answer == null ? null : String(r.answer) }; })
      : null;
    const done = document.createElement('div');
    done.className = 'card-done';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'card-done-toggle';
    const title = document.createElement('span');
    title.className = 'card-done-title';
    const h4 = art.querySelector('h4');
    title.textContent = (h4 && h4.textContent) || 'card';
    const mark = document.createElement('span');
    mark.className = 'card-done-mark';
    mark.textContent = 'answered';
    head.appendChild(title);
    head.appendChild(mark);
    done.appendChild(head);
    if ((stash && typeof stash.question === 'string' && Array.isArray(stash.rows)) || (frameRows && frameRows.length > 0)) {
      const detail = document.createElement('div');
      detail.className = 'card-done-detail';
      detail.hidden = true;
      const q = document.createElement('p');
      q.textContent = stash.question;
      detail.appendChild(q);
      for (const r of stash.rows) {
        if (!r || typeof r.label !== 'string') continue; // malformed row — skip
        const line = document.createElement('p');
        line.className = 'card-done-answer';
        line.textContent = r.label + ': ' + (r.answer === null || r.answer === undefined ? '—' : String(r.answer));
        detail.appendChild(line);
      }
      head.onclick = function () { detail.hidden = !detail.hidden; };
      done.appendChild(detail);
    }
    form.replaceWith(done);
  }
  art.classList.add('card-answered');
}

// freezeDraftCard (cards-ux2 02): the DRAFT card_done path — FREEZE, never
// remove. Every input/select/button disables, the submit handler is
// neutralized (a stray Enter on a frozen form must never re-send), and the
// t01 collapsed-review toggle appends BELOW the frozen form: title +
// sent HH:MM:SS (the tombstone ts, local clock); click toggles the
// read-only question + per-field rows from the live submit-time stash
// (art.cardAnswers — LIVE only; a replayed frozen draft degrades to the
// stamp, its INPUT values are not persisted across refresh — v1). The
// whole path is createElement/textContent ONLY — no markup sinks exist.
function freezeDraftCard(art, form, ts) {
  form.querySelectorAll('input, select, button').forEach(function (el) { el.disabled = true; });
  form.onsubmit = function (ev) { ev.preventDefault(); return false; }; // frozen — never re-send
  const done = document.createElement('div');
  done.className = 'card-done';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'card-done-toggle';
  const title = document.createElement('span');
  title.className = 'card-done-title';
  const h4 = art.querySelector('h4');
  title.textContent = (h4 && h4.textContent) || 'card';
  const mark = document.createElement('span');
  mark.className = 'card-done-mark';
  mark.textContent = 'sent ' + fmtClock(typeof ts === 'number' ? ts : Date.now());
  head.appendChild(title);
  head.appendChild(mark);
  done.appendChild(head);
  const stash = art.cardAnswers;
  if (stash && typeof stash.question === 'string' && Array.isArray(stash.rows)) {
    const detail = document.createElement('div');
    detail.className = 'card-done-detail';
    detail.hidden = true;
    const q = document.createElement('p');
    q.textContent = stash.question;
    detail.appendChild(q);
    for (const r of stash.rows) {
      if (!r || typeof r.label !== 'string') continue; // malformed row — skip
      const line = document.createElement('p');
      line.className = 'card-done-answer';
      line.textContent = r.label + ': ' + (r.answer === null || r.answer === undefined ? '—' : String(r.answer));
      detail.appendChild(line);
    }
    head.onclick = function () { detail.hidden = !detail.hidden; }; // t01 collapsed-review semantics
    done.appendChild(detail);
  }
  form.after(done); // the frozen form STAYS — the marker rides below it
  art.classList.add('card-answered', 'card-sent');
}

// --- event-cards (04): viewer sandbox + webui.emit bridge + confirm gate ----
// A viewer card body is raw HTML (producer-sourced). It renders ONLY inside an
// iframe with sandbox="allow-scripts" — scripts run, but WITHOUT
// allow-same-origin the frame gets a UNIQUE OPAQUE ORIGIN: the parent DOM,
// /ws, /api and localStorage are all unreachable from inside. The BRIDGE SHIM
// is injected as a leading <script> so the ONLY way out is webui.emit ->
// postMessage -> the host confirm gate (nothing reaches the bus unconfirmed).
function appendViewerFrame(art, frame) {
  var b = frame.body;
  var html = b && typeof b.html === 'string' ? b.html : ''; // malformed -> inert empty frame
  var rawId = typeof frame.id === 'string' ? frame.id : '';
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts'); // scripts YES, same-origin NEVER
  f.className = 'card-viewer';
  // srcdoc is set via the DOM PROPERTY (never string-interpolated into an
  // attribute), so the value is the frame document source VERBATIM — no
  // attribute-escaping step exists on this path. The shim id rides a
  // JSON-stringified script literal ('<' escaped) so a hostile id can neither
  // break out of the string nor close the script tag early.
  f.srcdoc = cardBridgeShimInline(rawId) + html;
  art.appendChild(f);
}

// Inlined duplicate of the pure CARD_BRIDGE_SHIM twin (module-level export in
// render-shell.ts — the served script has no build step; same intentional
// duplication as APPEXEC_FRAME / parseCardHash).
function cardBridgeShimInline(cardId) {
  var idLit = JSON.stringify(String(cardId == null ? '' : cardId)).replace(/</g, '\\\\u003c');
  return '<script>window.webui = { emit: function (payload) { parent.postMessage({ __webuiCard: ' + idLit + ', payload: payload }, "*"); } };<\\/script>';
}

// The host side of the gate: every bridged emit becomes a LOCAL confirm card.
// The confirm id is a LOCAL counter — never derived from frame data (a spoofed
// __webuiCard cannot choose its id). article id 'card-confirm-<n>' equals
// cardDomId('confirm-<n>'), so the wiring's card_done tombstone for the
// Approve envelope finds and retires this article through the SAME t02
// retireCard path — free. Every string rides createElement/textContent ONLY.
var confirmSeq = 0;
function showConfirmCard(fromId, payload) {
  if (!cardsPaneEl) return;
  confirmSeq++;
  var n = confirmSeq;
  var art = document.createElement('article');
  art.id = 'card-confirm-' + n;
  art.className = 'card card-confirm';
  art.setAttribute('data-kind', 'confirm');
  art.setAttribute('data-attention', 'input');
  var h = document.createElement('h4');
  h.textContent = 'Confirm viewer emit';
  var meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = typeof fromId === 'string' && fromId ? 'from ' + fromId : 'from unknown card';
  var pre = document.createElement('pre');
  var shown;
  try { shown = JSON.stringify(payload); } catch { shown = undefined; } // circular refs etc.
  if (typeof shown !== 'string') shown = String(payload);
  pre.textContent = shown; // TEXT ONLY — the payload displays, never executes
  var bar = document.createElement('div');
  bar.className = 'webui-toolbar';
  var approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'Approve';
  approve.onclick = function () {
    // Approve rides the t02 card_answer envelope — cardId 'confirm-<n>'
    // (string answers), so the wiring appends the JSONL decision line and
    // broadcasts card_done exactly as for any interactive card.
    sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: 'confirm-' + n, answers: { emit: shown } } }));
    art.classList.add('card-answered'); // local marker (the card_done tombstone rides retireCard)
    approve.disabled = true;
    deny.disabled = true;
  };
  var deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Deny';
  deny.onclick = function () { art.remove(); }; // discard — nothing is sent
  bar.appendChild(approve);
  bar.appendChild(deny);
  art.appendChild(h);
  art.appendChild(meta);
  art.appendChild(pre);
  art.appendChild(bar);
  cardsPaneEl.appendChild(art);
  toggleCardsTab(true); // attention:input — the gate must be visible to act on
}

// --- event-cards (03): #card-<id> deep link --------------------------------
// parseCardHashInline duplicates the pure parseCardHash twin (module-level
// export in render-shell.ts — the served script has no build step; same
// intentional duplication as APPEXEC_FRAME). The id charset is
// regex-validated so the DOM lookup is getElementById ONLY — never a composed
// querySelector (no selector-string injection risk on this path).
function parseCardHashInline(hash) {
  var m = /^#card-([A-Za-z0-9_-]+)$/.exec(String(hash || ''));
  return m ? m[1] : null;
}

// Cold load: the snapshot arrives ASYNC over /ws (connect-time replay), so the
// article may not exist on the first look — retry with backoff (~6 tries over
// ~3s) before giving up quietly. Flash is add-once + remove after ~1.6s
// (matches the card-flash-pulse animation), guarded against duplicate adds.
var CARD_HASH_RETRY_DELAYS = [150, 250, 400, 600, 800, 800]; // ~3s total
function focusCardArticle(id, attempt) {
  const el = document.getElementById('card-' + id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!el.classList.contains('card-flash')) { // guard duplicate adds
      el.classList.add('card-flash');
      setTimeout(function () { el.classList.remove('card-flash'); }, 1600);
    }
    return;
  }
  if (attempt >= CARD_HASH_RETRY_DELAYS.length) return; // gave up quietly
  setTimeout(function () { focusCardArticle(id, attempt + 1); }, CARD_HASH_RETRY_DELAYS[attempt]);
}

// handleCardHash: #card-<id> -> activate the Cards tab + scroll/flash. Never
// throws (the whole body is try/caught — a deep link must never break boot).
function handleCardHash() {
  try {
    const id = parseCardHashInline(location.hash);
    if (id === null) return;
    const art = document.getElementById(cardDomId(id));
    const owner = art && art.closest ? art.closest('section') : null;
    const pid = owner ? owner.id : 'cards-pane';
    setPane(pid === 'report-pane' ? 'report' : pid === 'data-pane' ? 'data' : 'events');
    focusCardArticle(id, 0);
  } catch { /* never break boot */ }
}

// --- BTW tab: branch a chat question from current content (demo) --------
// The ask direction REVERSED: ask cards flow agent -> webui; a BTW branch
// flows webui -> agent. The composer seeds context from the Report tab (or
// none), POSTs /api/btw, and the pending list polls while the tab shows.
// The TUI agent drains it via the webui tool (mode: 'btw') and answers in
// chat, then resolves (button below does the same from the browser side).
var btwPollTimer = null;
function btwOptionsFromReports() {
  var arts = document.querySelectorAll('#report-pane article');
  var out = [];
  for (var i = arts.length - 1; i >= 0 && out.length < 12; i--) {
    var h = arts[i].querySelector('h4, h3');
    out.push({ id: arts[i].id.replace(/^report-/, ''), title: h ? h.textContent.trim().slice(0, 80) : arts[i].id });
  }
  return out;
}
function btwEl(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function renderBtwPane() {
  var pane = document.getElementById('btw-pane');
  if (!pane) return;
  fetch('/api/btw').then(function (r) { return r.json(); }).then(function (d) {
    pane.textContent = '';
    var box = btwEl('div', 'btw-box');
    box.appendChild(btwEl('h5', null, 'Branch a question from current content'));
    var sel = document.createElement('select');
    sel.id = 'btw-context';
    var optNone = document.createElement('option');
    optNone.value = '';
    optNone.textContent = '(no context — general question)';
    sel.appendChild(optNone);
    var opts = btwOptionsFromReports();
    opts.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.id;
      op.textContent = o.title;
      sel.appendChild(op);
    });
    box.appendChild(sel);
    var ta = document.createElement('textarea');
    ta.id = 'btw-question';
    ta.placeholder = 'e.g. why does this report show ... — branch: apply it to my repo';
    box.appendChild(ta);
    var chipsIn = document.createElement('input');
    chipsIn.id = 'btw-chips';
    chipsIn.placeholder = 'optional hints, comma-separated (like ask options)';
    box.appendChild(chipsIn);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btw-send';
    btn.textContent = 'Queue branch';
    btn.onclick = function () {
      var q = ta.value.trim();
      if (!q) { ta.focus(); return; }
      var chips = chipsIn.value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }).slice(0, 6);
      var aboutId = sel.value || undefined;
      var ctx = opts.filter(function (o) { return o.id === aboutId; })[0];
      fetch('/api/btw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, chips: chips, aboutId: aboutId, aboutTitle: ctx ? ctx.title : undefined }) })
        .then(function () { ta.value = ''; chipsIn.value = ''; renderBtwPane(); });
    };
    box.appendChild(btn);
    pane.appendChild(box);
    var pending = (d && d.pending) || [];
    if (!pending.length) {
      var empty = btwEl('div', 'btw-entry');
      empty.appendChild(btwEl('span', 'meta', 'How to use: pick context (from the Report tab), type a question, add optional hint chips, press Queue branch. The TUI agent is belled the moment you queue — it answers in chat and marks this resolved. Questions survive restarts.'));
      pane.appendChild(empty);
      return;
    }
    pending.forEach(function (e) {
      var card = btwEl('div', 'btw-entry');
      card.appendChild(btwEl('span', 'meta', (e.aboutTitle ? 'from: ' + e.aboutTitle : 'general') + ' · ' + new Date(e.createdAt).toLocaleTimeString() + ' · queued — the agent was belled in the TUI; answer lands in chat'));
      card.appendChild(btwEl('div', null, e.question));
      if (e.chips && e.chips.length) {
        var row = btwEl('div', 'btw-chips');
        e.chips.forEach(function (c) { row.appendChild(btwEl('span', 'btw-chip', c)); });
        card.appendChild(row);
      }
      var done = document.createElement('button');
      done.type = 'button';
      done.className = 'btw-resolve';
      done.textContent = 'resolved';
      done.onclick = function () {
        fetch('/api/btw/' + encodeURIComponent(e.id) + '/resolve', { method: 'POST' }).then(function () { renderBtwPane(); });
      };
      card.appendChild(done);
      pane.appendChild(card);
    });
  }).catch(function () { /* pane keeps last render */ });
}
function renderDataPane() {
  var pane = document.getElementById('data-pane');
  if (!pane) return;
  fetch('/api/data/summary').then(function (r) { return r.json(); }).then(function (d) {
    var old = document.getElementById('data-telemetry');
    if (old) old.remove();
    var art = btwEl('article', 'tel');
    art.id = 'data-telemetry';
    art.appendChild(btwEl('h4', null, 'Pipeline telemetry'));
    var dl = document.createElement('dl');
    Object.keys(d).forEach(function (k) {
      dl.appendChild(btwEl('dt', null, k));
      dl.appendChild(btwEl('dd', null, String(d[k])));
    });
    art.appendChild(dl);
    var hint = btwEl('div', 'meta', 'Data tab scenarios: telemetry (this) · raw frame explorer · artifacts registry · ask analytics — see README.');
    hint.style.marginTop = '.4rem';
    art.appendChild(hint);
    pane.insertBefore(art, pane.firstChild);
  }).catch(function () { /* keep existing viewers */ });
}
// Loop closure (browser half): badge the BTW tab whenever a question waits,
// from ANY tab — a 15s visibility-gated poll (the 4s detail poll only runs
// while the BTW pane itself shows).
function btwBadgeUpdate() {
  fetch('/api/btw').then(function (r) { return r.json(); }).then(function (d) {
    var tab = document.getElementById('pane-tab-btw');
    if (!tab) return;
    var n = (d && d.pending && d.pending.length) || 0;
    var b = tab.querySelector('.tab-badge');
    if (n > 0) {
      if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; tab.appendChild(b); }
      b.textContent = String(n);
    } else if (b) b.remove();
  }).catch(function () { /* offline tab keep */ });
}
setInterval(function () { if (document.visibilityState === 'visible') btwBadgeUpdate(); }, 15000);
function btwPollStart() {
  if (btwPollTimer) return;
  btwPollTimer = setInterval(function () {
    if (activePane === 'btw' && document.visibilityState === 'visible') { renderBtwPane(); btwBadgeUpdate(); }
  }, 4000);
}
function btwPollStop() { if (btwPollTimer) { clearInterval(btwPollTimer); btwPollTimer = null; } }

// --- ask-user bridge dialog (§C3) -------------------------------------
// Mirrors the core-task questionnaire: options as toggle buttons,
// multiSelect as multi-toggle, a free-text row per question. Submit rides
// the loose appexec channel; core-task routes it through the SAME done the
// TUI submit uses (first answer wins; a late submit is an inert no-op).
let askUserEl = null;
var askUserPromptId = null;
function renderAskUser(frame) {
  askUserPromptId = frame.promptId;
  if (askUserEl) askUserEl.remove();
  askUserEl = document.createElement('div');
  askUserEl.id = 'ask-user-dialog';
  askUserEl.style.cssText = 'position:fixed;bottom:3.5rem;left:50%;transform:translateX(-50%);width:min(560px,92vw);max-height:60vh;overflow:auto;z-index:60;box-shadow:0 4px 18px #0008';
  document.body.appendChild(askUserEl);
  const state = { promptId: frame.promptId, picks: {} };
  (frame.questions || []).forEach(function (q, qi) {
    var block = document.createElement('div');
    block.style.marginBottom = '.6rem';
    var chip = document.createElement('span');
    chip.className = 'meta';
    chip.textContent = q.header || '';
    var text = document.createElement('div');
    text.textContent = q.question || '';
    block.appendChild(chip);
    block.appendChild(text);
    (q.options || []).forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.style.cssText = 'display:block;width:100%;text-align:left;margin:.15rem 0;padding:.3rem .5rem;border-radius:6px;border:1px solid #8884;background:#8882;color:inherit;cursor:pointer';
      b.onclick = function () {
        if (!Array.isArray(state.picks[qi])) state.picks[qi] = q.multiSelect ? [] : null;
        if (q.multiSelect) {
          var arr = state.picks[qi];
          var i = arr.indexOf(o.label);
          if (i >= 0) arr.splice(i, 1); else arr.push(o.label);
          b.style.borderColor = arr.indexOf(o.label) >= 0 ? '#6cf' : '#8884';
        } else {
          Array.prototype.forEach.call(block.querySelectorAll('button'), function (sib) { sib.style.borderColor = '#8884'; });
          state.picks[qi] = o.label;
          b.style.borderColor = '#6cf';
        }
      };
      block.appendChild(b);
      if (o.description) {
        var d = document.createElement('div');
        d.className = 'meta';
        d.textContent = o.description;
        block.appendChild(d);
      }
    });
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Type something.';
    inp.style.cssText = 'width:100%;margin-top:.3rem;padding:.3rem .5rem;border-radius:6px;border:1px solid #8884;background:#0000;color:inherit';
    inp.oninput = function () { state.picks[qi] = inp.value; };
    block.appendChild(inp);
    askUserEl.appendChild(block);
  });
  var submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = 'Submit';
  submit.style.cssText = 'padding:.4rem 1rem;border-radius:6px;border:1px solid #6cf;background:#6cf3;color:inherit;cursor:pointer';
  submit.onclick = function () {
    // cards-ux2 01: THE canonical row shape (same as the ask-card submit —
    // render-shell L515). The old bare {question, answer} map rows lack
    // 'kind'/'questionIndex', so the task-side envelope formatter's switch
    // fell through and the orchestrator literally saw "undefined" as the
    // tool result. Picks map: array -> multi (selected), a string matching an
    // option label -> option, anything else -> custom; unpicked -> null.
    var answers = (frame.questions || []).map(function (q, qi) {
      var v = state.picks[qi];
      if (Array.isArray(v)) return { questionIndex: qi, question: q.question, kind: 'multi', answer: null, selected: v };
      var labels = (q.options || []).map(function (o) { return o.label; });
      var isOpt = typeof v === 'string' && labels.indexOf(v) >= 0;
      return { questionIndex: qi, question: q.question, kind: isOpt ? 'option' : 'custom', answer: v === undefined ? null : v };
    });
    sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'ask_user_answer', promptId: frame.promptId, result: { cancelled: false, answers: answers } } }));
    askUserEl.remove();
    askUserEl = null;
  };
  askUserEl.appendChild(submit);
}

// One response per presentation: remembered across SSE re-renders so the
// toolbar re-renders disabled with the chosen control marked.
let respondedPresent = null; // { id, action }

function renderControls(v) {
  if (!v.presentId || !v.controls || !v.controls.length) return;
  const done = respondedPresent && respondedPresent.id === v.presentId;
  const bar = document.createElement('div');
  bar.className = 'webui-toolbar';
  v.controls.forEach(function (c) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = c.label || c.id;
    if (done) btn.disabled = true;
    if (done && respondedPresent.action === c.id) btn.classList.add('webui-chosen');

    // takesInput controls reveal a tweak input + Enter-to-send (#03 pattern).
    const box = document.createElement('span');
    box.className = 'webui-tweak';
    box.style.display = 'none';
    const tweakIn = document.createElement('input');
    tweakIn.type = 'text';
    tweakIn.placeholder = 'tweak (optional)';
    tweakIn.size = 30;
    const tweakSend = document.createElement('button');
    tweakSend.type = 'button';
    tweakSend.textContent = 'Send';
    function submit() {
      const t = (tweakIn.value || '').trim();
      sendAppexecResponse(v.presentId, c.id, t || undefined);
      respondedPresent = { id: v.presentId, action: c.id };
      bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      btn.classList.add('webui-chosen');
      box.style.display = 'none';
    }
    tweakSend.onclick = submit;
    tweakIn.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return; // IME composition — never a send
      e.preventDefault(); submit();
    });
    box.appendChild(tweakIn);
    box.appendChild(tweakSend);

    btn.onclick = function () {
      if (btn.disabled) return;
      if (c.takesInput && box.style.display === 'none') {
        box.style.display = '';
        tweakIn.focus();
      } else {
        submit();
      }
    };
    bar.appendChild(btn);
    bar.appendChild(box);
  });
  // v2 (architecture v2 §3.4): a Cancel button — resolves the ONE pending
  // presentation as {cancelled:true} via the appexec cancel op, so the user
  // can dismiss a presentation without dropping the socket (which would abort
  // every pending and force a re-present).
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.title = 'Cancel this presentation (the agent sees {cancelled:true})';
  cancelBtn.disabled = done;
  cancelBtn.onclick = function () {
    if (cancelBtn.disabled) return;
    cancelBtn.disabled = true;
    sendAppexecCancel(v.presentId);
    respondedPresent = { id: v.presentId, action: '' };
    bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
  };
  bar.appendChild(cancelBtn);
  contentEl.appendChild(bar);
}

(async function () {
  const clearLink = document.getElementById('webui-log-clear');
  if (clearLink) clearLink.onclick = function (e) {
    e.preventDefault();
    const body = document.getElementById('webui-feedback-log-body');
    if (body) body.innerHTML = '';
  };
  // v2 (architecture v2 §3.6): a rejected initial fetch must not permanently
  // skip subscribe() — retry the whole boot.
  try {
    await refresh();
    handleCardHash(); // event-cards (03): #card-<id> deep link — after the first render; the retry backoff covers the async snapshot
    handlePaneHash(); // hash-addressable panes: #report/#data/#btw/#inbox restore on load + refresh
    subscribe();
    window.addEventListener('hashchange', function () { handleCardHash(); handlePaneHash(); }); // live re-route on later hash changes (cards first — they own routing)
    // event-cards (04): host listener for the viewer bridge — ONE global
    // message listener. A postMessage carrying __webuiCard becomes a LOCAL
    // confirm card (Approve -> the t02 card_answer loop, Deny -> discard).
    // Deliberately minimal per scope: NO origin allowlist, NO anti-spoofing —
    // the sandbox attribute + the confirm gate ARE the security surface.
    try {
      window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || typeof d.__webuiCard !== 'string') return;
        showConfirmCard(d.__webuiCard, d.payload);
      });
    } catch { /* never break boot */ }
  } catch (e) {
    console.warn('[webui] boot failed; reloading in 2s', e);
    setTimeout(function () { location.reload(); }, 2000);
  }
})();
</script>
</body>
</html>`;

/**
 * Pure appexec respond frame (phase 3, spec Component 4). This is the PINNED
 * wire shape the inline browser script above duplicates; tests assert against
 * it so the exact frame is gridded WITHOUT a DOM. The inline script must
 * inline the same logic (the served HTML string has no module / build step),
 * so it is intentionally duplicated here. `tweak` is omitted when undefined —
 * matching the present-tool details semantics (protocol.ts DispatchAction
 * respond variant makes tweak optional).
 */
export const APPEXEC_FRAME = (
  id: string,
  action: string,
  tweak?: string,
): { type: "appexec"; extra: { kind: "respond"; id: string; action: string; tweak?: string } } => {
  const extra: { kind: "respond"; id: string; action: string; tweak?: string } = {
    kind: "respond",
    id,
    action,
  };
  if (tweak !== undefined && tweak !== "") extra.tweak = tweak;
  return { type: "appexec", extra };
};

/**
 * Pure appexec CARD_ANSWER frame (event-cards 02) — the PINNED wire shape the
 * inline browser script's card-form submit duplicates; tests grid the exact
 * envelope WITHOUT a DOM (same convention as APPEXEC_FRAME /
 * APPEXEC_CANCEL_FRAME). `answers` is the collected
 * Object.fromEntries(new FormData(form)) — field name -> string.
 */
export function APPEXEC_CARD_ANSWER(
  cardId: string,
  answers: Record<string, string>,
): { type: "appexec"; extra: { kind: "card_answer"; cardId: string; answers: Record<string, string> } } {
  return { type: "appexec", extra: { kind: "card_answer", cardId, answers } };
}

/**
 * Pure appexec CARD_SEND frame (cards-ux2 02) — the PINNED wire shape the
 * inline browser script's DRAFT card-form submit duplicates; tests grid the
 * exact envelope WITHOUT a DOM (same convention as APPEXEC_CARD_ANSWER).
 * Semantics vs card_answer: card_answer resolves the MODAL answer loop
 * (first valid answer wins, the form retires on card_done); card_send
 * delivers DRAFT state into the agent session via the wiring's sendMessage
 * seam — the shell form only FREEZES when the inbound card_done tombstone
 * arrives (no optimistic state).
 */
export function APPEXEC_CARD_SEND(
  cardId: string,
  answers: Record<string, string>,
): { type: "appexec"; extra: { kind: "card_send"; cardId: string; answers: Record<string, string> } } {
  return { type: "appexec", extra: { kind: "card_send", cardId, answers } };
}

/**
 * Pure ask-card submit frame (event-cards 05) — the PINNED wire shape the
 * inline `appendCardForm` submit duplicates for ask cards (id ask-<promptId>):
 * the ask_user_answer appexec envelope (NOT card_answer — the unify choice;
 * ask answers ride the existing ask-user bridge and never touch the t02 JSONL
 * loop). `promptId` is the card id minus the ask- prefix; each rendered field
 * maps to a proper `{questionIndex, question, kind, answer}` row (the ask-user
 * envelope formatter keys on questionIndex + kind; select -> option,
 * text -> custom). Tests grid this pure twin AND assert the inline literal so
 * the duplication stays honest.
 */
export function APPEXEC_ASK_CARD_ANSWER(
  cardId: string,
  answers: Record<string, string>,
  fields: Array<{ name: string; label?: string; type?: string }>,
): {
  type: "appexec";
  extra: {
    kind: "ask_user_answer";
    promptId: string;
    result: {
      cancelled: boolean;
      answers: Array<{ questionIndex: number; question: string; kind: "option" | "custom"; answer: string | null }>;
    };
  };
} {
  return {
    type: "appexec",
    extra: {
      kind: "ask_user_answer",
      promptId: cardId.replace(/^ask-/, ""),
      result: {
        cancelled: false,
        answers: fields.map((f, i) => ({
          questionIndex: i,
          question: typeof f.label === "string" ? f.label : f.name,
          kind: f.type === "select" ? "option" : "custom",
          answer: answers[f.name] !== undefined ? answers[f.name] : null,
        })),
      },
    },
  };
}

/**
 * Pure #card-<id> hash parser (event-cards 03). The inline shell script
 * duplicates this as the literal regex in `parseCardHashInline` (the served
 * HTML string has no module/build step — same intentional duplication as
 * APPEXEC_FRAME); tests grid this pure twin AND assert the
 * inline literal so the duplication stays honest. Anything but `#card-` +
 * [A-Za-z0-9_-]+ is null — the validated id only ever feeds getElementById
 * (never a composed querySelector).
 */
export function parseCardHash(hash: string): string | null {
  const m = /^#card-([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1]! : null;
}

/**
 * Pure viewer-card BRIDGE SHIM (event-cards 04) — the leading <script>
 * injected into every viewer srcdoc. Defines `window.webui = { emit }` inside
 * the sandboxed frame: emit posts `{ __webuiCard: cardId, payload }` to the
 * parent, where the host message listener wraps it into a confirm card. The
 * card id rides a JSON-stringified script literal with `<` escaped
 * (`\u003c`) so a hostile id can neither break out of the string literal nor
 * close the script tag early. The inline shell script duplicates this as
 * `cardBridgeShimInline` (the served HTML string has no module/build step —
 * same intentional duplication as APPEXEC_FRAME / parseCardHash); tests grid
 * this pure twin AND assert the inline literal so the duplication stays honest.
 */
export function CARD_BRIDGE_SHIM(cardId: string): string {
  const idLit = JSON.stringify(String(cardId ?? "")).replace(/</g, "\\u003c");
  return (
    '<script>window.webui = { emit: function (payload) { parent.postMessage({ __webuiCard: ' +
    idLit +
    ', payload: payload }, "*"); } };</script>'
  );
}

/**
 * Pure appexec CANCEL frame (v2, architecture v2 §3.4). The PINNED wire shape
 * the inline browser script's `sendAppexecCancel` duplicates; tests grid the
 * exact frame WITHOUT a DOM. Resolves the ONE pending presentation under `id`
 * as {cancelled:true} — the browser's Cancel button (vs WS close, which
 * aborts every pending).
 */
export function APPEXEC_CANCEL_FRAME(id: string): {
  type: "appexec";
  extra: { kind: "cancel"; id: string };
} {
  return { type: "appexec", extra: { kind: "cancel", id } };
}
