import { describe, expect, it } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

/**
 * event-cards (01): Cards tab + pane projection. The inline shell script
 * lives in an HTML string with no build/module step and this package's test
 * env has NO DOM (same fallback as render-shell-controls.test.ts): pure
 * string-contains checks over RENDER_SHELL_HTML, plus a sliced renderCard
 * "twin" so the XSS assertions scope to the card path EXACTLY (from the
 * renderCard definition to the next function definition).
 */

/** Slice the in-string renderCard source — the unit card-path assertions run against. */
function renderCardSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function renderCard(frame)");
  const end = RENDER_SHELL_HTML.indexOf("function renderAskUser(frame)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("RENDER_SHELL_HTML — Cards tab + pane scaffold (event-cards 01)", () => {
  it("embeds the hidden cards pane (flex must not defeat [hidden]) + the Cards tab build site", () => {
    expect(RENDER_SHELL_HTML).toContain('id="cards-pane"');
    expect(RENDER_SHELL_HTML).toContain('id="cards-pane" hidden');
    expect(RENDER_SHELL_HTML).toContain("cards-pane[hidden]");
    // the tab is DOM-built inside loadViews (not an HTML attribute) — its id
    // assignment lives in the script string
    expect(RENDER_SHELL_HTML).toContain("cardsTab.id = 'cards-tab'");
  });

  it("routes card frames through renderCard in txApply — live AND snapshot replay", () => {
    expect(RENDER_SHELL_HTML).toContain("case 'card': renderCard(frame); break;");
    // authoritative replay: the cards pane resets BEFORE the transcript replays
    expect(RENDER_SHELL_HTML).toContain("cardsPaneEl.textContent = ''");
    expect(RENDER_SHELL_HTML).toContain("state.transcript.forEach(txApply)");
  });

  it("builds the Cards tab inside loadViews with its own active state (view-tab toggle scoped)", () => {
    expect(RENDER_SHELL_HTML).toContain("cardsTab.id = 'cards-tab'");
    expect(RENDER_SHELL_HTML).toContain(".tab[data-view-id]");
  });

  it("renderCard appends an article card keyed by the #card-<id> anchor", () => {
    const src = renderCardSrc();
    expect(src).toContain("document.createElement('article')");
    expect(src).toContain("art.id = domId;");
    expect(src).toContain("art.className = 'card'");
    expect(src).toContain("art.setAttribute('data-kind', kind)");
    expect(src).toContain("art.setAttribute('data-attention', attention)");
    // cardDomId (defined just ABOVE renderCard) keeps the anchor form:
    // wiring ids pass through, foreign ids prefixed — assert on the full HTML
    expect(RENDER_SHELL_HTML).toContain("/^card-/.test(id) ? id : 'card-' + id");
    // dedupe by dom id + newest LAST (chronological order)
    expect(src).toContain("document.getElementById(domId)");
    expect(src).toContain("cardsPaneEl.appendChild(art)");
  });

  it("renders title/time/badge/body as TEXT (textContent assignments only)", () => {
    const src = renderCardSrc();
    expect(src).toContain("h.textContent =");
    expect(src).toContain("t.textContent =");
    expect(src).toContain("badge.textContent =");
    expect(src).toContain("body.className = 'card-body'");
    expect(src).toContain("body.textContent =");
  });

  it("XSS: a body.text with <script>/<img onerror> renders as literal text — the card path builds NO markup", () => {
    const src = renderCardSrc();
    // The body string is type-checked (never coerced) and assigned through the
    // text sink verbatim — payloads stay plain strings on the wire AND in the
    // DOM. NO markup-building sink exists anywhere on the card path, so
    // "<script>...</script>" / "<img onerror=...>" can only ever display.
    expect(src).toContain("typeof frame.body.text === 'string'");
    expect(src).toContain("body.textContent =");
    for (const sink of [
      "innerHTML",
      "insertAdjacentHTML",
      "outerHTML",
      "document.write",
      "createContextualFragment",
      "setAttribute('on",
    ]) {
      expect(src).not.toContain(sink);
    }
  });
});
