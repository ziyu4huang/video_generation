/**
 * render-event-handler.ts — the extension-producer entry point (specs/06 D2).
 *
 * `createRenderEventHandler(registry)` returns the handler registered as
 * `pi.events.on("webui:render", handler)` by wireWebui (T8). Any extension
 * emits `pi.events.emit("webui:render", { content, mode?, view?, title?, images? })`;
 * this validates the payload and dispatches it into the registry. Invalid
 * payloads are ignored (never throw — the shared event bus must stay robust).
 *
 * v2 (architecture v2 §3.6, render-review F3): the optional `images` field
 * wires the previously-dead image-presentation helpers into a producer — an
 * extension that just finished a tool call (flux2/ltx/movie-director) passes
 * the output paths (absolute, or relative to cwd) and the handler appends the
 * `![image](/output/0/<rel>)` markdown to the content automatically. The
 * `toImageMarkdown` converter is INJECTED by the wiring (bound to the resolved
 * output dir via imageMd/resolveOutputDir) so this module stays pure.
 */
import type { RenderMode, RenderService } from "./render-service.js";

export interface RenderEventPayload {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
  /** Output paths to append as ![image](/output/0/...) markdown (v2, F3). */
  images?: string[];
}

export type RenderEventHandler = (data: unknown) => void;

/** Options for {@link createRenderEventHandler}. */
export interface RenderEventHandlerOptions {
  /**
   * Convert output paths into the markdown block appended to the content.
   * Default: no-op ("" — images unsupported). The wiring injects a converter
   * bound to the resolved output dir via imageMd/resolveOutputDir.
   */
  toImageMarkdown?: (paths: string[]) => string;
}

function isPayload(d: unknown): d is RenderEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return typeof o.content === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function createRenderEventHandler(
  registry: RenderService,
  opts: RenderEventHandlerOptions = {}
): RenderEventHandler {
  const toImageMarkdown = opts.toImageMarkdown ?? (() => "");
  return (data) => {
    if (!isPayload(data)) return;
    const images = isStringArray(data.images) ? data.images : undefined;
    const imageBlock = images && images.length > 0 ? toImageMarkdown(images) : "";
    const content = imageBlock ? `${data.content}\n\n${imageBlock}` : data.content;
    registry.render({
      content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(typeof data.view === "string" ? { view: data.view } : {}),
      ...(typeof data.title === "string" ? { title: data.title } : {}),
    });
  };
}
