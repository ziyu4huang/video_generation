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
 *     affected view.
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
  /* zk-spawn prototype: per-image feedback toolbar + on-screen steer log */
  .webui-result { margin: .5rem 0; padding: .5rem; border: 1px solid #8884; border-radius: 6px; background: #8881; }
  .webui-result img { max-width: 100%; height: auto; border-radius: 4px; display: block; }
  .webui-toolbar { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; flex-wrap: wrap; }
  .webui-toolbar button { padding: .2rem .55rem; border: 1px solid #8886; border-radius: 4px; background: #8882; color: inherit; cursor: pointer; }
  .webui-toolbar button:hover { background: #6cf3; }
  .webui-toolbar input { padding: .2rem .4rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }
  #webui-feedback-log { position: fixed; right: .6rem; bottom: .6rem; width: 22rem; max-width: 70vw; max-height: 38vh; overflow: auto; background: #0009; color: #eee; padding: .45rem .55rem; border-radius: 6px; font: 12px/1.45 ui-monospace, monospace; box-shadow: 0 2px 10px #0006; z-index: 50; }
  #webui-feedback-log .webui-log-head { display: flex; justify-content: space-between; align-items: center; opacity: .85; margin-bottom: .2rem; }
  #webui-feedback-log .webui-log-head a { color: #9cf; cursor: pointer; text-decoration: none; }
  #webui-feedback-log-body > div { border-bottom: 1px solid #fff2; padding: .12rem 0; word-break: break-word; }
</style>
</head>
<body>
<header id="tabs"></header>
<main>
  <div class="meta" id="meta"></div>
  <div id="content"></div>
</main>
<div id="webui-feedback-log">
  <div class="webui-log-head"><span>steer log</span><a id="webui-log-clear" href="#">clear</a></div>
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
    attachFeedbackToolbars(contentEl);
  }
}

async function refresh() { await loadViews(); await renderView(activeId); }

function subscribe() {
  const es = new EventSource('/api/events');
  es.onmessage = async function (e) {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data && data.viewId) { await loadViews(); if (data.viewId === activeId) await renderView(activeId); }
  };
  es.onerror = function () { es.close(); setTimeout(subscribe, 2000); };
}

// --- zk-spawn prototype: shell-hosted feedback toolbar over the /ws channel ---
// Opens the EXISTING inbound WS (web-server.ts /ws upgrade) and sends 'steer'
// frames (protocol.ts inbound schema). The PINNED formulations live in the pure
// helpers at the bottom of this module (STEER_FRAME / APPROVE_TEXT /
// REGENERATE_TEXT); the logic below inlines the same wording (prototype —
// acceptable duplication, since the served HTML has no module/build step).
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const ws = new WebSocket(wsUrl);
ws.onopen  = function () { console.log('[webui] feedback ws open'); };
ws.onclose = function () { console.log('[webui] feedback ws closed'); };
ws.onerror = function () { console.warn('[webui] feedback ws error'); };

function logSteer(text) {
  const body = document.getElementById('webui-feedback-log-body');
  if (!body) return;
  const line = document.createElement('div');
  const shown = text.length > 120 ? text.slice(0, 117) + '...' : text;
  line.textContent = '\u2192 steer: ' + shown;
  body.appendChild(line);
}

function sendSteer(text) {
  const frame = { type: 'steer', text: text };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  } else {
    console.warn('[webui] ws not open; would send:', frame);
  }
  logSteer(text);
}

function basenameOf(img) {
  const src = img.getAttribute('src');
  if (!src) return '(unknown)';
  const parts = src.split('/');
  return parts[parts.length - 1] || '(unknown)';
}

function attachFeedbackToolbars(root) {
  const imgs = root.querySelectorAll('img');
  imgs.forEach(function (img) {
    if (img.dataset.webuiToolbar === '1') return; // idempotent across re-renders
    img.dataset.webuiToolbar = '1';
    if (!img.parentNode) return;
    // Wrap the img so the toolbar rides with it as a sibling block.
    const wrap = document.createElement('div');
    wrap.className = 'webui-result';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);

    const bar = document.createElement('div');
    bar.className = 'webui-toolbar';

    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.onclick = function () {
      sendSteer('Approved: image ' + basenameOf(img) + ' looks good, no changes needed.');
    };
    bar.appendChild(approve);

    const regen = document.createElement('button');
    regen.type = 'button';
    regen.textContent = 'Regenerate\u2026';
    const regenBox = document.createElement('span');
    regenBox.className = 'webui-regen';
    regenBox.style.display = 'none';
    const tweakIn = document.createElement('input');
    tweakIn.type = 'text';
    tweakIn.placeholder = 'tweak (optional)';
    tweakIn.size = 30;
    const tweakSend = document.createElement('button');
    tweakSend.type = 'button';
    tweakSend.textContent = 'Send';
    function submitRegen() {
      const t = (tweakIn.value || '').trim();
      if (t) sendSteer('Regenerate image ' + basenameOf(img) + ' with: ' + t);
      else sendSteer('Regenerate image ' + basenameOf(img) + '.');
      tweakIn.value = '';
    }
    tweakSend.onclick = submitRegen;
    tweakIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitRegen(); }
    });
    regenBox.appendChild(tweakIn);
    regenBox.appendChild(tweakSend);
    regen.onclick = function () {
      regenBox.style.display = regenBox.style.display === 'none' ? '' : 'none';
      if (regenBox.style.display !== 'none') tweakIn.focus();
    };
    bar.appendChild(regen);
    bar.appendChild(regenBox);

    wrap.appendChild(bar);
  });
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
})();
</script>
</body>
</html>`;

/**
 * Pure steer-message formulations (zk-spawn prototype, ticket #03). These are
 * the PINNED shapes the inline browser script above duplicates; tests assert
 * against these so the exact wording is gridded WITHOUT a DOM. The inline
 * script must inline the same logic (the served HTML string has no module /
 * build step), so they are intentionally duplicated here.
 */
export const STEER_FRAME = (text: string): { type: "steer"; text: string } => ({
  type: "steer",
  text,
});

export const APPROVE_TEXT = (basename: string): string =>
  `Approved: image ${basename} looks good, no changes needed.`;

export const REGENERATE_TEXT = (basename: string, tweak: string): string =>
  tweak ? `Regenerate image ${basename} with: ${tweak}` : `Regenerate image ${basename}.`;
