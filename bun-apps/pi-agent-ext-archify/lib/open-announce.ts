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
