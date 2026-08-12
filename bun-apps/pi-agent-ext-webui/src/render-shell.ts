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
</style>
</head>
<body>
<header id="tabs"></header>
<main>
  <div class="meta" id="meta"></div>
  <div id="content"></div>
</main>
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

(async function () { await refresh(); subscribe(); })();
</script>
</body>
</html>`;
