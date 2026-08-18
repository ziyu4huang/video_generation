import { describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";

// Full-bleed scroll (user report: "scrollbar not close to browser edge").
// Root cause: main had padding:1rem + max-width:1500px centered, so the pane
// scroll containers — and their scrollbars — sat inset from the viewport edge.
// Fix contract, pinned here at the stylesheet level:
//   1. main carries NO horizontal padding and NO width cap (scroll surfaces
//      span the viewport; the scrollbar renders at the browser edge).
//   2. Horizontal rhythm moves to the panes themselves (padding-inline).
//   3. The 1500px reading-measure cap survives on the CONTENT layer
//      (#content > *, cards, report articles) so wide-screen layout is
//      unchanged apart from the scrollbar position.
describe("render shell — full-bleed pane scroll", () => {
  it("scroll containers span the viewport; measure cap lives on content", async () => {
    const s = new WebServer({ port: 0 });
    try {
      s.setHttpRoutes(createRenderRoutes(new RenderService()));
      s.start();
      const html = await (await fetch(s.url + "/")).text();
      expect(html).toContain("main { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 1rem 0; width: 100%; overflow: hidden; }");
      expect(html).toContain("#cards-pane .card, #report-pane article { max-width: 1500px");
      expect(html).toContain("padding: .4rem 1rem");
      expect(html).toContain("padding: 0 1rem");
      // the old inset shapes must be gone
      expect(html).not.toContain("margin: 0 auto; overflow: hidden");
      expect(html).not.toContain("padding: .4rem 0");
    } finally {
      s.stop();
    }
  });
});
