/**
 * deck-event-handler.ts — the `webui:deck` event seam (effort
 * archify-view-pptx-bun, ticket 07).
 *
 * The multi-diagram sibling of `webui:open`. Any extension may emit
 * `webui:deck` with `{deckId, title?, slides:[{path, title?, subtitle?}]}` on
 * the shared `pi.events` bus — the same string-literal channel contract: webui
 * imports nothing from the producer and the producer imports nothing from
 * webui, so an absent webui makes every emission a no-op.
 *
 * Every slide path is validated through `locateFileInRoots` — the SAME
 * containment core the `/files` route and `webui:open` already share, so the
 * route and the two events can never disagree about what is servable.
 *
 * ## Two deliberate differences from `webui:open`
 *
 * 1. **A partially-servable deck is kept, not dropped.** Slides outside the
 *    roots are skipped and the rest still render; a deck is a collection, and
 *    losing all of it because one path was misconfigured is worse than losing
 *    the one. An emission whose slides are ALL unservable is ignored entirely.
 * 2. **No `ui.notify`.** `webui:open` announces a URL the TUI user can click.
 *    A deck's value is the in-shell pane, and belling once per deck build would
 *    be noise on top of the per-render open announcements.
 *
 * Robustness rule (shared with every bus handler here): it NEVER throws. A
 * malformed or hostile payload from a bad emitter must not take down the host.
 */
import * as path from "node:path";
import { locateFileInRoots } from "./file-routes.js";

/** The `webui:deck` payload. */
export interface DeckEventSlide {
  /** Absolute (or cwd-relative) path to the rendered artifact. */
  path: string;
  title?: string;
  subtitle?: string;
}

export interface DeckEventPayload {
  /** Stable identity — a re-emitted deck REPLACES rather than duplicates. */
  deckId: string;
  title?: string;
  slides: DeckEventSlide[];
}

/** A slide resolved to a servable `/files` URL. */
export interface ResolvedDeckSlide {
  url: string;
  title?: string;
  subtitle?: string;
}

/** The outbound frame (protocol.ts `WebFrame` member). Replay-eligible. */
export interface DiagramDeckFrame {
  type: "diagram_deck";
  deckId: string;
  title?: string;
  slides: ResolvedDeckSlide[];
  ts: number;
}

export interface DeckHandlerOptions {
  /** Base URL for the /files route (no trailing slash), read lazily. */
  getUrl(): string;
  /** Live broadcast — wiring passes the STORE-WRAPPED broadcaster. */
  broadcast(frame: DiagramDeckFrame): void;
  /** Injectable clock so tests are deterministic. */
  now?(): number;
}

function ignore(reason: string, data: unknown): void {
  console.log(`[webui] webui:deck ignored (${reason}):`, data);
}

/** Percent-encode a relative path per segment (the open-handler precedent). */
function relToUrl(rel: string): string {
  return rel.split(path.sep).join("/").split("/").map(encodeURIComponent).join("/");
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Resolve a payload's slides against the root allowlist. Exported for tests and
 * for any future producer that wants the same resolution without the bus.
 */
export function resolveDeckSlides(
  roots: string[],
  slides: DeckEventSlide[],
  baseUrl: string
): ResolvedDeckSlide[] {
  const out: ResolvedDeckSlide[] = [];
  for (const slide of slides) {
    if (typeof slide?.path !== "string" || slide.path === "") continue;
    const loc = locateFileInRoots(roots, slide.path);
    if (loc === null) continue; // outside the roots (includes the fail-closed empty case)
    const title = optionalString(slide.title);
    const subtitle = optionalString(slide.subtitle);
    out.push({
      url: `${baseUrl}/files/${loc.rootIdx}/${relToUrl(loc.rel)}`,
      ...(title !== undefined ? { title } : {}),
      ...(subtitle !== undefined ? { subtitle } : {}),
    });
  }
  return out;
}

/** Build the `webui:deck` handler. */
export function createDeckEventHandler(
  roots: string[],
  opts: DeckHandlerOptions
): (data: unknown) => void {
  const now = opts.now ?? (() => Date.now());
  return (data: unknown): void => {
    try {
      if (typeof data !== "object" || data === null) {
        ignore("payload is not an object", data);
        return;
      }
      const payload = data as Partial<DeckEventPayload>;
      if (typeof payload.deckId !== "string" || payload.deckId === "") {
        ignore("missing or non-string deckId", data);
        return;
      }
      if (!Array.isArray(payload.slides) || payload.slides.length === 0) {
        ignore("missing or empty slides", data);
        return;
      }
      const resolved = resolveDeckSlides(roots, payload.slides, opts.getUrl());
      if (resolved.length === 0) {
        ignore("no slide path is inside the configured file roots", payload.deckId);
        return;
      }
      const title = optionalString(payload.title);
      opts.broadcast({
        type: "diagram_deck",
        deckId: payload.deckId,
        ...(title !== undefined ? { title } : {}),
        slides: resolved,
        ts: now(),
      });
    } catch (e) {
      // Bus robustness: a bad emitter (or a throwing getUrl/broadcast) must
      // never escape into the host's event dispatch.
      console.log("[webui] webui:deck handler error (ignored):", e);
    }
  };
}
