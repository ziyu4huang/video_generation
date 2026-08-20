import { describe, expect, it } from "bun:test";
import { APPEXEC_CARD_ANSWER, RENDER_SHELL_HTML } from "../src/render-shell.js";

/**
 * event-cards (01): Cards tab + pane projection. The inline shell script
 * lives in an HTML string with no build/module step and this package's test
 * env has NO DOM (same fallback as render-shell-controls.test.ts): pure
 * string-contains checks over RENDER_SHELL_HTML, plus a sliced renderCard
 * "twin" so the XSS assertions scope to the card path EXACTLY (from the
 * renderCard definition to the next function definition).
 */

/** Slice the in-string renderCard source — the unit card-path assertions run
 *  against (from the renderCard definition to the next function definition;
 *  event-cards 02 added appendCardForm/retireCard between renderCard and the
 *  ask-user dialog, so the slice ends at appendCardForm). */
function renderCardSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function renderCard(frame)");
  const end = RENDER_SHELL_HTML.indexOf("function appendCardForm(art, frame)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("RENDER_SHELL_HTML — Cards tab + pane scaffold (event-cards 01)", () => {
  it("embeds the cards pane (Inbox, boot-visible; flex must not defeat [hidden] when setPane hides it) + the Cards tab build site", () => {
    expect(RENDER_SHELL_HTML).toContain('id="cards-pane"');
    expect(RENDER_SHELL_HTML).toContain('<section id="cards-pane"></section>'); // v3 03: Inbox visible at boot (hidden only via setPane)
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
    expect(src).toContain("pane.appendChild(art)");
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

/** Slice the in-string interactive-card form source — the event-cards (02)
 *  unit assertions run against (from the appendCardForm definition to the
 *  retireCard definition). */
function cardFormSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function appendCardForm(art, frame)");
  const end = RENDER_SHELL_HTML.indexOf("function retireCard(frame)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

/** Slice the in-string card_done tombstone source (retireCard -> ask-user). */
function retireCardSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function retireCard(frame)");
  const end = RENDER_SHELL_HTML.indexOf("// --- ask-user bridge dialog");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("RENDER_SHELL_HTML — interactive cards (event-cards 02)", () => {
  it("routes card_done through retireCard in txApply, AFTER card (replay order)", () => {
    const cardAt = RENDER_SHELL_HTML.indexOf("case 'card': renderCard(frame); break;");
    const doneAt = RENDER_SHELL_HTML.indexOf("case 'card_done': retireCard(frame); break;");
    expect(cardAt).toBeGreaterThan(-1);
    expect(doneAt).toBeGreaterThan(cardAt); // card THEN card_done — a [card, card_done] transcript replays answered
  });

  it("ships the form + answered-marker CSS next to the (01) card styles", () => {
    expect(RENDER_SHELL_HTML).toContain("#cards-pane .card p.card-question");
    expect(RENDER_SHELL_HTML).toContain("form.card-form");
    expect(RENDER_SHELL_HTML).toContain("form.card-form input, form.card-form select");
    expect(RENDER_SHELL_HTML).toContain("#cards-pane .card .card-done-toggle");
    expect(RENDER_SHELL_HTML).toContain("#cards-pane .card .card-done-detail");
    expect(RENDER_SHELL_HTML).toContain("#cards-pane .card p.card-answered");
    expect(RENDER_SHELL_HTML).toContain("#cards-pane .card.card-answered");
  });

  it("interactive body renders a fill-in form: question + labeled text input + select options + submit", () => {
    const src = cardFormSrc();
    // the form carries the RAW frame id (the key handleCardAnswer correlates on)
    expect(src).toContain("form.className = 'card-form'");
    expect(src).toContain("form.setAttribute('data-card-id', cardId)");
    // question paragraph
    expect(src).toContain("q.className = 'card-question'");
    expect(src).toContain("q.textContent = b.question");
    // per-field: label + named text input (name + placeholder) OR select
    expect(src).toContain("lab.textContent = typeof f.label === 'string' ? f.label : f.name");
    expect(src).toContain("inp.name = f.name");
    expect(src).toContain("inp.placeholder = f.placeholder");
    expect(src).toContain("sel.name = f.name");
    expect(src).toContain("document.createElement('option')");
    expect(src).toContain("opt.textContent = o");
    // invalid fields are skipped, never fatal
    expect(src).toContain("continue; // skip invalid fields");
    // submit button
    expect(src).toContain("btn.type = 'submit'");
    expect(src).toContain("btn.textContent = 'Submit'");
    // renderCard only appends the form for the interactive kind
    expect(RENDER_SHELL_HTML).toContain("if (kind === 'interactive') appendCardForm(art, frame)");
  });

  it("XSS: a question/label/option containing <script> renders as text — the form path builds NO markup", () => {
    const src = cardFormSrc();
    // every producer-sourced string lands in a text sink verbatim; no
    // markup-building sink exists anywhere on the form path
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

  it("submit posts the card_answer envelope via sendRaw (queued while reconnecting) — never raw ws.send", () => {
    const src = cardFormSrc();
    // one-shot collection of EVERY named field
    expect(src).toContain("var answers = Object.fromEntries(new FormData(form));");
    // the pinned envelope (mirrors the ask dialog's ask_user_answer, but over
    // sendRaw — the queue-when-reconnecting contract; DEVIATION is documented)
    expect(src).toContain(
      "sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: cardId, answers: answers } }));",
    );
    expect(src).not.toContain("ws.send(");
    // NO optimistic local state — the submit handler sends and does nothing else
    expect(src).not.toContain("classList.add('card-answered')");
    // pure twin: the exact envelope a DOM submit would produce, gridded no-DOM
    expect(APPEXEC_CARD_ANSWER("card-1", { mood: "rain" })).toEqual({
      type: "appexec",
      extra: { kind: "card_answer", cardId: "card-1", answers: { mood: "rain" } },
    });
  });

  it("card_done retires the form into a reviewable collapsed summary (cards-ux2 01; absent article ignored)", () => {
    const src = retireCardSrc();
    expect(src).toContain("document.getElementById(cardDomId(frame.id))");
    expect(src).toContain("if (!art) return"); // ordering anomaly — ignore, never error
    expect(src).toContain("art.querySelector('form.card-form')");
    // collapsed summary: title + answered marker
    expect(src).toContain("done.className = 'card-done'");
    expect(src).toContain("mark.textContent = 'answered'");
    expect(src).toContain("form.replaceWith(done)");
    expect(src).toContain("art.classList.add('card-answered')");
    // click toggles the read-only question + per-field answers, from the
    // submit-time stash (live only — replay degrades to the summary)
    expect(src).toContain("art.cardAnswers");
    expect(src).toContain("head.onclick = function () { detail.hidden = !detail.hidden; }");
    expect(src).toContain("line.textContent = r.label + ': ' +");
    // the answered path builds NO markup — createElement/textContent only
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write"]) {
      expect(src).not.toContain(sink);
    }
  });
});
