import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
const src = readFileSync(new URL("../src/render-shell.ts", import.meta.url), "utf8");
describe("tab-views 01b — five tabs (literal)", () => {
  test("template: three panes — Inbox visible at boot (v3 03)", () => {
    expect(src).toContain('<section id="report-pane" hidden></section>');
    expect(src).toContain('<section id="cards-pane"></section>');
    expect(src).not.toContain('id="ask-pane"');
    expect(src).not.toContain('webui-transcript');
    expect(src).not.toContain('function txLine');
    // webui-v3 fix (report-iframe): the report iframe gets a REAL size rule
    // (browser default was 300x150) + panes 70vh + fullscreen escape hatch.
    expect(src).toContain('#report-pane article iframe { width: 100%; min-height: 70vh;');
    // webui-v3 (dynamic shell): full-viewport app layout — no fixed caps.
    expect(src).toContain('height: 100dvh');
    expect(src).toContain('flex: 1; min-height: 0; overflow-y: auto;');
    expect(src).not.toContain('max-height: 70vh');
    expect(src).toContain('#content:empty');
    expect(src).not.toContain('max-height: 45vh');
    expect(src).not.toContain('#ask-pane');
    expect(src).toContain('requestFullscreen');
    // report-raw: downloads unblocked in-frame + the standalone door.
    expect(src).toContain("'allow-scripts allow-downloads'");
    expect(src).toContain("encodeURIComponent(frame.id)");
    expect(src).toContain('<section id="data-pane" hidden></section>');
  });
  test("setPane exclusive + tabs wired + Events relabel", () => {
    expect(src).toContain("function setPane(name)");
    expect(src).toContain("'pane-tab-' + spec[1]");
    expect(src).toContain("cardsTab.textContent = 'Inbox';");
  });
  test("routing: ask->ask pane, viewer->data, else events", () => {
    expect(src).toContain("const pane = kind === 'viewer' ? dataPaneEl : cardsPaneEl;");
  });
  test("report: md builder + sandboxed html iframe", () => {
    expect(src).toContain("function renderReport(frame)");
    expect(src).toContain("function renderMarkdown(md)");
    expect(src).toContain("ifr.setAttribute('sandbox', 'allow-scripts allow-downloads')"); // report-raw: downloads unblocked
  });
  test("replay resets all three panes (v3 03)", () => {
    expect(src).toContain("if (reportPaneEl) reportPaneEl.textContent = '';");
    expect(src).toContain("if (dataPaneEl) dataPaneEl.textContent = '';");
    expect(src).not.toContain("askPaneEl");
  });
  test("hash activates the OWNING pane", () => {
    expect(src).toContain("setPane(pid === 'report-pane' ? 'report' : pid === 'data-pane' ? 'data' : 'events')");
  });
});
describe("tab-views 01c — template-literal escape guard (regex SyntaxError class)", () => {
  test("md regexes carry DOUBLE backslashes in SOURCE bytes", () => {
    expect(src).toContain(String.raw`.split(/(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*)/g);`);
    expect(src).toContain(String.raw`raw.replace(/\\s+$/, '');`);
    expect(src).toContain(String.raw`/^(#{1,3})\\s+(.*)$/.exec(line);`);
    expect(src).toContain(String.raw`/^[-*]\\s+(.*)$/.exec(line);`);
  });
  test("COOKED shell keeps single-backslash regex bytes (what the browser parses)", () => {
    expect(RENDER_SHELL_HTML).toContain(".split(/(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*)/g);");
    expect(RENDER_SHELL_HTML).toContain("raw.replace(/\\s+$/, '');");
    expect(RENDER_SHELL_HTML).toContain("/^(#{1,3})\\s+(.*)$/.exec(line);");
    expect(RENDER_SHELL_HTML).toContain("/^[-*]\\s+(.*)$/.exec(line);");
  });
  test("main shell <script> body parses as JavaScript (new Function never throws)", () => {
    // Lazy-pair every <script>...</script>; the MAIN shell script is the body
    // containing setPane (the shim/srcdoc strings contain <script> TEXT but
    // never a literal </script> — the HTML parser would have exited early
    // otherwise, so pairing is complete for the real scripts).
    const bodies = [...RENDER_SHELL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    const main = bodies.filter((b) => b.includes("function setPane"));
    expect(main.length).toBeGreaterThanOrEqual(1);
    for (const body of main) expect(() => new Script(body, { filename: "webui-main-shell.js" })).not.toThrow();
  });
});
describe("tab-views 01d — newline-escape guard (real-LF-in-string class)", () => {
  test("string \\n sites stay ESCAPED in cooked output (no real LF inside string literals)", () => {
    expect(RENDER_SHELL_HTML).toContain("String(md).split('\\n')");
    expect(RENDER_SHELL_HTML).toContain("c.textContent = code.join('\\n');");
    expect(RENDER_SHELL_HTML).toContain("pre.textContent = code.join('\\n');");
  });
});
