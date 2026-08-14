# HITL Webui — Phase 3: Browser Declarative-Controls Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the #03 prototype shell (`render-shell.ts`) so the browser can answer a pending `webui_present` presentation via a declarative-controls toolbar over the existing `/ws` inbound channel.

**Architecture:** The shell is a single `RENDER_SHELL_HTML` template-literal string served at `GET /` (vanilla inline JS, no framework, no build step). The per-image `attachFeedbackToolbars` DOM-sniffing prototype is replaced by view-metadata-driven rendering: `renderView()` renders one `.webui-toolbar` under `#content` whenever the Phase-2 view JSON carries `presentId` + `controls` (the agent decides the controls, not the shell). Clicking a control sends an `appexec` respond frame (`{type:"appexec", extra:{kind:"respond", id, action, tweak?}}`) — the Phase-1 wire contract (`protocol.ts` `AppExecCommandSchema` stays loose; `parseCommand` validates the respond sub-shape). The SSE handler gains an auto-focus probe so a present on a non-active view switches tabs (blocking gate — an unfocused view is a silent deadlock). The WS client gains the SSE-style 2s reconnect.

**Tech Stack:** TypeScript + Bun (`bun test` is the gate), vanilla inline-JS-in-a-template-literal (existing shell style), TypeBox schemas unchanged (no schema edits this phase).

## Global Constraints

- Loopback-only / auth-off posture untouched (no web-server.ts changes).
- `bun test` IS the gate — the package test env has **no DOM** (`typeof document === "undefined"`, no happy-dom/jsdom); browser behavior is tested via pure helpers (`APPEXEC_FRAME`) + string-contains assertions over `RENDER_SHELL_HTML`.
- **No new dependencies** (nothing added to `package.json`).
- TypeBox N/A here — no schema changes this phase (`protocol.ts` untouched).
- Heartbeat (#1300) and `/api/logs` untouched.
- All paths are under `bun-apps/pi-agent-ext-webui/`.
- Shell style stays vanilla: template literals with string concatenation only inside the inline JS (a backtick or `${` inside the template literal would break the TS string).
- Do NOT change the SSE payload shape — it stays `{viewId, updatedAt}` (render-event-handler.ts contract).
- The existing shell contract guards in `tests/render-shell.test.ts` must keep passing (marker comment, `id="tabs"`, `id="content"`, `EventSource('/api/events')`, `setAttribute('sandbox', '')`, `GET /` serves the exact constant).

---

## File Structure

- **Modify:** `bun-apps/pi-agent-ext-webui/src/render-shell.ts` — the whole change lives in this one file: replace the steer/feedback prototype (WS block, `logSteer`, `sendSteer`, `basenameOf`, `attachFeedbackToolbars`, `STEER_FRAME`/`APPROVE_TEXT`/`REGENERATE_TEXT` exports) with the HITL response machinery (`connectWs`/`scheduleWsRetry`, `logResponse`, `sendAppexecResponse`, `renderControls`, `APPEXEC_FRAME`), extend `renderView` + the SSE handler, rename the log panel header.
- **Create:** `bun-apps/pi-agent-ext-webui/tests/render-shell-controls.test.ts` — new contract test (pure helper + string-contains; ports the still-true regression guards from the old feedback test).
- **Delete:** `bun-apps/pi-agent-ext-webui/tests/render-shell-feedback.test.ts` — its pinned `steer` formulations are obsolete (the #05 contract is structured responses, not prose).

Single task on purpose: this is a single-file coherent change with its own test cycle (write new test → red → evolve shell → delete dead weight → green → gates).

### Grounding (read these lines before editing)

- `src/render-shell.ts` (239 lines): subscribe L103–110, `loadViews` L64–78, `renderView` L81–98 (md branch `innerHTML` L96 + `attachFeedbackToolbars(contentEl)` call L97; html iframe L89–93), WS block L118–122, `sendSteer` L133–141, `logSteer` L124–131, `attachFeedbackToolbars` L150–207, clear-link wiring L210–215, pure-helper exports L224–239, `.webui-toolbar` CSS block L31–34, log-panel markup L62–65.
- `tests/render-shell-feedback.test.ts` — port the still-true guards (ws wiring, log panel, JSON.stringify/send/OPEN guard, original shell contract).
- `tests/render-shell.test.ts` — existing shell contract guards (do not break).
- `src/render-routes.ts` L78–102 — view JSON both branches: `{id, mode, content|html, title, updatedAt, controls?, presentId?}` (`controls`/`presentId` spread only when defined).
- `src/protocol.ts` — `AppExecCommandSchema` L45–48 (loose `extra` Record), `DispatchAction` respond variant L121–138 (`{kind:"appexec", op:"respond", id, action, tweak?}`).
- `.planning/2026-08-14-build-hitl-webui/sdd/progress.md` L20–24 — Phase-2 ledger; this phase resolves **L23** (see Self-Review).

---

### Task 1: Declarative-controls toolbar + appexec respond in the render shell

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (WS block L118–122; `logSteer` L124–131; `sendSteer` L133–141; `basenameOf` L143–148; `attachFeedbackToolbars` L150–207; `renderView` L81–98; `subscribe` SSE handler L103–110; log-panel header markup L62–65; CSS comment L30 + toolbar CSS L31–34; module doc comment L1–12; pure-helper exports L224–239)
- Create: `bun-apps/pi-agent-ext-webui/tests/render-shell-controls.test.ts`
- Delete: `bun-apps/pi-agent-ext-webui/tests/render-shell-feedback.test.ts`

**Interfaces:**
- Consumes: the Phase-2 view JSON from `GET /api/view/:id` — `{id: string, mode: "md"|"html", html?: string, content?: string, title: string|null, updatedAt: number, controls?: {id: string, label: string, takesInput?: boolean}[], presentId?: string}` (render-routes.ts L78–102; `controls`/`presentId` present only when the view carries them); the Phase-1 appexec wire frame `{type:"appexec", extra:{kind:"respond", id, action, tweak?}}` (protocol.ts AppExecCommandSchema L45–48 + DispatchAction respond variant L121–138).
- Produces: `export const APPEXEC_FRAME = (id: string, action: string, tweak?: string): {type:"appexec"; extra:{kind:"respond"; id:string; action:string; tweak?:string}}` — omits the `tweak` key when `tweak === undefined`. Phase 4's image-presentation helpers may reuse it in tests.

- [ ] **Step 1: Write the failing test**

Create `bun-apps/pi-agent-ext-webui/tests/render-shell-controls.test.ts` with EXACTLY this content:

```ts
import { describe, expect, it } from "bun:test";
import { APPEXEC_FRAME, RENDER_SHELL_HTML } from "../src/render-shell.js";

/**
 * Phase 3 (spec Component 4): declarative-controls toolbar. The inline shell
 * script lives in an HTML string with no build/module step, so it is exercised
 * via (a) the pure APPEXEC_FRAME helper (the PINNED wire shape the inline
 * script duplicates) and (b) string-contains checks over RENDER_SHELL_HTML.
 *
 * A live DOM-behavior test (load the shell, render a view with controls, click
 * a button) is NOT feasible here: this package's test env has NO DOM (no
 * happy-dom/jsdom; `typeof document === "undefined"`), and the phase scope
 * forbids adding deps or a bunfig preload. Same fallback as the #03 prototype.
 */
describe("APPEXEC_FRAME pure helper", () => {
  it("builds the appexec respond frame with a tweak", () => {
    const f = APPEXEC_FRAME("pres-1", "revise", "warmer tones");
    expect(f).toEqual({
      type: "appexec",
      extra: { kind: "respond", id: "pres-1", action: "revise", tweak: "warmer tones" },
    });
  });

  it("omits the tweak key when the tweak is undefined", () => {
    const f = APPEXEC_FRAME("pres-1", "approve");
    expect(f).toEqual({
      type: "appexec",
      extra: { kind: "respond", id: "pres-1", action: "approve" },
    });
    expect("tweak" in f.extra).toBe(false);
  });

  it("omits the tweak key for an empty-string tweak (shell sends t || undefined)", () => {
    const f = APPEXEC_FRAME("pres-1", "regenerate", "");
    expect("tweak" in f.extra).toBe(false);
  });
});

describe("RENDER_SHELL_HTML — declarative HITL response wiring (phase 3)", () => {
  it("defines sendAppexecResponse with the respond wire shape", () => {
    expect(RENDER_SHELL_HTML).toContain("function sendAppexecResponse");
    expect(RENDER_SHELL_HTML).toContain("kind: 'respond'");
    expect(RENDER_SHELL_HTML).toContain("type: 'appexec'");
  });

  it("sends via JSON.stringify and guards against a non-OPEN ws, logging the sent frame", () => {
    expect(RENDER_SHELL_HTML).toContain("JSON.stringify");
    expect(RENDER_SHELL_HTML).toContain("ws.send");
    expect(RENDER_SHELL_HTML).toContain("WebSocket.OPEN");
    expect(RENDER_SHELL_HTML).toContain("ws not open");
    expect(RENDER_SHELL_HTML).toContain("appexec response sent");
  });

  it("defines renderControls and calls it from renderView (both content branches)", () => {
    expect(RENDER_SHELL_HTML).toContain("function renderControls");
    expect(RENDER_SHELL_HTML).toContain("renderControls(v);");
    expect(RENDER_SHELL_HTML).toContain("takesInput");
    expect(RENDER_SHELL_HTML).toContain("webui-toolbar");
  });

  it("enforces one response per presentation (disable + mark chosen)", () => {
    expect(RENDER_SHELL_HTML).toContain("respondedPresent");
    expect(RENDER_SHELL_HTML).toContain("webui-chosen");
    expect(RENDER_SHELL_HTML).toContain("disabled = true");
  });

  it("auto-focuses a presenting view in the SSE handler without changing the payload shape", () => {
    expect(RENDER_SHELL_HTML).toContain("v.presentId");
    expect(RENDER_SHELL_HTML).toContain("location.hash = data.viewId");
    // payload stays {viewId, updatedAt} — the handler only reads data.viewId
    expect(RENDER_SHELL_HTML).toContain("data.viewId");
  });

  it("reconnects the ws with a 2s guarded backoff (mirrors the SSE pattern)", () => {
    expect(RENDER_SHELL_HTML).toContain("function connectWs");
    expect(RENDER_SHELL_HTML).toContain("function scheduleWsRetry");
    expect(RENDER_SHELL_HTML).toContain("2000");
    expect(RENDER_SHELL_HTML).toContain("wsRetryTimer !== null");
    expect(RENDER_SHELL_HTML).toContain("connectWs()");
  });

  it("keeps the response log panel with a clear link", () => {
    expect(RENDER_SHELL_HTML).toContain("webui-feedback-log");
    expect(RENDER_SHELL_HTML).toContain("webui-log-clear");
    expect(RENDER_SHELL_HTML).toContain("response log");
    expect(RENDER_SHELL_HTML).toContain("function logResponse");
  });

  it("removes the dead #03 prototype (per-image DOM sniffing + steer prose)", () => {
    expect(RENDER_SHELL_HTML).not.toContain("attachFeedbackToolbars");
    expect(RENDER_SHELL_HTML).not.toContain("STEER_FRAME");
    expect(RENDER_SHELL_HTML).not.toContain("APPROVE_TEXT");
    expect(RENDER_SHELL_HTML).not.toContain("REGENERATE_TEXT");
    expect(RENDER_SHELL_HTML).not.toContain("sendSteer");
    expect(RENDER_SHELL_HTML).not.toContain("logSteer");
    expect(RENDER_SHELL_HTML).not.toContain("type: 'steer'");
    expect(RENDER_SHELL_HTML).not.toContain("basenameOf");
    expect(RENDER_SHELL_HTML).not.toContain("Regenerate");
  });

  it("still opens the existing /ws inbound channel", () => {
    expect(RENDER_SHELL_HTML).toContain("/ws");
    expect(RENDER_SHELL_HTML).toContain("new WebSocket");
  });

  it("still preserves the original shell contract (tabs/content/sse/sandbox)", () => {
    expect(RENDER_SHELL_HTML).toContain("<!-- webui-render-shell -->");
    expect(RENDER_SHELL_HTML).toContain("<!doctype html>");
    expect(RENDER_SHELL_HTML).toContain('id="tabs"');
    expect(RENDER_SHELL_HTML).toContain('id="content"');
    expect(RENDER_SHELL_HTML).toContain("EventSource('/api/events')");
    expect(RENDER_SHELL_HTML).toContain("setAttribute('sandbox', '')");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-controls.test.ts )`
Expected: FAIL — `APPEXEC_FRAME` is not exported from `../src/render-shell.js` (import error), so the whole file errors before any assertion runs.

- [ ] **Step 3: Evolve the shell — implement all changes in `src/render-shell.ts`**

Apply the following edits IN ORDER. Every code block below is complete — paste verbatim into the template literal (note: inline JS uses string concatenation only; never a backtick or `${`).

**3a. Module doc comment (L1–12).** Replace the `Client behavior (D4):` bullet list's last bullet and append a HITL bullet — replace:

```
 *   - EventSource('/api/events') -> on view_update refresh tabs + re-render the
 *     affected view.
 */
```

with:

```
 *   - EventSource('/api/events') -> on view_update refresh tabs + re-render the
 *     affected view; a view carrying presentId auto-focuses (blocking HITL gate).
 *   - When a view JSON carries presentId + controls, renderView appends a
 *     declarative .webui-toolbar under #content; a control click sends an
 *     appexec respond frame over /ws (one response per presentation).
 */
```

**3b. CSS (L30–34).** Replace:

```
  /* zk-spawn prototype: per-image feedback toolbar + on-screen steer log */
  .webui-result { margin: .5rem 0; padding: .5rem; border: 1px solid #8884; border-radius: 6px; background: #8881; }
  .webui-result img { max-width: 100%; height: auto; border-radius: 4px; display: block; }
  .webui-toolbar { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; flex-wrap: wrap; }
  .webui-toolbar button { padding: .2rem .55rem; border: 1px solid #8886; border-radius: 4px; background: #8882; color: inherit; cursor: pointer; }
  .webui-toolbar button:hover { background: #6cf3; }
  .webui-toolbar input { padding: .2rem .4rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }
```

with (drops the dead `.webui-result` image-wrapper rules, adds disabled/chosen/tweak styles):

```
  /* HITL response toolbar + on-screen response log */
  .webui-toolbar { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; flex-wrap: wrap; }
  .webui-toolbar button { padding: .2rem .55rem; border: 1px solid #8886; border-radius: 4px; background: #8882; color: inherit; cursor: pointer; }
  .webui-toolbar button:hover:not(:disabled) { background: #6cf3; }
  .webui-toolbar button:disabled { opacity: .45; cursor: default; }
  .webui-toolbar button.webui-chosen { border-color: #6cf; background: #6cf3; font-weight: 600; }
  .webui-toolbar input { padding: .2rem .4rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; }
  .webui-tweak { display: inline-flex; gap: .3rem; align-items: center; }
```

**3c. Log-panel header (L63).** Replace `<span>steer log</span>` with `<span>response log</span>` (the `#webui-feedback-log` / `webui-log-clear` / `webui-feedback-log-body` ids stay — they are the repurposed panel).

**3d. `renderView` (L81–98).** Replace the whole `if (v.mode === 'html') { ... } else { ... }` tail:

```
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
```

with (content branches no longer differ at the tail; the toolbar rides after either):

```
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
```

**3e. SSE handler (inside `subscribe()`, L103–110).** Replace:

```
  es.onmessage = async function (e) {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (data && data.viewId) { await loadViews(); if (data.viewId === activeId) await renderView(activeId); }
  };
```

with:

```
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
```

**3f. WS block + response functions (L118–207).** Delete EVERYTHING from the comment block starting `// --- zk-spawn prototype: shell-hosted feedback toolbar over the /ws channel ---` through the end of `attachFeedbackToolbars` (i.e. the old WS const/onopen/onclose/onerror, `logSteer`, `sendSteer`, `basenameOf`, `attachFeedbackToolbars`), and paste this in its place:

```js
// --- HITL response channel: the EXISTING inbound /ws (web-server.ts upgrade) ---
// Mirrors the SSE reconnect pattern: on close/error, retry after 2s (guarded
// against duplicate timers). sendAppexecResponse posts 'appexec' respond
// frames (protocol.ts: AppExecCommandSchema keeps `extra` loose; parseCommand
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

function sendAppexecResponse(id, action, tweak) {
  const extra = { kind: 'respond', id: id, action: action };
  if (tweak) extra.tweak = tweak; // omit the key when absent (present-tool details semantics)
  const frame = { type: 'appexec', extra: extra };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
    console.log('[webui] appexec response sent:', JSON.stringify(frame));
  } else {
    console.warn('[webui] ws not open; would send:', frame);
  }
  logResponse(action + (tweak ? ' (tweak: ' + tweak + ')' : ''));
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
```

**3g. Bottom-of-module exports (L223–239).** Delete the entire trailing comment + the three exports (`STEER_FRAME`, `APPROVE_TEXT`, `REGENERATE_TEXT`) and replace with:

```ts
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
```

(The `tweak !== ""` clause keeps the pure helper consistent with the inline `t || undefined` submission path: an empty tweak never lands on the wire as `tweak: ""`.)

**3h. Sanity-check the IIFE tail (L209–217).** The clear-link wiring stays exactly as-is:

```js
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
```

No edit needed — verify it survived the 3f block replacement intact (it sits between `attachFeedbackToolbars` and the closing `</script>`; if your 3f deletion boundaries swallowed it, re-paste the block above).

- [ ] **Step 4: Delete the obsolete test file**

```bash
git rm bun-apps/pi-agent-ext-webui/tests/render-shell-feedback.test.ts
```

It imports `STEER_FRAME`/`APPROVE_TEXT`/`REGENERATE_TEXT` and pins the `type: 'steer'` prose contract — all removed by design (the #05 contract is structured responses). Its still-true guards were ported into `tests/render-shell-controls.test.ts` in Step 1.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-controls.test.ts )`
Expected: PASS — 13 tests, 0 fail.

- [ ] **Step 6: Full package gates**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun run test )`
(`bun run test` = `bun run build && bun run test:unit` — the canonical gate; `tsc` proves the exports compile and the template literal is intact.)
Expected: typecheck exit 0, build exit 0, ALL tests pass (including the untouched `tests/render-shell.test.ts` contract guards and `tests/render-routes.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts \
        bun-apps/pi-agent-ext-webui/tests/render-shell-controls.test.ts \
        .planning/2026-08-14-build-hitl-webui/plan-phase3.md
git commit -m "feat(webui): declarative HITL response toolbar in render shell (phase 3)

Replace the #03 per-image steer prototype with view-metadata-driven controls:
renderControls renders agent-declared buttons (takesInput -> tweak input),
sendAppexecResponse posts {type:'appexec',extra:{kind:'respond',id,action,tweak?}}
over /ws with 2s reconnect, the SSE handler auto-focuses presenting views,
and the steer log becomes a response log. STEER_FRAME/APPROVE_TEXT/
REGENERATE_TEXT exports replaced by APPEXEC_FRAME."
```

(The plan file rides the branch per the repo's planning-artifacts standing rule.)

---

## Self-Review

**1. Spec coverage** (spec Component 4, `.planning/2026-08-14-build-hitl-webui/spec.md` L44–47 + task scope):

- Toolbar renders content + one button per control, `takesInput` → tweak input — Step 3f `renderControls` + Step 1 tests ("defines renderControls…", "takesInput", "webui-toolbar"). ✅
- `sendAppexecResponse` evolves `sendSteer`, omits `tweak` key when absent, guards `ws.readyState === WebSocket.OPEN`, logs the sent response — Step 3f + Step 1 tests ("respond wire shape", "guards against a non-OPEN ws"). Wire-compat: frame matches `AppExecCommandSchema` (loose `extra` Record validates) and the `parseCommand` respond sub-shape `{kind:"respond", id, action, tweak?}` (protocol.ts L45–48, L121–138). ✅
- One response per presentation (disable all + mark chosen) — `respondedPresent` + `submit()` in Step 3f; tested ("one response per presentation"). ✅
- Non-presentation views render no toolbar — `renderControls` early-returns on missing `presentId`/`controls`. ✅
- Auto-focus on present, SSE payload shape unchanged — Step 3e; tested ("auto-focuses a presenting view"). ✅
- Feedback log → response log with timestamp-ish prefix, clear link kept — Step 3c + `logResponse` (`fmtTime(Date.now())` prefix); tested. ✅
- WS reconnect with 2s backoff, duplicate-timer guard — Step 3f `connectWs`/`scheduleWsRetry`; tested. ✅
- Dead weight removed (`attachFeedbackToolbars`, `STEER_FRAME`/`APPROVE_TEXT`/`REGENERATE_TEXT`, old test file) + `APPEXEC_FRAME` added — Steps 3f/3g/4; absence-tested. ✅
- Global constraints: no `web-server.ts` / `protocol.ts` / `render-routes.ts` / heartbeat / `/api/logs` edits; no new deps; loopback/auth untouched. ✅

**2. Placeholder scan:** no TBD/TODO/"add handling"/"similar to Task N"; every code step carries complete paste-ready code; every referenced fn (`sendAppexecResponse`, `renderControls`, `logResponse`, `connectWs`, `scheduleWsRetry`, `APPEXEC_FRAME`, `fmtTime`, `loadViews`, `refresh`, `subscribe`) is defined in this plan or already exists in the shell. ✅

**3. Type consistency:** `APPEXEC_FRAME`'s return type matches the `DispatchAction` respond variant's `{id, action, tweak?}` field names and the inline `extra` construction (`kind: 'respond'`, `id: id`, `action: action`); view-JSON field names (`presentId`, `controls`, `takesInput`, `label`, `html`, `content`, `mode`, `title`, `updatedAt`) match render-routes.ts L78–102 and present-tool.ts's `Control` (`{id, label, takesInput?}`). The inline `t || undefined` submission and the helper's `tweak !== ""` clause agree: an empty tweak never reaches the wire. ✅

**Ledger item L23 resolution (documented decision, no code change):** Can the toolbar produce `{action:"approve", tweak}`? Only if the agent declares `takesInput: true` on an approve control — possible but purely agent-driven (the shell never invents a tweak for a plain approve button; `submit()` sends `t || undefined`). The `describeHitlResponse` tweak-before-approve precedence is therefore **correct phrasing** when a tweak exists ("requested approve with tweak" is exactly what happened). Ledger item **CLOSED as intentional**; mark it resolved in `sdd/progress.md` when the phase's final review lands.
