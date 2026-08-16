import { describe, expect, it } from "bun:test";
import { APPEXEC_CARD_SEND, RENDER_SHELL_HTML } from "../src/render-shell.js";
import { validateCardSendExtra } from "../src/protocol.js";

/**
 * cards-ux2 (02) scope B — the SHELL side of non-blocking draft cards. Same
 * no-DOM convention as render-shell-cards.test.ts: pure string-contains over
 * sliced in-string function sources (the served script has no build/module
 * step), plus the APPEXEC_CARD_SEND pure twin gridded exactly. Scope A (the
 * wiring loop: first-send-wins, JSONL, card_done, sendMessage) lives in
 * nonblocking-cards.test.ts.
 */

/** Slice the in-string appendCardForm source (renderCard's interactive arm). */
function cardFormSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function appendCardForm(art, frame)");
  const end = RENDER_SHELL_HTML.indexOf("function retireCard(frame)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

/** Slice retireCard (card_done routing) through freezeDraftCard's end. */
function retireSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function retireCard(frame)");
  const end = RENDER_SHELL_HTML.indexOf("// --- event-cards (04)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

/** Slice ONLY the freezeDraftCard body (the draft card_done path). */
function freezeSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function freezeDraftCard(art, form, ts)");
  const end = RENDER_SHELL_HTML.indexOf("// --- event-cards (04)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("RENDER_SHELL_HTML — draft cards render (cards-ux2 02)", () => {
  it("blocking === false renders a DRAFT form: draft badge + Send button + the SAME field builder", () => {
    const src = cardFormSrc();
    // draft detection is frame-driven (absent/true stays MODAL — default preserved)
    expect(src).toContain("const draft = frame.blocking === false;");
    expect(src).toContain("form.setAttribute('data-draft', '1')"); // retireCard's freeze probe
    // the draft badge: a small span, textContent only
    expect(src).toContain("draftBadge.className = 'badge card-draft-badge'");
    expect(src).toContain("draftBadge.textContent = 'draft'");
    // the submit button is labeled Send for drafts (modal keeps 'Submit')
    expect(src).toContain("if (draft) btn.textContent = 'Send';");
    expect(src).toContain("btn.textContent = 'Submit';");
    // SAME field builder as the modal form — the draft branch only swaps the
    // envelope, never the field rendering (question/label/input/select ride
    // the shared loop above)
    expect(src).toContain("form.setAttribute('data-card-id', cardId)");
    expect(src).toContain("q.textContent = b.question");
  });

  it("draft submit builds card_send (NOT card_answer) — the modal envelope is unreachable for drafts", () => {
    const src = cardFormSrc();
    // the draft branch posts the card_send envelope and RETURNS — it never
    // falls through to the ask/card_answer sends below it
    expect(src).toContain(
      "if (draft) {\n      sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_send', cardId: cardId, answers: answers } }));\n      return false;\n    }",
    );
    // ordering proof: the card_send literal precedes the card_answer literal,
    // and the draft branch short-circuits between them
    expect(src.indexOf("kind: 'card_send'")).toBeGreaterThan(-1);
    expect(src.indexOf("kind: 'card_answer'")).toBeGreaterThan(src.indexOf("kind: 'card_send'"));
    // no optimistic retire on submit — card_done drives the freeze
    expect(src).not.toContain("classList.add('card-answered')");
    // pure twin: the exact envelope a DOM draft submit produces, gridded no-DOM
    expect(APPEXEC_CARD_SEND("draft-1", { note: "ship it" })).toEqual({
      type: "appexec",
      extra: { kind: "card_send", cardId: "draft-1", answers: { note: "ship it" } },
    });
    // the twin's envelope survives the wiring guard (scope A seam) verbatim
    expect(validateCardSendExtra(APPEXEC_CARD_SEND("draft-1", { note: "ship it" }).extra)).toEqual({
      kind: "card_send",
      cardId: "draft-1",
      answers: { note: "ship it" },
    });
  });
});

describe("RENDER_SHELL_HTML — card_done freezes a draft (never removes it)", () => {
  it("retireCard routes data-draft forms to freezeDraftCard with the tombstone ts", () => {
    const src = retireSrc();
    expect(src).toContain("form.getAttribute('data-draft') === '1'");
    expect(src).toContain("freezeDraftCard(art, form, frame.ts)");
  });

  it("freeze disables every input+button, stamps sent <HH:MM:SS>, keeps the article + the form", () => {
    const src = freezeSrc();
    expect(src).toContain("form.querySelectorAll('input, select, button')");
    expect(src).toContain("el.disabled = true");
    // a frozen form's stray Enter must never re-send
    expect(src).toContain("form.onsubmit = function (ev) { ev.preventDefault(); return false; };");
    // the sent stamp renders from the tombstone ts via the clock formatter
    expect(src).toContain("mark.textContent = 'sent ' + fmtClock(");
    expect(RENDER_SHELL_HTML).toContain("function fmtClock(ms)");
    // FROZEN, not removed: the form stays in place (marker rides below it)
    expect(src).toContain("form.after(done)");
    expect(src).not.toContain("form.replaceWith");
    expect(src).not.toContain("art.remove");
    expect(src).toContain("art.classList.add('card-answered', 'card-sent')");
    // t01 collapsed-review semantics ride below: click toggles the stashed rows
    expect(src).toContain("head.onclick = function () { detail.hidden = !detail.hidden; };");
    expect(src).toContain("art.cardAnswers"); // live submit-time stash (replay degrades to the stamp)
  });

  it("the freeze path builds NO markup — createElement/textContent only", () => {
    const src = freezeSrc();
    for (const sink of ["innerHTML", "insertAdjacentHTML", "outerHTML", "document.write", "createContextualFragment"]) {
      expect(src).not.toContain(sink);
    }
  });
});

describe("RENDER_SHELL_HTML — replay + modal parity (cards-ux2 02)", () => {
  it("replay: [card(blocking:false), card_done] replays frozen; the card alone replays draft", () => {
    // the snapshot replays through the SAME txApply arms in transcript order
    // — card before card_done — so a blocking:false card re-renders its draft
    // form (frame-driven detection) and the following tombstone freezes it;
    // without the tombstone the draft form simply stays live.
    expect(RENDER_SHELL_HTML).toContain("case 'card': renderCard(frame); break;");
    expect(RENDER_SHELL_HTML).toContain("case 'card_done': retireCard(frame); break;");
    const cardAt = RENDER_SHELL_HTML.indexOf("case 'card': renderCard(frame); break;");
    const doneAt = RENDER_SHELL_HTML.indexOf("case 'card_done': retireCard(frame); break;");
    expect(doneAt).toBeGreaterThan(cardAt); // [card, card_done] replay order
    expect(RENDER_SHELL_HTML).toContain("cardsPaneEl.textContent = ''"); // fresh authoritative replay
    expect(RENDER_SHELL_HTML).toContain("state.transcript.forEach(txApply)");
  });

  it("MODAL cards keep the t01 retire: card_done still swaps the form for the collapsed review", () => {
    const src = retireSrc();
    expect(src).toContain("form.replaceWith(done)"); // modal retire — form REMOVED (drafts freeze instead)
    expect(src).toContain("mark.textContent = 'answered'");
  });

  it("markup sinks stay bounded: innerHTML occurrences across the shell never exceed 8", () => {
    expect(RENDER_SHELL_HTML.split("innerHTML").length - 1).toBeLessThanOrEqual(8);
  });
});
