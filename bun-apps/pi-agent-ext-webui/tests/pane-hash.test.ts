import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";

// Hash-addressable panes: #inbox/#report/#more make tabs shareable,
// back/forward-able, and refresh-stable WITHOUT giving up the single-page
// live shell (one SSE/WS subscription, cross-tab badge, zero-latency pane
// switches). Legacy #data/#btw deep links alias into #more (webui-simplify
// §2: BTW + Data fold into the secondary More tab). #card-<id> deep links
// keep precedence over pane routing.
describe("render shell — hash-addressable panes", () => {
  it("carries the pane-hash router + card precedence guard", async () => {
    const s = new WebServer({ port: 0 });
    try {
      s.setHttpRoutes(createRenderRoutes(new RenderService()));
      s.start();
      const html = await (await fetch(s.url + "/")).text();
      expect(html).toContain("function paneHashOf(name)");
      expect(html).toContain("function syncPaneHash()");
      expect(html).toContain("function handlePaneHash()");
      // pane names map onto hashes (inbox alias included)
      expect(html).toContain("if (name === 'events') return '#inbox';");
      expect(html).toContain("'#' + name");
      // webui-simplify §2: four tabs — More folds Data+BTW; legacy hashes alias
      expect(html).toContain("if (name === 'report' || name === 'more') return '#' + name;");
      expect(html).toContain("if (h === 'data' || h === 'btw') h = 'more';");
      expect(html).toContain("['More', 'more'");
      expect(html).not.toContain("['Data', 'data'");
      expect(html).not.toContain("['BTW', 'btw'");
      expect(html).toContain("['report', 'more']");
      // card deep links own routing — both guards present
      expect(html.match(/parseCardHashInline\(location\.hash\) !== null\) return;/g)?.length).toBe(2);
      // boot restores from hash; hashchange routes cards FIRST (they own it)
      expect(html).toContain("handlePaneHash(); // hash-addressable panes");
      expect(html).toContain("handleCardHash(); handlePaneHash();");
      // setPane syncs the URL after switching (and vice versa)
      expect(html).toContain("syncPaneHash(); // hash-addressable panes");
    } finally {
      s.stop();
    }
  });
});
