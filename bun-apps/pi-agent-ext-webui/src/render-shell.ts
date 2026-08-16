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
 *   - view_opened frames (live + snapshot replay, effort webui-view-notifications):
 *     fresh ones (<10s) toast (click = per-URL window handle, mutex untouched);
 *     ALL frames feed the views panel (newest-first, <24h, cap 8, open/copy/
 *     dismiss) + a 1s /api/views poll backstop while the panel is expanded.
 *     url-mode tabs open top-level — NEVER into the sandbox srcdoc iframe.
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
 *   - DE-CHAT (event-cards 00): chat lives in the TUI — the v2 main-session
 *     composer (prompt input + Send + Abort) is GONE; the webui keeps only
 *     web-native interaction (btw side channel, HITL appexec, ask-user).
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
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif; }
  header { display: flex; gap: .5rem; padding: .5rem; border-bottom: 1px solid #8884; flex-wrap: wrap; }
  .tab { padding: .35rem .7rem; border-radius: 6px; cursor: pointer; border: 1px solid transparent; background: #8882; }
  .tab.active { border-color: #6cf; background: #6cf3; }
  main { padding: 1rem; max-width: 1100px; margin: 0 auto; }
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
  /* view notifications (effort webui-view-notifications): toast stack + views panel. */
  #webui-view-toasts { position: fixed; right: .6rem; bottom: 40vh; width: 22rem; max-width: 70vw; display: flex; flex-direction: column; gap: .4rem; z-index: 60; }
  .webui-view-toast { background: #16324f; color: #eee; border: 1px solid #6cf6; border-radius: 6px; padding: .5rem .6rem; cursor: pointer; box-shadow: 0 2px 10px #0006; font-size: 13px; }
  .webui-view-toast:hover { background: #1d4a75; }
  .webui-view-toast .webui-view-toast-title { font-weight: 600; }
  .webui-view-toast .webui-view-toast-sub { opacity: .75; font-size: 11px; word-break: break-all; }
  #webui-views-panel { position: fixed; right: .6rem; top: 3.2rem; width: 22rem; max-width: 70vw; max-height: 45vh; overflow: auto; background: #0009; color: #eee; border-radius: 6px; padding: .45rem .55rem; font: 12px/1.45 ui-monospace, monospace; box-shadow: 0 2px 10px #0006; z-index: 55; }
  #webui-views-panel .webui-log-head a { color: #9cf; cursor: pointer; text-decoration: none; }
  .webui-view-row { display: flex; gap: .35rem; align-items: center; border-bottom: 1px solid #fff2; padding: .25rem 0; }
  .webui-view-row .webui-view-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .webui-view-row button { font-size: 11px; padding: 1px 6px; border: 1px solid #8886; border-radius: 4px; background: #8882; color: inherit; cursor: pointer; }
  .webui-view-row button:hover:not(:disabled) { background: #6cf3; }
  .webui-view-row button:disabled { opacity: .45; cursor: default; }
  /* Collapse persists under localStorage key "webui-views-collapsed" (btw precedent). */
  body.views-collapsed #webui-views-list { display: none; }
  /* btw side panel (Task 9): shell-row flex layout + collapsed hide rule. */
  #shell-row { display: flex; flex: 1 1 auto; min-height: 0; }
  #shell-row > main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  #btw-panel { flex: 0 0 340px; display: flex; flex-direction: column; border-left: 1px solid #8884; padding: .5rem; gap: .4rem; min-height: 0; }
  /* Collapse state persists under localStorage key "btw-panel-collapsed" (Task 10 wires the toggle). */
  body.btw-collapsed #btw-panel { display: none; }
  #btw-messages { flex: 1 1 auto; overflow-y: auto; font-size: 13px; }
  .btw-msg { margin: 4px 0; padding: 6px 8px; border-radius: 6px; background: #8881; }
  .btw-msg.btw-user { background: #16324f; }
  .btw-status { display: block; margin-top: 4px; color: #e0a030; font-size: 11px; }
  .btw-notice { margin: 4px 0; padding: 6px 8px; border-radius: 6px; color: #7ec87e; background: #14290f; font-size: 12px; }
  #btw-bar { display: flex; flex-wrap: wrap; gap: 4px; }
  #btw-bar button, #btw-bar select { font-size: 12px; padding: 3px 8px; }
  #btw-compose { display: flex; gap: 4px; }
  #btw-input { flex: 1 1 auto; }
  /* v2 live transcript (architecture v2 §3.3): the agent stream rendered as a
     mirror — message deltas, tool calls, mutex signals. De-chat (event-cards
     00): full-height — the compose bar that sat below #shell-row is gone. */
  #webui-transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: .6rem 1rem; font-size: 13px; }
  #webui-transcript .tx-turn { margin: .8rem 0 .2rem; color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  #webui-transcript .tx-msg { margin: .2rem 0; white-space: pre-wrap; word-break: break-word; }
  #webui-transcript .tx-tool { margin: .2rem 0; color: #9cf; }
  #webui-transcript .tx-mutex { margin: .2rem 0; color: #e0a030; }
  #webui-transcript .tx-settled { margin: .3rem 0; color: #7ec87e; font-size: 11px; }
  /* event-cards (01): Cards tab pane — projected card frames. Every field is
     textContent-rendered (raw HTML injection forbidden); the article id is the
     deep-link anchor; newest LAST (chronological). Badge color per attention. */
  #cards-pane { display: flex; flex-direction: column; gap: .5rem; padding: .4rem 0; max-height: 45vh; overflow-y: auto; }
  #cards-pane[hidden] { display: none; } /* the flex display must not defeat [hidden] */
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
  #cards-pane .card p.card-answered { margin-top: .4rem; font-size: .75rem; color: #888; font-style: italic; }
  #cards-pane .card.card-answered { opacity: .65; }
</style>
</head>
<body>
<header id="tabs"><span id="session-status" style="margin-left:auto;color:#888;font-size:.8rem;align-self:center"></span></header>
<div id="shell-row">
<main>
  <div class="meta" id="meta"></div>
  <div id="content"></div>
  <section id="cards-pane" hidden></section>
  <div id="webui-transcript"></div>
</main>
<aside id="btw-panel">
  <div id="btw-bar">
    <button id="btw-collapse" title="Collapse/expand the btw panel">«</button>
    <button id="btw-new">New</button>
    <button id="btw-clear">Clear</button>
    <button id="btw-inject">Inject</button>
    <button id="btw-summarize">Summarize</button>
    <button id="btw-mode">Mode: contextual</button>
    <select id="btw-model"><option value="">Main session model</option></select>
    <select id="btw-thinking">
      <option value="">Thinking: main default</option>
      <option value="off">off</option>
      <option value="minimal">minimal</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="xhigh">xhigh</option>
      <option value="max">max</option>
    </select>
  </div>
  <div id="btw-messages"></div>
  <div id="btw-compose">
    <input id="btw-input" type="text" placeholder="Ask a tangent question..." />
    <button id="btw-ask">Ask</button>
  </div>
</aside>
</div>
<div id="webui-views-panel">
  <div class="webui-log-head"><span>views (<span id="webui-views-count">0</span>)</span><a id="webui-views-collapse" href="#" title="Collapse/expand the views panel">«</a></div>
  <div id="webui-views-list"></div>
</div>
<div id="webui-view-toasts"></div>
<div id="webui-feedback-log">
  <div class="webui-log-head"><span>response log</span><a id="webui-log-clear" href="#">clear</a></div>
  <div id="webui-feedback-log-body"></div>
</div>
<script>
const tabsEl = document.getElementById('tabs');
const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
let activeId = location.hash.slice(1) || 'main';
// v2 (architecture v2 §3.6): monotonic render token — an older fetch resolving
// after a newer one must not overwrite newer content (async interleave race).
let renderSeq = 0;

function fmtTime(ms) { try { return new Date(ms).toLocaleString(); } catch { return ''; } }

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
        // iframe — route to the SAME top-level open/focus handler as the toast
        // (the id→url map is frame-fed; /api/views carries no url).
        const entry = viewEntries.find((e) => e.id === v.id);
        if (entry && entry.url) openViewUrl(entry.url);
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
  cardsTab.textContent = 'Cards';
  cardsTab.title = 'projected event cards';
  cardsTab.onclick = function () {
    cardsVisible = !cardsVisible;
    cardsPaneEl.hidden = !cardsVisible;
    cardsTab.classList.toggle('active', cardsVisible);
  };
  tabsEl.appendChild(cardsTab);
  if (!views.some(v => v.id === activeId)) activeId = (views[0] && views[0].id) || 'main';
  viewsMergePoll(views); // same fetch doubles as the panel's poll backstop
  viewsRenderPanel();
  viewsPollSync();
  return views;
}

async function renderView(id) {
  const seq = ++renderSeq;
  const res = await fetch('/api/view/' + encodeURIComponent(id));
  if (seq !== renderSeq) return; // superseded by a newer render — drop the stale write
  if (!res.ok) { contentEl.innerHTML = '<p>no view</p>'; return; }
  const v = await res.json();
  // 02-A guardrail (defensive — tab clicks already intercept url mode): if a
  // url view ever reaches renderView (e.g. via hash/activeId default), open it
  // top-level instead of sandboxing an empty body. The url comes from the
  // frame-fed map — /api/view/:id carries no url field for url views.
  if (v.mode === 'url') {
    const entry = viewEntries.find((e) => e.id === id);
    metaEl.textContent = (v.title ? (v.title + ' · ') : '') + 'url view · updated ' + fmtTime(v.updatedAt);
    contentEl.innerHTML = '';
    if (entry && entry.url) openViewUrl(entry.url);
    return;
  }
  // event-cards (01): scope the active toggle to VIEW tabs (.tab[data-view-id])
  // so the Cards tab (no data-view-id) keeps its own active state below.
  document.querySelectorAll('.tab[data-view-id]').forEach(function (t) {
    t.classList.toggle('active', t.dataset.viewId === id);
  });
  metaEl.textContent = (v.title ? (v.title + ' · ') : '') + 'mode ' + v.mode + ' · updated ' + fmtTime(v.updatedAt);
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
  // Inbound consumers of the /ws socket: btw events (side panel), the v2
  // connect-time snapshot (history replay), and every other frame -> the live
  // transcript mirror (v1 dropped all non-btw frames — mutex signals and the
  // agent stream were invisible in the browser).
  ws.onmessage = function (message) {
    let frame; try { frame = JSON.parse(message.data); } catch { return; }
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'btw' && frame.event) { btwApplyEvent(frame.event); return; }
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
// Renders the agent stream (message deltas, tool calls, mutex signals) as a
// scrollback mirror — the research-backed pattern (gptme/OmniTerm: "render from
// the structured event stream"). A connect-time snapshot replaces the mirror
// with an authoritative replay of the session history.
const txEl = document.getElementById('webui-transcript');

function txEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function txAppend(html) {
  if (!txEl) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  txEl.appendChild(wrap.firstChild);
  txEl.scrollTop = txEl.scrollHeight;
}

function txLine(cls, text) {
  txAppend('<div class="' + cls + '">' + txEsc(text) + '</div>');
}

function txApply(frame) {
  switch (frame.type) {
    case 'turn_start': txAppend('<div class="tx-turn">turn</div>'); break;
    case 'message_update':
      if (frame.text) txLine('tx-msg', frame.text);
      break;
    case 'tool_execution_start': txLine('tx-tool', 'tool ' + (frame.toolName || '?') + ' \u2026'); break;
    case 'tool_execution_end': txLine('tx-tool', 'tool ' + (frame.toolName || '?') + ' done'); break;
    case 'tool_result':
      if (frame.details) txLine('tx-tool', 'result: ' + JSON.stringify(frame.details).slice(0, 240));
      break;
    case 'agent_settled': txAppend('<div class="tx-settled">settled</div>'); break;
    case 'mutex_blocked': txLine('tx-mutex', 'mutex: ' + frame.blocked + ' blocked by ' + frame.by); break;
    case 'mutex_force_release': txLine('tx-mutex', 'mutex force-released (' + frame.driver + ')'); break;
    case 'error': txLine('tx-mutex', 'error: ' + (frame.reason || 'unknown')); break;
    case 'view_opened':
      // view notifications (03-B/04-C): all frames feed the panel; only fresh
      // ones (<VIEW_TOAST_FRESH_MS) toast — replayed/stale frames never re-toast.
      if (typeof frame.url === 'string' && typeof frame.ts === 'number') viewApplyFrame(frame);
      break;
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
    default: break; // other frames handled elsewhere
  }
}

function txRenderSnapshot(state) {
  if (!txEl) return;
  txEl.innerHTML = ''; // authoritative replay — replace, never append over stale
  // event-cards (01): the cards pane replays with the SAME authoritative
  // semantics — reset before the transcript replay, then txApply re-appends
  // (a card that fell out of the bounded transcript cap disappears).
  if (cardsPaneEl) cardsPaneEl.textContent = '';
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
let cardsVisible = false;

// The frame id already carries the card- prefix when wiring-generated
// (card-<n>, per-session counter); prefix only foreign producer ids so EVERY
// anchor is #card-<x>.
function cardDomId(id) { return /^card-/.test(id) ? id : 'card-' + id; }

function renderCard(frame) {
  if (!cardsPaneEl) return;
  const rawId = typeof frame.id === 'string' ? frame.id : '';
  const domId = cardDomId(rawId);
  if (domId && document.getElementById(domId)) return; // live/replay interleave dedupe
  const attention = frame.attention === 'view' || frame.attention === 'input' ? frame.attention : 'silent';
  const kind = frame.kind === 'interactive' || frame.kind === 'viewer' ? frame.kind : 'readonly';
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
  art.appendChild(h);
  art.appendChild(meta);
  art.appendChild(body);
  // event-cards (02): interactive cards carry { question, fields } instead of
  // { text } — the body div stays empty and the fill-in form appends after it
  // (an absent/malformed interactive body degrades to the inert card above).
  if (kind === 'interactive') appendCardForm(art, frame);
  cardsPaneEl.appendChild(art); // newest LAST — chronological
}

// --- event-cards (02): interactive fill-in form + card_done tombstone --------
// appendCardForm: EVERY string rides createElement/textContent ONLY — no
// markup sinks exist (question/labels/options are producer-sourced, i.e.
// UNTRUSTED; same contract as the readonly body text). The data-card-id
// attribute carries the RAW frame id — the same key handleCardAnswer
// correlates on (never the prefixed dom id). Invalid fields are SKIPPED, not
// fatal.
function appendCardForm(art, frame) {
  var b = frame.body;
  if (!b || typeof b.question !== 'string' || !Array.isArray(b.fields)) return; // malformed — inert text card
  const cardId = typeof frame.id === 'string' ? frame.id : '';
  const form = document.createElement('form');
  form.className = 'card-form';
  form.setAttribute('data-card-id', cardId);
  const q = document.createElement('p');
  q.className = 'card-question';
  q.textContent = b.question;
  form.appendChild(q);
  for (const f of b.fields) {
    if (!f || typeof f.name !== 'string' || !f.name) continue; // skip invalid fields
    if (f.type !== 'text' && f.type !== 'select') continue; // unknown field type — skip
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
  form.appendChild(btn);
  // Submit collects EVERY named field in one shot (FormData) and posts a
  // loose appexec card_answer envelope — the SAME loose-extra channel the
  // ask-user dialog uses. DEVIATION from the ask dialog (documented): this
  // goes through sendRaw, NOT raw ws.send — sendRaw queues while the WS is
  // reconnecting (v2 queue-never-drop), so an answer typed during a retry
  // lands instead of dropping. NO optimistic local state: card_done drives
  // the retire (first answer wins, enforced server-side).
  form.onsubmit = function (ev) {
    ev.preventDefault(); // never navigate — the answer rides /ws
    var answers = Object.fromEntries(new FormData(form));
    sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: cardId, answers: answers } }));
    return false;
  };
  art.appendChild(form);
}

// retireCard: the card_done tombstone (live + snapshot replay — the replay
// applies card then card_done IN ORDER, so a refreshed client renders the
// answered state for free). The form swaps for an inert answered marker; the
// card itself stays as history. An ABSENT article (ordering anomaly, a card
// that fell out of the transcript cap) is IGNORED — never an error.
function retireCard(frame) {
  if (!cardsPaneEl) return;
  if (typeof frame.id !== 'string' || !frame.id) return;
  const art = document.getElementById(cardDomId(frame.id));
  if (!art) return; // ordering anomaly — ignore
  const form = art.querySelector('form.card-form');
  if (form) {
    const done = document.createElement('p');
    done.className = 'card-answered';
    done.textContent = 'answered';
    form.replaceWith(done);
  }
  art.classList.add('card-answered');
}

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
    var answers = (frame.questions || []).map(function (q, qi) {
      return { question: q.question, answer: state.picks[qi] === undefined ? null : state.picks[qi] };
    });
    ws.send(JSON.stringify({ type: 'appexec', extra: { kind: 'ask_user_answer', promptId: frame.promptId, result: { answers: answers } } }));
    askUserEl.remove();
    askUserEl = null;
  };
  askUserEl.appendChild(submit);
}

// --- btw side panel client logic (Task 10) ---
// Pull-then-subscribe: GET /api/btw + /api/btw/models on load, then inbound
// { type: 'btw', event } frames over the SAME /ws socket keep the panel live.
let btwState = { messages: [], mode: 'contextual', model: null, thinking: null };
let btwModels = [];

function btwApplyCollapsed() {
  document.body.classList.toggle('btw-collapsed', localStorage.getItem('btw-panel-collapsed') === '1');
}

function btwRenderMessages(messages) {
  const list = document.getElementById('btw-messages');
  if (!list) return;
  const seen = {};
  messages.forEach(function (m) {
    seen[m.id] = true;
    const existing = list.querySelector('[data-id="' + m.id + '"]');
    const html = btwMessageHtml(m);
    if (existing) existing.outerHTML = html;
    else list.insertAdjacentHTML('beforeend', html);
  });
  list.querySelectorAll('[data-id]').forEach(function (el) {
    if (!seen[el.getAttribute('data-id')]) el.remove();
  });
  list.scrollTop = list.scrollHeight;
}

// Inlined duplicate of the BTW_MESSAGE_HTML helper (the served HTML string has
// no module / build step — same intentional duplication as APPEXEC_FRAME).
// v2 (architecture v2 §3.6): EVERY interpolated field is escaped — v1 escaped
// only the text, leaving id/role free to inject attributes (data-id/class).
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function btwMessageHtml(m) {
  const status = m.status === 'done'
    ? ''
    : '<span class="btw-status">' + escHtml(m.statusText || m.status) + '</span>';
  return '<div class="btw-msg btw-' + escHtml(m.role) + '" data-id="' + escHtml(m.id) + '"><div class="btw-text">' + escHtml(m.text) + '</div>' + status + '</div>';
}

function btwApplyEvent(event) {
  if (event.type === 'thread') {
    btwState = event.state;
    btwRenderMessages(event.state.messages);
    const modeBtn = document.getElementById('btw-mode');
    if (modeBtn) modeBtn.textContent = 'Mode: ' + event.state.mode;
  } else if (event.type === 'notice') {
    const list = document.getElementById('btw-messages');
    if (list) {
      list.insertAdjacentHTML('beforeend', '<div class="btw-notice">' + escHtml(event.text) + '</div>');
      list.scrollTop = list.scrollHeight;
    }
  }
}

// Flat btw command frame (BtwCommandFrameSchema shape — NO extra wrapper),
// sent over the single /ws socket via sendRaw.
function sendBtw(kind, extra) {
  const frame = { type: 'btw', kind: kind };
  if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) frame[k] = extra[k]; });
  sendRaw(JSON.stringify(frame));
}

function btwInit() {
  btwApplyCollapsed();
  const collapse = document.getElementById('btw-collapse');
  if (collapse) collapse.addEventListener('click', function () {
    const collapsed = document.body.classList.toggle('btw-collapsed');
    localStorage.setItem('btw-panel-collapsed', collapsed ? '1' : '0');
  });

  fetch('/api/btw').then(function (r) { return r.ok ? r.json() : null; }).then(function (state) {
    if (state && state.messages) { btwState = state; btwRenderMessages(state.messages); }
    // v2 (architecture v2 §3.6): the mode button label was only updated on PUSH
    // events — a pull-after-reload left it stale. Set it from the pulled state.
    const modeBtn = document.getElementById('btw-mode');
    if (modeBtn && state && state.mode) modeBtn.textContent = 'Mode: ' + state.mode;
  });

  fetch('/api/btw/models').then(function (r) { return r.ok ? r.json() : []; }).then(function (models) {
    btwModels = models || [];
    const sel = document.getElementById('btw-model');
    if (!sel) return;
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Main session model';
    sel.appendChild(none);
    btwModels.forEach(function (m, i) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = m.provider + '/' + m.id;
      sel.appendChild(opt);
    });
  });

  // Ask dispatch (Ask button + Enter on the btw input — event-cards 00 adds
  // Enter-to-send). The keydown guard is MANDATORY: a CJK IME confirms its
  // composition with Enter — without the isComposing / keyCode-229 check that
  // confirmation would dispatch the half-composed question. Grid: isSendEnter
  // (exported pure twin) + literal assertions in render-shell-btw.test.ts.
  function btwAsk() {
    const input = document.getElementById('btw-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtw('ask', { text: text });
  }
  const ask = document.getElementById('btw-ask');
  if (ask) ask.addEventListener('click', btwAsk);
  const askInput = document.getElementById('btw-input');
  if (askInput) askInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return; // IME composition — never a send
    e.preventDefault();
    btwAsk();
  });
  ['new', 'clear', 'inject', 'summarize'].forEach(function (kind) {
    const btn = document.getElementById('btw-' + kind);
    if (btn) btn.addEventListener('click', function () { sendBtw(kind); });
  });
  const modeBtn = document.getElementById('btw-mode');
  if (modeBtn) modeBtn.addEventListener('click', function () {
    sendBtw('mode', { mode: btwState.mode === 'contextual' ? 'tangent' : 'contextual' });
  });
  const modelSel = document.getElementById('btw-model');
  if (modelSel) modelSel.addEventListener('change', function () {
    // v2 (architecture v2 §3.6): Number('') === 0, so the "Main session model"
    // placeholder used to silently send the FIRST model. '' -> null explicitly.
    if (this.value === '') { sendBtw('model', { model: null }); return; }
    const m = btwModels[Number(this.value)];
    sendBtw('model', { model: m ? { provider: m.provider, id: m.id, api: m.api } : null });
  });
  const thinkingSel = document.getElementById('btw-thinking');
  if (thinkingSel) thinkingSel.addEventListener('change', function () {
    sendBtw('thinking', { level: this.value === '' ? null : this.value });
  });
}

// --- view notifications (effort webui-view-notifications, 03-B / 04-C) ---
// Pure twins of src/shell-views.ts — the inline script cannot import (no
// module/build step), so this is the SAME intentional duplication as
// APPEXEC_FRAME/BTW_MESSAGE_HTML; tests grid the pure module + assert these
// literals exist in the served HTML so the duplication stays honest.
var VIEW_TOAST_FRESH_MS = 10000;
var VIEW_TOAST_FADE_MS = 7000;
var VIEW_TOAST_MIN_RESUME_MS = 250;
var VIEW_TOAST_CAP = 3;
var VIEW_PANEL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var VIEW_PANEL_CAP = 8;
let viewEntries = [];   // newest-first {id,title,url?,updatedAt}; row identity = registry id
let viewDismissed = {}; // id -> true: client-side hide overlay (server list untouched)
let viewsCollapsed = false;
const viewUrlHandles = {}; // url -> Window: first click opens, later clicks focus (no dup tabs)

// 03-B click action, shared by toast / panel row / url-mode tab: per-URL window
// handle. Mutex is NEVER consulted — opening a /files URL is not input, so
// toasts/rows stay usable while another driver holds the mutex.
function openViewUrl(url) {
  const h = viewUrlHandles[url];
  if (h && !h.closed) { h.focus(); return; }
  viewUrlHandles[url] = window.open(url, '_blank');
}

// Spec 02-A id-stability rule mirrored client-side: url:<view> else url:<url>.
function viewOpenedId(view, url) { return view ? 'url:' + view : 'url:' + url; }

// 24h×8 windowing: age filter, newest-first, cap — a re-open floats to top.
function viewsPanelWindow(entries, now) {
  return entries
    .filter(function (e) { return now - e.updatedAt < VIEW_PANEL_MAX_AGE_MS; })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
    .slice(0, VIEW_PANEL_CAP);
}

function viewsVisible(now) {
  now = now || Date.now();
  return viewsPanelWindow(viewEntries, now).filter(function (e) { return !viewDismissed[e.id]; });
}

// /api/views backstop merge: {id,title,mode,updatedAt} only — the url itself
// travels ONLY in view_opened frames, so a poll-only entry stays url-less
// (renders title-only, open/copy disabled until a frame for it arrives).
function viewsMergePoll(summaries) {
  const byId = {};
  viewEntries.forEach(function (e) { byId[e.id] = { id: e.id, title: e.title, url: e.url, updatedAt: e.updatedAt }; });
  (summaries || []).forEach(function (s) {
    if (!s || s.mode !== 'url') return; // only url views belong to this panel
    const ex = byId[s.id];
    if (ex) {
      if (s.title) ex.title = s.title;
      if (typeof s.updatedAt === 'number' && s.updatedAt > ex.updatedAt) ex.updatedAt = s.updatedAt;
    } else {
      byId[s.id] = { id: s.id, title: s.title || null, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0 };
    }
  });
  viewEntries = viewsPanelWindow(Object.keys(byId).map(function (k) { return byId[k]; }), Date.now());
}

const viewToastOrder = []; // insertion (oldest-first) — the cap drops the head
const viewToasts = {};     // id -> { el, timer, deadline }

function viewToastRemove(id) {
  const t = viewToasts[id];
  if (!t) return;
  clearTimeout(t.timer);
  if (t.el && t.el.parentNode) t.el.parentNode.removeChild(t.el);
  delete viewToasts[id];
  const i = viewToastOrder.indexOf(id);
  if (i >= 0) viewToastOrder.splice(i, 1);
}

function viewToastArm(id, ms) {
  const t = viewToasts[id];
  if (!t) return;
  clearTimeout(t.timer);
  t.deadline = Date.now() + ms;
  t.timer = setTimeout(function () { viewToastRemove(id); }, ms);
}

function viewToastShow(id, title, url) {
  const stack = document.getElementById('webui-view-toasts');
  if (!stack) return;
  if (viewToasts[id]) { viewToastArm(id, VIEW_TOAST_FADE_MS); return; } // dedupe: extend, never stack
  while (viewToastOrder.length >= VIEW_TOAST_CAP) viewToastRemove(viewToastOrder[0]); // oldest dropped
  const el = document.createElement('div');
  el.className = 'webui-view-toast';
  el.innerHTML = '<div class="webui-view-toast-title">' + escHtml(title || url) + '</div>' +
                 '<div class="webui-view-toast-sub">' + escHtml(url) + '</div>';
  el.title = 'open ' + url + ' (top-level)';
  // hover-persist: pointer-over pauses the fade; pointer-leave resumes the REMAINING time
  el.onmouseenter = function () { const t = viewToasts[id]; if (t) clearTimeout(t.timer); };
  el.onmouseleave = function () {
    const t = viewToasts[id];
    if (t) viewToastArm(id, Math.max(VIEW_TOAST_MIN_RESUME_MS, t.deadline - Date.now()));
  };
  el.onclick = function () { openViewUrl(url); }; // same handle map as rows/tabs
  stack.appendChild(el);
  viewToasts[id] = { el: el, timer: 0, deadline: 0 };
  viewToastOrder.push(id);
  viewToastArm(id, VIEW_TOAST_FADE_MS);
}

function viewsRenderPanel() {
  const list = document.getElementById('webui-views-list');
  if (!list) return;
  const rows = viewsVisible();
  const countEl = document.getElementById('webui-views-count');
  if (countEl) countEl.textContent = String(rows.length);
  const toggle = document.getElementById('webui-views-collapse');
  if (toggle) toggle.textContent = viewsCollapsed ? '\u00bb' : '\u00ab';
  list.hidden = viewsCollapsed || rows.length === 0; // empty window ⇒ collapsed
  list.innerHTML = '';
  rows.forEach(function (e) {
    const row = document.createElement('div');
    row.className = 'webui-view-row';
    const title = document.createElement('span');
    title.className = 'webui-view-title';
    title.textContent = e.title || e.id;
    title.title = (e.url || 'url unknown (poll-only entry)') + ' \u00b7 ' + fmtTime(e.updatedAt);
    const hasUrl = !!e.url;
    if (hasUrl) title.onclick = function () { openViewUrl(e.url); };
    else title.style.cursor = 'default';
    const open = document.createElement('button');
    open.textContent = 'open';
    open.disabled = !hasUrl;
    if (hasUrl) open.onclick = function () { openViewUrl(e.url); };
    const copy = document.createElement('button');
    copy.textContent = 'copy';
    copy.disabled = !hasUrl;
    if (hasUrl) copy.onclick = function () {
      // loopback origin is a secure context — navigator.clipboard is available
      navigator.clipboard.writeText(location.origin + e.url).catch(function () {});
    };
    const dismiss = document.createElement('button');
    dismiss.textContent = 'dismiss';
    dismiss.onclick = function () { viewDismissed[e.id] = true; viewsRenderPanel(); viewsPollSync(); };
    row.appendChild(title); row.appendChild(open); row.appendChild(copy); row.appendChild(dismiss);
    list.appendChild(row);
  });
}

let viewsPollTimer = null;
function viewsPollTick() {
  fetch('/api/views').then(function (r) { return r.ok ? r.json() : []; }).then(function (s) {
    viewsMergePoll(s); viewsRenderPanel();
  }).catch(function () { /* backstop — transient poll failures are fine */ });
}
function viewsPollSync() {
  // poll ONLY while the panel is expanded (not collapsed AND rows visible)
  const expanded = !viewsCollapsed && viewsVisible().length > 0;
  if (expanded && viewsPollTimer === null) viewsPollTimer = setInterval(viewsPollTick, 1000);
  if (!expanded && viewsPollTimer !== null) { clearInterval(viewsPollTimer); viewsPollTimer = null; }
}

function viewApplyFrame(frame) {
  // Panel takes ALL frames (live + replay); the age-gate is toast-only.
  const id = viewOpenedId(frame.view, frame.url);
  const rest = viewEntries.filter(function (e) { return e.id !== id; }); // re-open floats, never duplicates
  viewEntries = viewsPanelWindow([{ id: id, title: frame.title || null, url: frame.url, updatedAt: frame.ts }].concat(rest), Date.now());
  viewsRenderPanel();
  viewsPollSync();
  if (Date.now() - frame.ts < VIEW_TOAST_FRESH_MS) viewToastShow(id, frame.title || null, frame.url);
}

function viewsInit() {
  viewsCollapsed = localStorage.getItem('webui-views-collapsed') === '1';
  const toggle = document.getElementById('webui-views-collapse');
  if (toggle) toggle.onclick = function (e) {
    e.preventDefault();
    viewsCollapsed = !viewsCollapsed;
    localStorage.setItem('webui-views-collapsed', viewsCollapsed ? '1' : '0');
    viewsRenderPanel();
    viewsPollSync();
  };
  viewsRenderPanel();
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
  // skip subscribe()/btwInit()/viewsInit() — retry the whole boot.
  try {
    await refresh();
    subscribe();
    btwInit(); // after the tab/view wiring so all getElementById targets exist
    viewsInit(); // view notifications: toast stack + views panel (07)
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

/** Outbound btw command frame for the /ws send path (panel -> engine). */
export function BTW_FRAME(
  kind: string,
  extra?: Record<string, unknown>,
): { type: "btw"; kind: string; [key: string]: unknown } {
  return extra ? { type: "btw", kind, ...extra } : { type: "btw", kind };
}

/**
 * Pure Enter-to-send gate (event-cards 00, de-chat): true ONLY for a real
 * Enter that is not mid-IME-composition. The inline shell script duplicates
 * this decision as the literal guard `if (e.isComposing || e.keyCode === 229)
 * return;` on every Enter-to-send handler (btw input, HITL tweak input);
 * tests grid this pure twin AND assert the inline literals so the duplication
 * stays honest (same convention as APPEXEC_FRAME / BTW_MESSAGE_HTML).
 */
export function isSendEnter(e: { key?: string; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && e.isComposing !== true && e.keyCode !== 229;
}

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One pre-reduced message snapshot -> panel row HTML (append/patch keyed by data-id). */
export function BTW_MESSAGE_HTML(m: {
  id: string;
  role: string;
  text: string;
  status: string;
  statusText?: string;
}): string {
  const status =
    m.status === "done"
      ? ""
      : `<span class="btw-status">${escapeHtml(m.statusText ?? m.status)}</span>`;
  // v2 (architecture v2 §3.6): id/role escaped too — v1 interpolated them raw
  // into data-id/class (attribute injection via a quoted id/role).
  return `<div class="btw-msg btw-${escapeHtml(m.role)}" data-id="${escapeHtml(m.id)}"><div class="btw-text">${escapeHtml(m.text)}</div>${status}</div>`;
}
