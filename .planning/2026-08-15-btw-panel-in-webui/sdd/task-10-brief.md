### Task 10: shell client logic (pull-then-subscribe, first inbound WS consumer, command sends)

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (`RENDER_SHELL_HTML` `<script>` block)
- Test: extend `bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts`

**Interfaces:**
- Consumes: Task 9 (`BTW_FRAME` shape, panel ids, `BTW_MESSAGE_HTML` row contract); existing shell send path used by `sendAppexecResponse` (the `/ws` socket with 2s-retry reconnect — reuse its raw send, do not open a second socket); existing `new EventSource('/api/events')` refresh loop (unchanged).
- Produces: shell JS behaviors — `fetch('/api/btw')` pull on load, `fetch('/api/btw/models')` dropdown fill, `ws.onmessage` handling `{ type: "btw"; event }` frames (FIRST inbound WS consumer), message list append/patch/prune keyed by `data-id`, `localStorage` collapse persistence, outbound `btw` frames via the existing socket.

- [ ] **Step 1: Write the failing test (append to tests/render-shell-btw.test.ts)**

```ts
describe("RENDER_SHELL_HTML btw client logic", () => {
  it("ships the first inbound ws handler for btw frames", () => {
    expect(RENDER_SHELL_HTML).toContain("ws.onmessage");
    expect(RENDER_SHELL_HTML).toContain('frame.type === "btw"');
  });

  it("pulls the thread snapshot and model list on load (pull-then-subscribe)", () => {
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw')");
    expect(RENDER_SHELL_HTML).toContain("fetch('/api/btw/models')");
  });

  it("sends btw commands over the existing /ws socket", () => {
    expect(RENDER_SHELL_HTML).toContain("sendBtw(");
    expect(RENDER_SHELL_HTML.split("new WebSocket(").length - 1).toBe(1); // exactly one construction site
  });

  it("keeps the SSE refresh loop as-is", () => {
    expect(RENDER_SHELL_HTML).toContain("new EventSource('/api/events')");
  });
});
```

Note the occurrence-count guard: the shell must keep exactly ONE `new WebSocket(` construction — the existing `connectWs` in `RENDER_SHELL_HTML` (which builds its single `/ws` socket once). The panel reuses that socket; the test guards against adding a second construction site.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: FAIL — the four new describe cases fail (no `ws.onmessage`, no btw fetches, no `sendBtw`).

- [ ] **Step 3: Implement the shell client logic**

Add to the `<script>` block in `RENDER_SHELL_HTML` (single-quoted strings to match the test assertions):

```js
// --- btw side panel ---
var btwState = { messages: [], mode: 'contextual', model: null, thinking: null };
var btwModels = [];

function btwApplyCollapsed() {
  document.body.classList.toggle('btw-collapsed', localStorage.getItem('btw-panel-collapsed') === '1');
}

function btwRenderMessages(messages) {
  var list = document.getElementById('btw-messages');
  if (!list) return;
  var seen = {};
  messages.forEach(function (m) {
    seen[m.id] = true;
    var existing = list.querySelector('[data-id="' + m.id + '"]');
    var html = btwMessageHtml(m);
    if (existing) existing.outerHTML = html;
    else list.insertAdjacentHTML('beforeend', html);
  });
  Array.prototype.forEach.call(list.querySelectorAll('[data-id]'), function (el) {
    if (!seen[el.getAttribute('data-id')]) el.remove();
  });
  list.scrollTop = list.scrollHeight;
}

function btwMessageHtml(m) {
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var status = m.status === 'done' ? '' : '<span class="btw-status">' + esc(m.statusText || m.status) + '</span>';
  return '<div class="btw-msg btw-' + m.role + '" data-id="' + m.id + '"><div class="btw-text">' + esc(m.text) + '</div>' + status + '</div>';
}

function btwApplyEvent(event) {
  if (event.type === 'thread') {
    btwState = event.state;
    btwRenderMessages(event.state.messages);
    var modeBtn = document.getElementById('btw-mode');
    if (modeBtn) modeBtn.textContent = 'Mode: ' + event.state.mode;
  } else if (event.type === 'notice') {
    var list = document.getElementById('btw-messages');
    if (list) list.insertAdjacentHTML('beforeend', '<div class="btw-notice">' + String(event.text).replace(/</g, '&lt;') + '</div>');
  }
}

function sendBtw(kind, extra) {
  var frame = { type: 'btw', kind: kind };
  if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) frame[k] = extra[k]; });
  sendRaw(JSON.stringify(frame));
}

function btwInit() {
  btwApplyCollapsed();
  var collapse = document.getElementById('btw-collapse');
  if (collapse) collapse.addEventListener('click', function () {
    var collapsed = document.body.classList.toggle('btw-collapsed');
    localStorage.setItem('btw-panel-collapsed', collapsed ? '1' : '0');
  });

  fetch('/api/btw').then(function (r) { return r.ok ? r.json() : null; }).then(function (state) {
    if (state && state.messages) { btwState = state; btwRenderMessages(state.messages); }
  });

  fetch('/api/btw/models').then(function (r) { return r.ok ? r.json() : []; }).then(function (models) {
    btwModels = models || [];
    var sel = document.getElementById('btw-model');
    if (!sel) return;
    sel.innerHTML = '';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Main session model';
    sel.appendChild(none);
    btwModels.forEach(function (m, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = m.provider + '/' + m.id;
      sel.appendChild(opt);
    });
  });

  document.getElementById('btw-ask').addEventListener('click', function () {
    var input = document.getElementById('btw-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtw('ask', { text: text });
  });
  ['new', 'clear', 'inject', 'summarize'].forEach(function (kind) {
    document.getElementById('btw-' + kind).addEventListener('click', function () { sendBtw(kind); });
  });
  document.getElementById('btw-mode').addEventListener('click', function () {
    sendBtw('mode', { mode: btwState.mode === 'contextual' ? 'tangent' : 'contextual' });
  });
  document.getElementById('btw-model').addEventListener('change', function () {
    var m = btwModels[Number(this.value)];
    sendBtw('model', { model: m ? { provider: m.provider, id: m.id, api: m.api } : null });
  });
  document.getElementById('btw-thinking').addEventListener('change', function () {
    sendBtw('thinking', { level: this.value === '' ? null : this.value });
  });
}
btwInit();

// First inbound consumer of the /ws socket (it was send-only before this change).
ws.onmessage = function (message) {
  var frame;
  try { frame = JSON.parse(message.data); } catch (e) { return; }
  if (frame && frame.type === 'btw' && frame.event) btwApplyEvent(frame.event);
};
```

Placement notes for the implementer:

- `sendRaw(payload)` — send `payload` through the SAME `/ws` socket `sendAppexecResponse` uses. If that function inlines its `ws.send(...)` call, extract or reuse the identical send expression inside `sendBtw` (do not duplicate the reconnect logic; the existing 2s-retry socket stays the only one). Do NOT build the `{ type: 'btw', ... }` object with an `extra` wrapper — the frame must be FLAT (`{ type: 'btw', kind, text?, mode?, model?, level? }`), matching `BtwCommandFrameSchema`; if the spread of `extra` keys above is awkward, write `var frame = { type: 'btw', kind: kind }; if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) frame[k] = extra[k]; });` and `JSON.stringify(frame)`.
- `ws.onmessage` — assign it at the site where the `/ws` socket is created/opened (next to `sendAppexecResponse`'s definition), so `ws` refers to the live, reconnecting socket instance.
- `btwInit()` — call it at the end of the existing DOM-ready/init sequence, after the tab/view wiring, so all `getElementById` targets exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: PASS (9 tests: 5 from Task 9 + 4 new).

- [ ] **Step 5: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
git commit -m "feat(webui): wire btw panel client logic over /ws and /api/btw"
```

## Phase 4 — contract + gates

