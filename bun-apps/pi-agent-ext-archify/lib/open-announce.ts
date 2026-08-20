import * as path from "node:path";

/** Structural slice of the SDK EventBus — permissive on purpose (older hosts). */
export type OpenBus = { emit?: (channel: string, payload: unknown) => void };

export type OpenAnnounceKind = "render" | "delta";

export interface OpenAnnounceIr { meta?: { title?: string }; diagram_type?: string }

/** Build the webui:open payload for a successful archify render/delta. Pure + side-effect free. */
export function openAnnounceFor(kind: OpenAnnounceKind, outPath: string, ir?: OpenAnnounceIr): { path: string; view: string; title: string } {
  const base = path.basename(outPath).replace(/\.html$/i, "");
  return {
    path: path.resolve(outPath),
    view: kind === "delta" ? `compare-${base}` : base,
    title: ir?.meta?.title ?? ir?.diagram_type ?? "archify",
  };
}

/** Fire-and-forget emit on the optional host bus; a throwing bus never breaks the tool result. */
export function announceOpen(events: OpenBus | undefined, kind: OpenAnnounceKind, outPath: string, ir?: OpenAnnounceIr): void {
  try {
    const open = openAnnounceFor(kind, outPath, ir);
    events?.emit?.("webui:open", open);
    // HITL presentation (2026-08-16-webui-present-adoption §C2): fire-and-forget —
    // webui-optional, same inert guard as webui:open. Approve / free-text Tweak.
    events?.emit?.("webui:present", {
      path: open.path,
      view: open.view,
      title: open.title,
      controls: [
        { id: "approve", label: "Approve" },
        { id: "tweak", label: "Regenerate…", takesInput: true },
      ],
    });
  } catch { /* bus robustness */ }
}

// ── deck announce (archify-view-pptx-bun, ticket 09) ────────────────────────

export interface DeckAnnounceSlide {
  /** Absolute path to the rendered slide HTML. */
  path: string;
  title: string;
  subtitle?: string;
  /** Absolute path to a generated thumbnail, when one exists. */
  thumb?: string;
}

export interface DeckAnnouncePayload {
  deckId: string;
  title: string;
  slides: DeckAnnounceSlide[];
}

/**
 * Build the `webui:deck` payload for a completed deck build. Pure.
 *
 * `deckId` is the .pptx basename without its extension, so re-exporting the
 * same deck REPLACES its pane entry instead of stacking a duplicate — the same
 * identity rule `webui:open` uses for single views.
 */
export function deckAnnounceFor(
  outputPath: string,
  slides: DeckAnnounceSlide[],
  title?: string
): DeckAnnouncePayload {
  const deckId = path.basename(outputPath).replace(/\.pptx$/i, "");
  return {
    deckId,
    title: title ?? deckId,
    slides: slides.map((s) => ({
      path: path.resolve(s.path),
      title: s.title,
      ...(s.subtitle !== undefined ? { subtitle: s.subtitle } : {}),
      ...(s.thumb !== undefined ? { thumb: path.resolve(s.thumb) } : {}),
    })),
  };
}

/**
 * Fire-and-forget `webui:deck` emit. Webui-optional exactly like
 * `announceOpen`: no bus (or a throwing one) is a silent no-op and the deck
 * build's own result is unaffected.
 */
export function announceDeck(
  events: OpenBus | undefined,
  outputPath: string,
  slides: DeckAnnounceSlide[],
  title?: string
): void {
  try {
    if (slides.length === 0) return;
    events?.emit?.("webui:deck", deckAnnounceFor(outputPath, slides, title));
  } catch { /* bus robustness */ }
}
