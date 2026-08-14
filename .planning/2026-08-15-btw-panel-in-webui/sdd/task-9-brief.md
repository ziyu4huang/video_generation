### Task 9: shell panel markup + pure helpers

**Files:**
- Modify: `bun-apps/pi-agent-ext-webui/src/render-shell.ts` (add `BTW_FRAME`, `BTW_MESSAGE_HTML` exports; extend `RENDER_SHELL_HTML` with panel markup + CSS)
- Test: `bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts`

**Interfaces:**
- Consumes: existing `RENDER_SHELL_HTML` export and its header/main DOM structure (`header#tabs`, `main` with `#meta` + `#content`, `.webui-toolbar`); prior-art pure-helper style of `APPEXEC_FRAME(id, action, tweak?)`.
- Produces: `BTW_FRAME(kind: string, extra?: Record<string, unknown>): { type: "btw"; kind: string; [k: string]: unknown }`; `BTW_MESSAGE_HTML(m: BtwMessageSnapshot): string` (HTML string for one message row); panel DOM ids `btw-panel`, `btw-collapse`, `btw-messages`, `btw-input`, `btw-ask`, `btw-new`, `btw-clear`, `btw-inject`, `btw-summarize`, `btw-mode`, `btw-model`, `btw-thinking`; localStorage key `"btw-panel-collapsed"`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
import { describe, expect, it } from "bun:test";
import { BTW_FRAME, BTW_MESSAGE_HTML, RENDER_SHELL_HTML } from "../src/render-shell";

describe("RENDER_SHELL_HTML btw panel scaffold", () => {
  it("embeds the btw side panel structure", () => {
    expect(RENDER_SHELL_HTML).toContain('id="btw-panel"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-messages"');
    expect(RENDER_SHELL_HTML).toContain('id="btw-input"');
    for (const id of ["btw-collapse", "btw-ask", "btw-new", "btw-clear", "btw-inject", "btw-summarize", "btw-mode", "btw-model", "btw-thinking"]) {
      expect(RENDER_SHELL_HTML).toContain(`id="${id}"`);
    }
  });

  it("uses the agreed localStorage key for the collapse state", () => {
    expect(RENDER_SHELL_HTML).toContain("btw-panel-collapsed");
  });
});

describe("BTW_FRAME pure helper", () => {
  it("builds flat btw command frames", () => {
    expect(BTW_FRAME("ask", { text: "hi" })).toEqual({ type: "btw", kind: "ask", text: "hi" });
    expect(BTW_FRAME("mode", { mode: "tangent" })).toEqual({ type: "btw", kind: "mode", mode: "tangent" });
  });

  it("omits the extra keys entirely when none are given", () => {
    const f = BTW_FRAME("clear");
    expect(f).toEqual({ type: "btw", kind: "clear" });
    expect("text" in f).toBe(false);
  });
});

describe("BTW_MESSAGE_HTML pure helper", () => {
  it("renders a snapshot row keyed by id with escaped text", () => {
    const html = BTW_MESSAGE_HTML({ id: "btw-m-1", role: "assistant", text: "a < b", status: "done" });
    expect(html).toContain('data-id="btw-m-1"');
    expect(html).toContain("a &lt; b");
    expect(html).not.toContain("btw-status");
  });

  it("renders the status line for non-done snapshots", () => {
    const html = BTW_MESSAGE_HTML({
      id: "btw-m-1",
      role: "assistant",
      text: "ans",
      status: "running-tool",
      statusText: "running-tool: bash",
    });
    expect(html).toContain("btw-status");
    expect(html).toContain("running-tool: bash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: FAIL — `BTW_FRAME` / `BTW_MESSAGE_HTML` not exported; panel ids absent from `RENDER_SHELL_HTML`.

- [ ] **Step 3: Implement the pure helpers**

In `bun-apps/pi-agent-ext-webui/src/render-shell.ts`, next to `APPEXEC_FRAME`:

```ts
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
// (If render-shell.ts already defines an escapeHtml, reuse it instead of adding a second one.)

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
```

- [ ] **Step 4: Add the panel markup + CSS to RENDER_SHELL_HTML**

Inside the `RENDER_SHELL_HTML` template string: add the CSS to the existing `<style>` block, and wrap the existing `<main>` usage in a flex row with the new `<aside>`. Concretely — extend the style block with:

```css
#shell-row { display: flex; flex: 1; min-height: 0; }
#shell-row > main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
#btw-panel { flex: 0 0 340px; display: flex; flex-direction: column; border-left: 1px solid #333; padding: 8px; gap: 6px; min-height: 0; }
body.btw-collapsed #btw-panel { display: none; }
#btw-messages { flex: 1 1 auto; overflow-y: auto; font-size: 13px; }
.btw-msg { margin: 4px 0; padding: 6px 8px; border-radius: 6px; background: #1b1b1b; }
.btw-msg.btw-user { background: #16324f; }
.btw-status { display: block; margin-top: 4px; color: #e0a030; font-size: 11px; }
.btw-notice { margin: 4px 0; padding: 6px 8px; border-radius: 6px; color: #7ec87e; background: #14290f; font-size: 12px; }
#btw-bar { display: flex; flex-wrap: wrap; gap: 4px; }
#btw-bar button, #btw-bar select { font-size: 12px; padding: 3px 8px; }
#btw-compose { display: flex; gap: 4px; }
#btw-input { flex: 1 1 auto; }
```

And change the main layout from `<main>…</main>` to:

```html
<div id="shell-row">
  <main><!-- existing #meta + #content markup, unchanged --></main>
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
```

(Adapt class names/spacing to the file's existing CSS conventions; the required contract is the id list above + the `body.btw-collapsed` hide rule + flex-row layout.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/render-shell-btw.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the package gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: PASS — existing render-shell tests (constant, GET / ordering) unaffected.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/render-shell.ts bun-apps/pi-agent-ext-webui/tests/render-shell-btw.test.ts
git commit -m "feat(webui): add btw side panel markup and frame/message helpers"
```

