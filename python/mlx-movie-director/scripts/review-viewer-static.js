// review-viewer-static.js — static Bun HTTP server + HTML template
// This file is appended verbatim after the generated CONFIG block.
// Do NOT reference CONFIG here with const/let — it is declared in the prepended block.

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function renderHTML(config) {
  const testsJson = JSON.stringify(config.tests);
  const model = config.model || "unknown";
  const generatedAt = config.generatedAt || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Review: ${model}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --bg2: #1a1a1a; --bg3: #242424;
  --border: #333; --text: #e0e0e0; --muted: #777;
  --accent: #4a9eff; --gold: #f5c518; --green: #4caf50; --red: #f44336;
  --radius: 8px;
}
body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
       font-size: 14px; line-height: 1.5; padding-bottom: 220px; }

header { background: var(--bg2); border-bottom: 1px solid var(--border);
         padding: 14px 20px; position: sticky; top: 0; z-index: 100; }
header h1 { font-size: 16px; font-weight: 600; color: var(--accent); }
header .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.prompt-box { margin-top: 8px; background: var(--bg3); border: 1px solid var(--border);
              border-radius: var(--radius); padding: 8px 12px; font-size: 12px; color: #bbb;
              max-height: 60px; overflow-y: auto; }

#grid { display: flex; gap: 14px; padding: 16px 20px;
        overflow-x: auto; align-items: flex-start; min-height: 200px; }

.card { flex: 0 0 300px; background: var(--bg2); border: 2px solid var(--border);
        border-radius: var(--radius); overflow: hidden; transition: border-color .15s; }
.card.winner { border-color: var(--gold); }

.card-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
               background: var(--bg3); border-bottom: 1px solid var(--border); }
.label { font-size: 18px; font-weight: 700; color: var(--accent); min-width: 24px; }
.status-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px;
                border: 1px solid var(--border); color: var(--muted); }
.status-badge.success { border-color: var(--green); color: var(--green); }
.status-badge.error   { border-color: var(--red);   color: var(--red); }
.winner-btn { margin-left: auto; font-size: 11px; padding: 3px 9px; border-radius: 10px;
              background: transparent; border: 1px solid var(--border); color: var(--muted);
              cursor: pointer; transition: all .15s; }
.winner-btn:hover { border-color: var(--gold); color: var(--gold); }
.card.winner .winner-btn { background: var(--gold); color: #111; border-color: var(--gold); font-weight: 600; }

.video-wrap { background: #000; }
.video-wrap video { width: 100%; display: block; max-height: 200px; object-fit: contain; }
.no-video { height: 120px; display: flex; align-items: center; justify-content: center;
            color: var(--muted); font-size: 12px; }

.params { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.params table { width: 100%; border-collapse: collapse; font-size: 12px; }
.params td { padding: 1px 0; vertical-align: top; }
.params td:first-child { color: var(--muted); width: 48%; padding-right: 6px; }
.params td.diff { color: var(--gold); font-weight: 600; }

.timing { padding: 5px 12px; border-bottom: 1px solid var(--border);
          font-size: 11px; color: var(--muted); display: flex; gap: 12px; flex-wrap: wrap; }
.timing b { color: var(--text); }

.rating-row { padding: 8px 12px; display: flex; align-items: center; gap: 8px;
              border-bottom: 1px solid var(--border); }
.stars { display: flex; gap: 2px; cursor: pointer; }
.star { font-size: 20px; color: #3a3a3a; transition: color .1s; user-select: none; line-height: 1; }
.star.on { color: var(--gold); }
.rating-label { font-size: 11px; color: var(--muted); }

.thumb-wrap img { width: 100%; display: block; max-height: 160px; object-fit: cover; }

.caption-box { padding: 6px 12px; border-bottom: 1px solid var(--border);
               font-size: 11px; color: #aaa; line-height: 1.4; }
.cap-more { background: none; border: none; color: var(--accent); cursor: pointer;
            font-size: 11px; padding: 0; margin-left: 4px; }

.comment { padding: 8px 12px; }
.comment textarea { width: 100%; height: 64px; background: var(--bg3);
                    border: 1px solid var(--border); border-radius: 4px;
                    color: var(--text); font-size: 12px; font-family: inherit;
                    padding: 5px 8px; resize: vertical; }
.comment textarea:focus { outline: none; border-color: var(--accent); }
.comment textarea::placeholder { color: #444; }

/* bottom bar */
#bottom { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg2);
          border-top: 1px solid var(--border); padding: 12px 20px; z-index: 200; }
.row1 { display: flex; gap: 10px; align-items: flex-start; }
#overall-notes { flex: 1; height: 48px; background: var(--bg3); border: 1px solid var(--border);
                 border-radius: var(--radius); color: var(--text); font-size: 13px;
                 font-family: inherit; padding: 7px 11px; resize: none; }
#overall-notes::placeholder { color: #444; }
.btn-group { display: flex; flex-direction: column; gap: 5px; }
.btn { padding: 7px 15px; border-radius: var(--radius); border: none; cursor: pointer;
       font-size: 12px; font-weight: 500; transition: opacity .15s; white-space: nowrap; }
.btn:hover { opacity: .8; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }

#output-panel { display: none; margin-top: 10px; }
#output-panel.visible { display: block; }
#output-tabs { display: flex; gap: 4px; margin-bottom: 6px; }
.tab { padding: 4px 12px; border-radius: 4px; background: var(--bg3);
       border: 1px solid var(--border); cursor: pointer; font-size: 11px; color: var(--muted); }
.tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
#output-text { width: 100%; height: 120px; background: var(--bg3); border: 1px solid var(--border);
               border-radius: var(--radius); color: var(--text); font-size: 11px;
               font-family: 'SF Mono', 'Menlo', monospace; padding: 8px 10px; resize: vertical; }
.copy-row { display: flex; gap: 8px; margin-top: 6px; align-items: center; }
.copy-ok { font-size: 11px; color: var(--green); opacity: 0; transition: opacity .3s; }
.copy-ok.show { opacity: 1; }
</style>
</head>
<body>

<header>
  <h1>&#127916; Finetune Review &mdash; ${model}</h1>
  <div class="meta">Generated ${generatedAt} &nbsp;&middot;&nbsp; <span id="n-tests"></span> tests</div>
  <div class="prompt-box" id="shared-prompt"></div>
</header>

<div id="grid"></div>

<div id="bottom">
  <div class="row1">
    <textarea id="overall-notes" placeholder="Overall notes (optional)…"></textarea>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="showOutput('plain')">Generate Feedback</button>
      <button class="btn btn-outline" onclick="showOutput('json')">JSON</button>
    </div>
  </div>
  <div id="output-panel">
    <div id="output-tabs">
      <div class="tab active" id="tab-plain" onclick="switchTab('plain')">Plain Text</div>
      <div class="tab" id="tab-json" onclick="switchTab('json')">JSON</div>
    </div>
    <textarea id="output-text" readonly></textarea>
    <div class="copy-row">
      <button class="btn btn-outline" onclick="copyOutput()">Copy</button>
      <button class="btn btn-outline" onclick="downloadOutput()">Download</button>
      <span class="copy-ok" id="copy-ok">Copied!</span>
    </div>
  </div>
</div>

<script>
const TESTS = ${testsJson};
const MODEL = ${JSON.stringify(model)};
const STORE_KEY = 'review_' + MODEL + '_' + TESTS.map(t => t.label).join('');

let state = { ratings: {}, comments: {}, winner: null, notes: '' };
let activeTab = 'plain';

function loadState() {
  try { const s = localStorage.getItem(STORE_KEY); if (s) state = { ...state, ...JSON.parse(s) }; } catch(e) {}
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch(e) {}
}

// ---- render ----

function boot() {
  loadState();
  document.getElementById('n-tests').textContent = TESTS.length;
  const prompt = TESTS.map(t => t.prompt).find(Boolean) || '(no prompt)';
  document.getElementById('shared-prompt').textContent = prompt;
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  TESTS.forEach((t, i) => grid.appendChild(makeCard(t, i)));
  const notesEl = document.getElementById('overall-notes');
  notesEl.value = state.notes || '';
  notesEl.addEventListener('input', e => { state.notes = e.target.value; saveState(); });
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function makeCard(t, i) {
  const card = el('div', 'card' + (state.winner === t.label ? ' winner' : ''));
  card.id = 'card-' + i;

  // header
  const hdr = el('div', 'card-header');
  hdr.innerHTML = \`<div class="label">\${t.label}</div>
    <div class="status-badge \${t.status}">\${t.status}</div>\`;
  const wb = el('button', 'winner-btn');
  wb.textContent = '★ Best';
  wb.onclick = () => toggleWinner(t.label, i);
  hdr.appendChild(wb);
  card.appendChild(hdr);

  // thumbnail (first frame PNG, if available)
  if (t.thumbnailPath) {
    const thumb = el('div', 'thumb-wrap');
    const img = document.createElement('img');
    img.src = '/thumb/' + encodeURIComponent(t.label);
    img.alt = 'First frame';
    thumb.appendChild(img);
    card.appendChild(thumb);
  }

  // video
  const vw = el('div', 'video-wrap');
  if (t.videoPath) {
    const vid = document.createElement('video');
    vid.src = '/video/' + encodeURIComponent(t.label);
    vid.controls = true; vid.loop = true; vid.preload = 'metadata';
    vw.appendChild(vid);
  } else {
    vw.innerHTML = '<div class="no-video">No video</div>';
  }
  card.appendChild(vw);

  // caption
  if (t.caption) {
    const capWrap = el('div', 'caption-box');
    const short = t.caption.slice(0, 120).replace(/\n/g, ' ');
    const isTrunc = t.caption.length > 120;
    const capText = el('span', 'cap-text');
    capText.textContent = short + (isTrunc ? '…' : '');
    capWrap.appendChild(capText);
    if (isTrunc) {
      const btn = el('button', 'cap-more');
      btn.textContent = 'more';
      btn.addEventListener('click', () => toggleCaption(btn, t.caption));
      capWrap.appendChild(btn);
    }
    card.appendChild(capWrap);
  }

  // params (diff vs test[0])
  const ref = TESTS[0].params || {};
  const rows = Object.entries(t.params || {}).map(([k, v]) => {
    const isDiff = i > 0 && JSON.stringify(ref[k]) !== JSON.stringify(v);
    return \`<tr><td>\${k}</td><td class="\${isDiff ? 'diff' : ''}">\${v}</td></tr>\`;
  }).join('');
  card.appendChild(el('div', 'params', \`<table>\${rows}</table>\`));

  // timing
  const elapsed = t.elapsed != null ? t.elapsed.toFixed(1) + 's' : '—';
  const mem = t.memory_mb != null ? (t.memory_mb / 1024).toFixed(1) + ' GB' : '—';
  card.appendChild(el('div', 'timing',
    \`<span>Time <b>\${elapsed}</b></span><span>Peak RAM <b>\${mem}</b></span>\`));

  // stars
  const rrow = el('div', 'rating-row');
  const starsEl = el('div', 'stars');
  starsEl.id = 'stars-' + i;
  for (let s = 1; s <= 5; s++) {
    const star = el('span', 'star' + (s <= (state.ratings[t.label] || 0) ? ' on' : ''), '★');
    star.addEventListener('click', () => setRating(t.label, i, s));
    starsEl.appendChild(star);
  }
  const rl = el('span', 'rating-label');
  rl.id = 'rlabel-' + i;
  rl.textContent = ratingLabel(state.ratings[t.label] || 0);
  rrow.append(starsEl, rl);
  card.appendChild(rrow);

  // comment
  const cmtWrap = el('div', 'comment');
  const cmt = document.createElement('textarea');
  cmt.placeholder = 'Notes for ' + t.label + '…';
  cmt.value = state.comments[t.label] || '';
  cmt.addEventListener('input', e => { state.comments[t.label] = e.target.value; saveState(); });
  cmtWrap.appendChild(cmt);
  card.appendChild(cmtWrap);

  return card;
}

// ---- interactions ----

function setRating(label, i, n) {
  state.ratings[label] = n; saveState();
  document.getElementById('stars-' + i).querySelectorAll('.star')
    .forEach((s, idx) => s.classList.toggle('on', idx < n));
  document.getElementById('rlabel-' + i).textContent = ratingLabel(n);
}

function ratingLabel(n) {
  return ['', 'Poor', 'Fair', 'Good', 'Great', 'Perfect'][n] || '';
}

function toggleWinner(label, i) {
  state.winner = state.winner === label ? null : label;
  saveState();
  document.querySelectorAll('.card').forEach((c, idx) => {
    c.classList.toggle('winner', TESTS[idx].label === state.winner);
    c.querySelector('.winner-btn').textContent = TESTS[idx].label === state.winner ? '★ Winner' : '★ Best';
  });
}

// ---- feedback ----

function generatePlain() {
  const lines = [];
  lines.push('## A/B Review: ' + MODEL);
  lines.push('Date: ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  const prompt = TESTS.map(t => t.prompt).find(Boolean) || '';
  if (prompt) lines.push('Prompt: "' + prompt + '"');
  lines.push('');
  lines.push('### Test Results');
  lines.push('');
  TESTS.forEach(t => {
    const r = state.ratings[t.label] || 0;
    const stars = '★'.repeat(r) + '☆'.repeat(5 - r);
    const win = state.winner === t.label ? ' ← WINNER' : '';
    lines.push('[' + t.label + '] ' + stars + win);
    const ps = Object.entries(t.params || {}).map(([k, v]) => k + '=' + v).join('  ');
    if (ps) lines.push('Params: ' + ps);
    if (t.elapsed != null) lines.push('Time: ' + t.elapsed.toFixed(1) + 's');
    const c = state.comments[t.label];
    if (c && c.trim()) lines.push('Notes: ' + c.trim());
    lines.push('');
  });
  if (state.winner) {
    const w = TESTS.find(t => t.label === state.winner);
    if (w && w.params) {
      lines.push('### Recommended Parameters');
      Object.entries(w.params).forEach(([k, v]) => lines.push(k + ': ' + v));
      lines.push('');
    }
  }
  if (state.notes && state.notes.trim()) {
    lines.push('### Overall Notes');
    lines.push(state.notes.trim());
  }
  return lines.join('\\n');
}

function generateJSON() {
  return JSON.stringify({
    model: MODEL,
    date: new Date().toISOString(),
    prompt: TESTS.map(t => t.prompt).find(Boolean) || '',
    winner: state.winner,
    tests: TESTS.map(t => ({
      label: t.label,
      status: t.status,
      params: t.params,
      elapsed_seconds: t.elapsed,
      rating: state.ratings[t.label] || 0,
      comment: state.comments[t.label] || '',
      is_winner: t.label === state.winner,
    })),
    overall_notes: state.notes || '',
    recommended_params: state.winner
      ? (TESTS.find(t => t.label === state.winner) || {}).params || {}
      : {},
  }, null, 2);
}

function showOutput(tab) {
  activeTab = tab;
  document.getElementById('output-panel').classList.add('visible');
  updateOutput();
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-plain').classList.toggle('active', tab === 'plain');
  document.getElementById('tab-json').classList.toggle('active', tab === 'json');
  updateOutput();
}

function updateOutput() {
  document.getElementById('output-text').value =
    activeTab === 'json' ? generateJSON() : generatePlain();
}

function copyOutput() {
  navigator.clipboard.writeText(document.getElementById('output-text').value).then(() => {
    const s = document.getElementById('copy-ok');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 2000);
  });
}

function downloadOutput() {
  const text = document.getElementById('output-text').value;
  const ext = activeTab === 'json' ? 'json' : 'txt';
  const fname = 'review-' + MODEL + '-' + new Date().toISOString().slice(0, 10) + '.' + ext;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = fname; a.click();
}

function toggleCaption(btn, fullText) {
  const box = btn.previousElementSibling;
  if (btn.textContent === 'more') {
    box.textContent = fullText;
    btn.textContent = 'less';
  } else {
    box.textContent = fullText.slice(0, 120).replace(/\n/g, ' ') + '…';
    btn.textContent = 'more';
  }
}

boot();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Video serving with Range support
// ---------------------------------------------------------------------------

function serveStaticFile(req, url, prefix) {
  const label = decodeURIComponent(url.pathname.replace(prefix, ""));
  const test = CONFIG.tests.find(t => t.label === label);

  if (prefix === "/video/") {
    if (!test || !test.videoPath) return new Response("Not found", { status: 404 });
    const filePath = test.videoPath;
    const mime = test.mime || "video/mp4";

    const file = Bun.file(filePath);
    const total = file.size;
    const rangeHeader = req.headers.get("range");

    if (rangeHeader) {
      const [, rangeStr] = rangeHeader.split("=");
      const [startStr, endStr] = rangeStr.split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? Math.min(parseInt(endStr, 10), total - 1) : total - 1;
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        },
      });
    }

    return new Response(file, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
      },
    });
  }

  if (prefix === "/thumb/") {
    if (!test || !test.thumbnailPath) return new Response("Not found", { status: 404 });
    const file = Bun.file(test.thumbnailPath);
    return new Response(file, {
      headers: { "Content-Type": "image/png" },
    });
  }

  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Bun HTTP server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(renderHTML(CONFIG), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname.startsWith("/video/")) {
      return serveStaticFile(req, url, "/video/");
    }
    if (url.pathname.startsWith("/thumb/")) {
      return serveStaticFile(req, url, "/thumb/");
    }
    return new Response("Not found", { status: 404 });
  },
});

const addr = `http://localhost:${server.port}`;
console.log(`[review] Serving at ${addr}`);
console.log(`[review] Tests: ${CONFIG.tests.map(t => t.label).join(", ")}`);
Bun.openInBrowser(addr);
