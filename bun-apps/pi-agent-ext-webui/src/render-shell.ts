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
</style>
</head>
<body>
<header id="tabs"></header>
<div id="shell-row">
<main>
  <div class="meta" id="meta"></div>
  <div id="content"></div>
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
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
    </select>
  </div>
  <div id="btw-messages"></div>
  <div id="btw-compose">
    <input id="btw-input" type="text" placeholder="Ask a tangent question..." />
    <button id="btw-ask">Ask</button>
  </div>
</aside>
</div>
<div id="webui-feedback-log">
  <div class="webui-log-head"><span>response log</span><a id="webui-log-clear" href="#">clear</a></div>
  <div id="webui-feedback-log-body"></div>
</div>
<script>
const tabsEl = document.getElementById('tabs');
const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
let activeId = location.hash.slice(1) || 'main';

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
    el.onclick = () => { activeId = v.id; location.hash = v.id; renderView(v.id); };
    tabsEl.appendChild(el);
  }
  if (!views.some(v => v.id === activeId)) activeId = (views[0] && views[0].id) || 'main';
  return views;
}

async function renderView(id) {
  const res = await fetch('/api/view/' + encodeURIComponent(id));
  if (!res.ok) { contentEl.innerHTML = '<p>no view</p>'; return; }
  const v = await res.json();
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.toggle('active', t.dataset.viewId === id);
  });
  metaEl.textContent = (v.title ? (v.title + ' · ') : '') + 'mode ' + v.mode + ' · updated ' + fmtTime(v.updatedAt);
  if (v.mode === 'html') {
    contentEl.innerHTML = '';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', ''); // D5: most restrictive — no scripts, no same-origin
    f.srcdoc = v.content;
    contentEl.appendChild(f);
  } else {
    contentEl.innerHTML = v.html || '';
  }
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

function connectWs() {
  ws = new WebSocket(wsUrl);
  ws.onopen = function () { console.log('[webui] response ws open'); };
  ws.onclose = function () {
    console.log('[webui] response ws closed; retry in 2s');
    scheduleWsRetry();
  };
  ws.onerror = function () { console.warn('[webui] response ws error'); scheduleWsRetry(); };
  // FIRST inbound consumer of the /ws socket (it was send-only before btw).
  ws.onmessage = function (message) {
    let frame; try { frame = JSON.parse(message.data); } catch { return; }
    if (frame && frame.type === "btw" && frame.event) btwApplyEvent(frame.event);
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
}

function sendRaw(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
    return true;
  }
  console.warn('[webui] ws not open; would send:', payload);
  return false;
}

function sendAppexecResponse(id, action, tweak) {
  const extra = { kind: 'respond', id: id, action: action };
  if (tweak) extra.tweak = tweak; // omit the key when absent (present-tool details semantics)
  const frame = { type: 'appexec', extra: extra };
  if (sendRaw(JSON.stringify(frame))) {
    console.log('[webui] appexec response sent:', JSON.stringify(frame));
  }
  logResponse(action + (tweak ? ' (tweak: ' + tweak + ')' : ''));
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
function btwMessageHtml(m) {
  const esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  const status = m.status === 'done'
    ? ''
    : '<span class="btw-status">' + esc(m.statusText || m.status) + '</span>';
  return '<div class="btw-msg btw-' + m.role + '" data-id="' + m.id + '"><div class="btw-text">' + esc(m.text) + '</div>' + status + '</div>';
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
      list.insertAdjacentHTML('beforeend', '<div class="btw-notice">' + String(event.text).replace(/</g, '&lt;') + '</div>');
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

  const ask = document.getElementById('btw-ask');
  if (ask) ask.addEventListener('click', function () {
    const input = document.getElementById('btw-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtw('ask', { text: text });
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
    const m = btwModels[Number(this.value)];
    sendBtw('model', { model: m ? { provider: m.provider, id: m.id, api: m.api } : null });
  });
  const thinkingSel = document.getElementById('btw-thinking');
  if (thinkingSel) thinkingSel.addEventListener('change', function () {
    sendBtw('thinking', { level: this.value === '' ? null : this.value });
  });
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
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
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
  contentEl.appendChild(bar);
}

(async function () {
  const clearLink = document.getElementById('webui-log-clear');
  if (clearLink) clearLink.onclick = function (e) {
    e.preventDefault();
    const body = document.getElementById('webui-feedback-log-body');
    if (body) body.innerHTML = '';
  };
  await refresh();
  subscribe();
  btwInit(); // after the tab/view wiring so all getElementById targets exist
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
  return `<div class="btw-msg btw-${m.role}" data-id="${m.id}"><div class="btw-text">${escapeHtml(m.text)}</div>${status}</div>`;
}
