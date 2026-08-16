import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
