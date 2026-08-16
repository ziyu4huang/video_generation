import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
const src = readFileSync(new URL("../src/render-shell.ts", import.meta.url), "utf8");
describe("tab-views 01b — five tabs (literal)", () => {
  test("template: four panes", () => {
    expect(src).toContain('<section id="report-pane" hidden></section>');
    expect(src).toContain('<section id="ask-pane" hidden></section>');
    expect(src).toContain('<section id="cards-pane" hidden></section>');
    expect(src).toContain('<section id="data-pane" hidden></section>');
  });
  test("setPane exclusive + tabs wired + Events relabel", () => {
    expect(src).toContain("function setPane(name)");
    expect(src).toContain("'pane-tab-' + spec[1]");
    expect(src).toContain("cardsTab.textContent = 'Events';");
  });
  test("routing: ask->ask pane, viewer->data, else events", () => {
    expect(src).toContain("rawId.indexOf('ask-') === 0 ? askPaneEl : (kind === 'viewer' ? dataPaneEl : cardsPaneEl)");
  });
  test("report: md builder + sandboxed html iframe", () => {
    expect(src).toContain("function renderReport(frame)");
    expect(src).toContain("function renderMarkdown(md)");
    expect(src).toContain("ifr.setAttribute('sandbox', 'allow-scripts')");
  });
  test("replay resets all four panes", () => {
    expect(src).toContain("if (reportPaneEl) reportPaneEl.textContent = '';");
    expect(src).toContain("if (dataPaneEl) dataPaneEl.textContent = '';");
  });
  test("hash activates the OWNING pane", () => {
    expect(src).toContain("setPane(pid === 'report-pane' ? 'report' : pid === 'ask-pane' ? 'ask' : pid === 'data-pane' ? 'data' : 'events')");
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
