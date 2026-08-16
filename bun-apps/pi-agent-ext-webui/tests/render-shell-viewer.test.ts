import { describe, expect, it } from "bun:test";
import { CARD_BRIDGE_SHIM, RENDER_SHELL_HTML } from "../src/render-shell.js";

/**
 * event-cards (04): viewer sandbox + webui.emit bridge + confirm gate —
 * SIMPLIFIED per user directive (no origin allowlist, no CSP additions, no
 * anti-spoof tests). Same no-DOM convention as render-shell-cards.test.ts:
 * pure string-contains checks over RENDER_SHELL_HTML slices (the package test
 * env has no DOM) + the pure CARD_BRIDGE_SHIM twin gridded exactly.
 */

/** Slice the in-string viewer-frame source (appendViewerFrame -> the shim). */
function viewerFrameSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function appendViewerFrame(art, frame)");
  const end = RENDER_SHELL_HTML.indexOf("function cardBridgeShimInline(cardId)");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

/** Slice the in-string confirm-gate source (showConfirmCard -> deep link). */
function confirmCardSrc(): string {
  const start = RENDER_SHELL_HTML.indexOf("function showConfirmCard(fromId, payload)");
  const end = RENDER_SHELL_HTML.indexOf("// --- event-cards (03): #card-<id> deep link");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return RENDER_SHELL_HTML.slice(start, end);
}

describe("RENDER_SHELL_HTML — viewer sandbox frames (event-cards 04, simplified)", () => {
  it("renders viewer cards as sandbox=\"allow-scripts\" iframes — NEVER allow-same-origin", () => {
    const src = viewerFrameSrc();
    expect(src).toContain("document.createElement('iframe')");
    expect(src).toContain("f.setAttribute('sandbox', 'allow-scripts')");
    expect(src).toContain("f.className = 'card-viewer'");
    // srcdoc rides the DOM property (shim + body html), never attribute interpolation
    expect(src).toContain("f.srcdoc = cardBridgeShimInline(rawId) + html;");
    expect(src).toContain("typeof b.html === 'string' ? b.html : ''");
    // renderCard only appends the frame for the viewer kind
    expect(RENDER_SHELL_HTML).toContain("if (kind === 'viewer') appendViewerFrame(art, frame)");
    // the whole shell never grants allow-same-origin to a viewer frame
    expect(RENDER_SHELL_HTML).not.toContain('allow-same-origin"');
  });

  it("injects the bridge shim into every viewer srcdoc: window.webui.emit -> postMessage", () => {
    const src = viewerFrameSrc();
    expect(src).toContain("cardBridgeShimInline(rawId) + html"); // shim LEADS the srcdoc
    const shimAt = RENDER_SHELL_HTML.indexOf("function cardBridgeShimInline(cardId)");
    expect(shimAt).toBeGreaterThan(-1);
    const shimSlice = RENDER_SHELL_HTML.slice(shimAt, shimAt + 700);
    expect(shimSlice).toContain("window.webui = { emit:");
    expect(shimSlice).toContain("parent.postMessage({ __webuiCard:");
    // the card id is JSON-stringified with '<' escaped (no script-tag breakout)
    expect(shimSlice).toContain("JSON.stringify(String(cardId == null ? '' : cardId)).replace(/</g");
  });

  it("pure twin CARD_BRIDGE_SHIM: exact shim source, id-escaped (grid, no DOM)", () => {
    expect(CARD_BRIDGE_SHIM("card-1")).toBe(
      '<script>window.webui = { emit: function (payload) { parent.postMessage({ __webuiCard: "card-1", payload: payload }, "*"); } };</script>',
    );
    // a hostile id with </script> cannot close the shim's script tag early
    const hostile = CARD_BRIDGE_SHIM('"</script><img src=x onerror=alert(1)>"');
    expect(hostile).not.toMatch(/<\/script><img/);
    expect(hostile.includes("\\u003c")).toBe(true); // '<' escaped inside the id literal
  });

  it("confirm gate: host message listener -> local confirm card, payload as TEXT only", () => {
    // ONE global message listener in the boot IIFE (try/caught — never break boot)
    expect(RENDER_SHELL_HTML).toContain("window.addEventListener('message', function (ev)");
    expect(RENDER_SHELL_HTML).toContain("typeof d.__webuiCard !== 'string'");
    expect(RENDER_SHELL_HTML).toContain("showConfirmCard(d.__webuiCard, d.payload)");
    const src = confirmCardSrc();
    // the confirm card is article#card-confirm-<n> with a LOCAL counter id
    expect(RENDER_SHELL_HTML).toContain("var confirmSeq = 0;");
    expect(src).toContain("confirmSeq++;");
    expect(src).toContain("art.id = 'card-confirm-' + n");
    // payload shown as TEXT in a <pre> (JSON.stringify, textContent) — never markup
    expect(src).toContain("var pre = document.createElement('pre');");
    expect(src).toContain("pre.textContent = shown;");
    expect(src).toContain("h.textContent = 'Confirm viewer emit'");
    // buttons are createElement + textContent
    expect(src).toContain("approve.textContent = 'Approve'");
    expect(src).toContain("deny.textContent = 'Deny'");
    // the gate is visible (attention input)
    expect(src).toContain("toggleCardsTab(true)");
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

  it("Approve rides the t02 card_answer envelope (sendRaw); Deny removes the article", () => {
    const src = confirmCardSrc();
    // Approve: extra { kind:'card_answer', cardId:'confirm-<n>', answers:{ emit: <payload JSON> } }
    expect(src).toContain(
      "sendRaw(JSON.stringify({ type: 'appexec', extra: { kind: 'card_answer', cardId: 'confirm-' + n, answers: { emit: shown } } }));",
    );
    // answered marker mirrors the card_done style (the inbound tombstone rides retireCard)
    expect(src).toContain("art.classList.add('card-answered')");
    expect(src).toContain("approve.disabled = true");
    // Deny: the article is removed, NOTHING is sent
    expect(src).toContain("deny.onclick = function () { art.remove(); }");
  });
});
