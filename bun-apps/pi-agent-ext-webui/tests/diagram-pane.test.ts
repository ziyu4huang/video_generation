import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";

/**
 * The Diagram pane (archify-view-pptx-bun, ticket 08).
 *
 * The shell is an inline string, so these are source-level assertions in the
 * spirit of the sibling shell tests — they pin the DECISIONS that are easy to
 * regress silently: no srcdoc, no weakened sandbox, replay-driven state, and
 * keyboard paging that cannot fire while someone is typing.
 */
let html = "";
let server: WebServer;

beforeAll(async () => {
  server = new WebServer({ port: 0 });
  server.setHttpRoutes(createRenderRoutes(new RenderService()));
  server.start();
  html = await (await fetch(`${server.url}/`)).text();
});

afterAll(() => server.stop());

describe("markup + tab", () => {
  it("ships a deck pane with a bar, rail and stage", () => {
    expect(html).toContain('<section id="deck-pane" hidden>');
    expect(html).toContain('<div id="deck-bar"></div>');
    expect(html).toContain('<div id="deck-rail"></div>');
    expect(html).toContain('<div id="deck-stage" class="fit"></div>');
  });

  it("registers a Diagram tab on the shared strip", () => {
    expect(html).toContain("['Diagram', 'deck'");
  });

  it("hides the pane unless it is active", () => {
    expect(html).toContain("if (deckPaneEl) deckPaneEl.hidden = name !== 'deck';");
  });
});

describe("full fidelity comes from the existing /files route", () => {
  it("uses a plain iframe src, never a srcdoc", () => {
    // srcdoc would put the artifact in a sandbox WITHOUT the /files CSP and
    // strip the runtime that IS the product (theme toggle, export menu).
    expect(html).toContain("frame.setAttribute('src', slide.url)");
    expect(html).not.toContain("deck-stage iframe srcdoc");
  });

  it("does not weaken the sandbox with a sandbox attribute of its own", () => {
    const deckBlock = html.slice(
      html.indexOf("// --- Diagram pane"),
      html.indexOf("// --- v2 live transcript mirror")
    );
    expect(deckBlock.length).toBeGreaterThan(500);
    expect(deckBlock).not.toContain("allow-same-origin");
    expect(deckBlock).not.toContain("setAttribute('sandbox'");
  });

  it("keeps the frame when the URL is unchanged (paging must not reload)", () => {
    expect(html).toContain("if (frame.getAttribute('src') !== slide.url)");
  });
});

describe("deck model", () => {
  it("feeds from BOTH diagram_deck and view_opened frames", () => {
    expect(html).toContain("case 'diagram_deck': deckOnFrame(frame); break;");
    expect(html).toContain("case 'view_opened': deckOnFrame(frame); break;");
  });

  it("collects single renders into one synthetic recent deck", () => {
    expect(html).toContain("var RECENT_DECK = '__recent';");
    expect(html).toContain("deckUpsert(RECENT_DECK, 'Recent renders', list)");
  });

  it("upserts by id so a re-emitted deck replaces rather than stacks", () => {
    expect(html).toContain("function deckUpsert(id, title, slides)");
    expect(html).toContain("if (!deckState.byId[id]) deckState.order.push(id);");
  });

  it("rebuilds from the snapshot replay instead of keeping stale state", () => {
    expect(html).toContain("deckReset(); // the deck rebuilds from replayed");
    expect(html).toContain("if (activePane === 'deck') renderDeckPane();");
  });
});

describe("navigation", () => {
  it("pages without wrapping past the ends", () => {
    expect(html).toContain("if (next < 0 || next >= d.slides.length) return; // no wrap");
  });

  it("binds arrow keys only on the active pane and never while typing", () => {
    const block = html.slice(html.indexOf("document.addEventListener('keydown'"));
    const guard = block.slice(0, 600);
    expect(guard).toContain("if (activePane !== 'deck') return;");
    expect(guard).toContain("t.tagName === 'INPUT'");
    expect(guard).toContain("t.isContentEditable");
    expect(guard).toContain("e.key === 'ArrowLeft'");
    expect(guard).toContain("e.key === 'ArrowRight'");
  });

  it("offers both escape hatches, mirroring the Report tab", () => {
    expect(html).toContain("requestFullscreen()");
    expect(html).toContain("window.open(slide.url, '_blank', 'noopener')");
  });

  it("offers a fit / actual zoom toggle", () => {
    expect(html).toContain("deckState.zoom = deckState.zoom === 'fit' ? 'actual' : 'fit';");
    expect(html).toContain("#deck-stage.fit iframe");
    expect(html).toContain("#deck-stage.actual iframe");
  });

  it("says something useful when there is nothing to show", () => {
    expect(html).toContain("No diagrams yet.");
  });

  it("shows a loading state while a slide swaps in", () => {
    // A rendered artifact is ~600 KB; a blank white stage reads as broken.
    expect(html).toContain("stage.classList.add('loading');");
    expect(html).toContain("frame.onload = function () { stage.classList.remove('loading'); };");
    expect(html).toContain("#deck-stage.loading::after { display: flex; }");
  });
});

describe("untrusted strings", () => {
  it("renders producer-supplied titles with textContent only", () => {
    const block = html.slice(
      html.indexOf("// --- Diagram pane"),
      html.indexOf("// --- v2 live transcript mirror")
    );
    // Titles and subtitles come from whatever emitted webui:deck.
    expect(block).not.toContain("innerHTML");
    expect(block).toContain("titleEl.textContent = slide.title");
    expect(block).toContain("chip.textContent");
  });
});
