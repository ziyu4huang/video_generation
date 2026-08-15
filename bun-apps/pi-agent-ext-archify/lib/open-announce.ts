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
  try { events?.emit?.("webui:open", openAnnounceFor(kind, outPath, ir)); } catch { /* bus robustness */ }
}
