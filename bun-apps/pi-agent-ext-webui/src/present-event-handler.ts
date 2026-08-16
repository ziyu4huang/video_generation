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
 *
 * Ticket 02 (spec §C2) — EVENT-ORIGINATED presentations: an id-less payload
 * (archify's fire-and-forget announce; `content` is optional for it too, the
 * file itself is announced on the sibling webui:open channel) gets a MINTED
 * present id and is reported through the optional `onEventPresent` dep so the
 * wiring can route browser answers to an injected user turn instead of a
 * blocking tool result. The dep is OPTIONAL: without it the view is still
 * minted (a browser can look at it) but answers find no registration and are
 * ignored — inert, never a throw.
 */
import type { Control, RenderMode, RenderService } from "./render-service.js";

export interface PresentEventPayload {
  /** View body. Optional for event-originated (id-less) announcements — the
   *  rendered artifact lives on the sibling webui:open view (ticket 02). */
  content?: string;
  controls: Control[];
  /** The pending-presentation id (the appexec respond id). Optional inbound. */
  id?: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
  /** Output paths appended as ![image](/output/0/...) markdown (v2, F3). */
  images?: string[];
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPayload(d: unknown): d is PresentEventPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  // Ticket 02: `content` is optional inbound (event-originated announcements
  // carry path/view/title via webui:open and need no inline body) but must
  // still be a string when present.
  if (o.content !== undefined && typeof o.content !== "string") return false;
  if (!Array.isArray(o.controls) || !o.controls.every(isControl)) return false;
  if (o.id !== undefined && typeof o.id !== "string") return false;
  if (o.view !== undefined && typeof o.view !== "string") return false;
  return true;
}

/** Registration info for an event-originated (id-less) presentation. */
export interface EventPresentInfo {
  /** The present id the handler minted (the appexec respond id). */
  id: string;
  /** Presentation title, when the payload carried one (message formatting). */
  title?: string;
}

/**
 * Exact user-turn text for an EVENT-originated presentation answer (spec §C2):
 * `[webui:present] "<title>": approved` / `[webui:present] "<title>": tweak: "<text>"`.
 * A non-approve control without input falls back to the bare action id. Pure —
 * the wiring pairs it with the host sendUserMessage seam.
 */
export function presentAnswerToUserTurn(
  title: string | undefined,
  r: { action: string; tweak?: string }
): string {
  const t = title ?? "presentation";
  if (r.tweak !== undefined) return `[webui:present] "${t}": tweak: "${r.tweak}"`;
  if (r.action === "approve") return `[webui:present] "${t}": approved`;
  return `[webui:present] "${t}": ${r.action}`;
}

/** Options for {@link createPresentEventHandler} (v2, F3). */
export interface PresentEventHandlerOptions {
  /** Convert output paths into the markdown block appended to the content.
   *  Default no-op (""); the wiring injects the imageMd-bound converter. */
  toImageMarkdown?: (paths: string[]) => string;
  /** Event-originated (id-less) presentation registration (ticket 02, spec
   *  §C2). The wiring records {id, title} so an appexec respond for the id can
   *  be routed to an injected user turn. Absent → the view is still minted;
   *  answers are ignored (inert — nobody blocks on an event presentation). */
  onEventPresent?: (info: EventPresentInfo) => void;
}

/** Module-level sequence so minted event-present ids are unique in-process. */
let eventPresentSeq = 0;
function nextEventPresentId(): string {
  eventPresentSeq += 1;
  return `present_${Date.now()}_e${eventPresentSeq}`;
}

export function createPresentEventHandler(
  registry: RenderService,
  opts: PresentEventHandlerOptions = {}
): PresentEventHandler {
  const toImageMarkdown = opts.toImageMarkdown ?? (() => "");
  return (data) => {
    if (!isPayload(data)) return;
    const images = isStringArray(data.images) ? data.images : undefined;
    const imageBlock = images && images.length > 0 ? toImageMarkdown(images) : "";
    const base = data.content ?? "";
    const content = imageBlock ? `${base}\n\n${imageBlock}` : base;
    const title = typeof data.title === "string" ? data.title : undefined;
    if (data.id !== undefined) {
      // Tool-originated: the webui_present tool owns the id + the blocking
      // pending registry — just mint the view it pointed at.
      registry.render({
        view: data.view ?? "present",
        content,
        ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
        ...(title !== undefined ? { title } : {}),
        controls: data.controls,
        presentId: data.id,
      });
      return;
    }
    // Event-originated (ticket 02, spec §C2): mint the id, mint the view, and
    // report the registration — answers route to a user turn in the wiring.
    const id = nextEventPresentId();
    registry.render({
      view: data.view ?? "present",
      content,
      ...(data.mode === "md" || data.mode === "html" ? { mode: data.mode } : {}),
      ...(title !== undefined ? { title } : {}),
      controls: data.controls,
      presentId: id,
    });
    try {
      opts.onEventPresent?.({ id, ...(title !== undefined ? { title } : {}) });
    } catch {
      /* a registration callback must never break the event handler */
    }
  };
}
