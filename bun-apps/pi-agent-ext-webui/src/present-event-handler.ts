/**
 * present-event-handler.ts — the `webui:present` producer entry point
 * (spec Component 3, Decision A: present-as-view).
 *
 * `createPresentEventHandler(registry)` returns the handler registered as
 * `pi.events.on("webui:present", handler)` by wireWebui. The webui_present
 * tool's `present` dep (and any extension) emits
 * `pi.events.emit("webui:present", { content, controls, id?, mode?, view?, title? })`;
 * this validates the payload and mints a render view DEFAULTING to view id
 * "present", carrying `controls` + `presentId` so the browser can render the
 * content plus a declarative button bar. `id` is optional INBOUND (a non-tool
 * emitter may omit it); the tool path always supplies it. Invalid payloads are
 * ignored (never throw — the shared event bus must stay robust), mirroring
 * render-event-handler.ts.
 */
import type { Control, RenderMode, RenderService } from "./render-service.js";

export interface PresentEventPayload {
  content: string;
  controls: Control[];
  /** The pending-presentation id (the appexec respond id). Optional inbound. */
  id?: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

export type PresentEventHandler = (data: unknown) => void;

function isControl(c: unknown): c is Control {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    (o.takesInput === undefined || typeof o.takesInput === "boolean")
  );
}

function isPayload(d: unknown): d is PresentEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  if (typeof o.content !== "string") return false;
  if (!Array.isArray(o.controls) || !o.controls.every(isControl)) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  return true;
}

export function createPresentEventHandler(registry: RenderService): PresentEventHandler {
  return (data) => {
    if (!isPayload(data)) return;
    registry.render({
      view: data.view ?? "present",
      content: data.content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(typeof data.title === "string" ? { title: data.title } : {}),
      controls: data.controls,
      ...(data.id !== undefined ? { presentId: data.id } : {}),
    });
  };
}
