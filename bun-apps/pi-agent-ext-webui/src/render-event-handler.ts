/**
 * render-event-handler.ts — the extension-producer entry point (specs/06 D2).
 *
 * `createRenderEventHandler(registry)` returns the handler registered as
 * `pi.events.on("webui:render", handler)` by wireWebui (T8). Any extension
 * emits `pi.events.emit("webui:render", { content, mode?, view?, title? })`;
 * this validates the payload and dispatches it into the registry. Invalid
 * payloads are ignored (never throw — the shared event bus must stay robust).
 */
import type { RenderMode, RenderService } from "./render-service.js";

export interface RenderEventPayload {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
}

export type RenderEventHandler = (data: unknown) => void;

function isPayload(d: unknown): d is RenderEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return typeof o.content === "string";
}

export function createRenderEventHandler(registry: RenderService): RenderEventHandler {
  return (data) => {
    if (!isPayload(data)) return;
    registry.render({
      content: data.content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(typeof data.view === "string" ? { view: data.view } : {}),
      ...(typeof data.title === "string" ? { title: data.title } : {}),
    });
  };
}
