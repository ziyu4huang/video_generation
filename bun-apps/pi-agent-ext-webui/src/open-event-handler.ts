/**
 * open-event-handler.ts — the `webui:open` event seam (spec §4.2,
 * archify-webui-html ticket 06).
 *
 * Any extension may emit `webui:open` with `{ path, view?, title? }` on the
 * shared pi.events bus (string-literal channel contract — archify emits
 * post-render; webui does NOT own emitters, imports nothing from them, and
 * they import nothing from webui). The handler validates `path` against the
 * SAME configured root allowlist + containment core the /files route serves
 * (locateFileInRoots — shared on purpose so route and event can never
 * disagree about what is servable), then announces a clickable URL in the TUI
 * via `ui.notify`. NO shell tab / view creation (decision 01-A: the URL opens
 * a TOP-LEVEL browser document); `view`/`title` are notify-label +
 * forward-compat payload fields only (ticket 04).
 *
 * Robustness rule (pi.events bus): the handler NEVER throws — a malformed or
 * hostile payload from a bad emitter must not take down the host. Every
 * ignore path (non-object payload, non-string path, outside-roots path —
 * including the empty-roots fail-closed case) logs a debug line and returns;
 * the whole body is additionally try/catch-wrapped so even a throwing
 * getUrl/notify cannot escape into the bus dispatch.
 */
import * as path from "node:path";
import { locateFileInRoots } from "./file-routes.js";

/** The `webui:open` payload (spec §4.2). */
export interface OpenEventPayload {
  /** Absolute (or cwd-relative) path to the file to announce. */
  path: string;
  /** Optional view label (IR output basename sans extension). Forward-compat. */
  view?: string;
  /** Optional display title; the notify label falls back to `path` without it. */
  title?: string;
}

/**
 * Injectable surface the handler needs (wiring passes closures so no server
 * handle is captured at wiring time): `getUrl` reads the LIVE server.url
 * lazily (the server starts at session_start, after wireWebui returns) and
 * `notify` reaches the BOUND session's ctx.ui (null before session_start).
 */
export interface OpenHandlerOptions {
  /** Base URL for the /files route (no trailing slash). */
  getUrl(): string;
  /** Announce channel (the TUI ui.notify surface). */
  notify(message: string): void;
}

/** Debug-log an ignored emission (never throws, never notifies). */
function ignore(reason: string, data: unknown): void {
  console.log(`[webui] webui:open ignored (${reason}):`, data);
}

/**
 * Build the `webui:open` handler. Validates the payload shape, resolves
 * `path` against `roots` via the shared containment core, and announces
 * `${title ?? path} — open ${url}` where
 * `url = ${getUrl()}/files/${rootIdx}/${rel}` with `rel` percent-encoded per
 * segment so weird filenames (spaces, '#') round-trip through the route
 * (spec §4.2 formula).
 */
export function createOpenEventHandler(
  roots: string[],
  opts: OpenHandlerOptions
): (data: unknown) => void {
  return (data: unknown): void => {
    try {
      if (typeof data !== "object" || data === null) {
        ignore("payload is not an object", data);
        return;
      }
      const payload = data as Partial<OpenEventPayload>;
      if (typeof payload.path !== "string" || payload.path === "") {
        ignore("missing or non-string path", data);
        return;
      }
      const loc = locateFileInRoots(roots, payload.path);
      if (loc === null) {
        // Includes the empty-roots (fail closed) case: nothing is locatable.
        ignore("path outside the configured file roots", payload.path);
        return;
      }
      // Percent-encode PER SEGMENT (image-presentation.ts §3.6 precedent): a
      // filename with spaces or '#'/'?' must survive the TUI click AND the
      // route's decodeURIComponent — raw '#' would truncate at the fragment,
      // raw spaces break some terminals/clients. The route round-trips it.
      const relUrl = loc.rel
        .split(path.sep)
        .join("/")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const url = `${opts.getUrl()}/files/${loc.rootIdx}/${relUrl}`;
      const label =
        typeof payload.title === "string" && payload.title !== ""
          ? payload.title
          : payload.path;
      opts.notify(`${label} — open ${url}`);
    } catch (e) {
      // Bus robustness rule: NEVER let a bad emitter (or a throwing
      // getUrl/notify) take down the host.
      console.log("[webui] webui:open handler error (ignored):", e);
    }
  };
}
