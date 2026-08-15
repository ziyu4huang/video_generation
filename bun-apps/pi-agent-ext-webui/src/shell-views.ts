/**
 * shell-views.ts — pure client-side logic for the webui view notifications
 * (effort 2026-08-16 webui-view-notifications, decisions 03-B / 04-C / 02-A).
 *
 * The served shell (RENDER_SHELL_HTML in render-shell.ts) is a single inline
 * HTML string with no module / build step, so its script CANNOT import from
 * here — like APPEXEC_FRAME / BTW_MESSAGE_HTML, the inline script intentionally
 * duplicates this logic. This module is the PINNED, headless-testable twin:
 * tests grid the age-gate, toast stack rules, 24h×8 panel windowing, and the
 * dismiss overlay so the inline duplication stays honest.
 */

/** Age-gate: a view_opened frame toasts only while younger than this (spec 01-B sub-fork 2). */
export const TOAST_FRESH_MS = 10_000;

/** Toast auto-fade delay — 03-B sub-fork 1 default (6–8s band). */
export const TOAST_FADE_MS = 7_000;

/** Hover-persist resume floor — a pointer-leave just before expiry still shows a beat. */
export const TOAST_MIN_RESUME_MS = 250;

/** Simultaneous toast stack cap, oldest dropped (feedback-log cap precedent, smaller). */
export const TOAST_STACK_CAP = 3;

/** Views panel window: entries younger than 24h only (spec 04-C). */
export const VIEWS_PANEL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Views panel window: at most 8 rows (spec 04-C). */
export const VIEWS_PANEL_CAP = 8;

/** localStorage key persisting the views-panel collapse state (btw-panel-collapsed precedent). */
export const VIEWS_COLLAPSED_KEY = "webui-views-collapsed";

/** Inbound WS frame (protocol.ts WebFrame member; rides live broadcast AND replay). */
export interface ViewOpenedFrame {
  type: "view_opened";
  view?: string;
  title?: string;
  url: string;
  ts: number;
}

/** /api/views row (shape unchanged; `mode` now includes "url"). */
export interface ViewSummary {
  id: string;
  title: string | null;
  mode: string;
  updatedAt: number;
}

/** One views-panel row. `url` absent for poll-only discovery rows (open/copy disabled). */
export interface ShellViewEntry {
  id: string;
  title: string | null;
  url?: string;
  updatedAt: number;
}

/** Registry id for a mode:"url" view — the spec 02-A id-stability rule mirrored client-side. */
export function viewOpenedId(view: string | undefined, url: string): string {
  return view ? `url:${view}` : `url:${url}`;
}

/** Age-gate: toast iff `now - ts < TOAST_FRESH_MS`; stale/replayed frames update the panel only. */
export function isToastFresh(ts: number, now: number): boolean {
  return now - ts < TOAST_FRESH_MS;
}

/** Hover-persist resume: pause on pointer-over, resume the REMAINING fade on pointer-leave. */
export function toastResumeMs(deadline: number, now: number): number {
  return Math.max(TOAST_MIN_RESUME_MS, deadline - now);
}

/**
 * Toast stack rule (03-B): same-view dedupe EXTENDS (refreshes the entry at the
 * newest position instead of stacking a second); over cap drops the OLDEST.
 */
export function toastStackApply<T extends { id: string }>(stack: readonly T[], entry: T): T[] {
  const kept = stack.filter((t) => t.id !== entry.id); // dedupe-extends
  kept.push(entry);
  while (kept.length > TOAST_STACK_CAP) kept.shift(); // oldest dropped
  return kept;
}

/** 24h×8 windowing: age filter, newest-first, cap — the panel's whole ordering rule. */
export function viewsPanelWindow(entries: readonly ShellViewEntry[], now: number): ShellViewEntry[] {
  return entries
    .filter((e) => now - e.updatedAt < VIEWS_PANEL_MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt) // newest-first; a re-open floats back to the top
    .slice(0, VIEWS_PANEL_CAP);
}

/** Apply one inbound frame to the panel: re-open bumps + floats (never duplicates).
 * Windowed against `now` (wall clock), NOT the frame ts — an ancient replayed
 * frame is older than the 24h window the moment it arrives, so it never rows. */
export function viewsPanelApply(
  entries: readonly ShellViewEntry[],
  frame: ViewOpenedFrame,
  now: number,
): ShellViewEntry[] {
  const id = viewOpenedId(frame.view, frame.url);
  const rest = entries.filter((e) => e.id !== id);
  const next: ShellViewEntry = { id, title: frame.title ?? null, url: frame.url, updatedAt: frame.ts };
  return viewsPanelWindow([next, ...rest], now);
}

/** Rows actually shown: the window minus the client-side dismiss overlay. */
export function viewsPanelVisible(
  entries: readonly ShellViewEntry[],
  dismissed: readonly string[],
  now: number,
): ShellViewEntry[] {
  const hidden = new Set(dismissed);
  return viewsPanelWindow(entries, now).filter((e) => !hidden.has(e.id));
}

/** Dismiss overlay: client-side-only hide; the server list is untouched. */
export function dismissApply(dismissed: readonly string[], id: string): string[] {
  const set = new Set(dismissed);
  set.add(id);
  return [...set];
}

/**
 * /api/views poll backstop merge: url-mode summaries update known rows (title
 * bump, updatedAt bump — never inventing a url; the url travels ONLY in
 * view_opened frames) and add poll-only rows WITHOUT a url, which render
 * title-only with open/copy disabled until a frame for them arrives.
 */
export function mergePolledViews(
  entries: readonly ShellViewEntry[],
  summaries: readonly ViewSummary[],
  now: number,
): ShellViewEntry[] {
  const byId = new Map<string, ShellViewEntry>(entries.map((e) => [e.id, { ...e }]));
  for (const s of summaries) {
    if (!s || s.mode !== "url") continue; // only url views belong to this panel
    const existing = byId.get(s.id);
    if (existing) {
      if (s.title) existing.title = s.title;
      if (typeof s.updatedAt === "number" && s.updatedAt > existing.updatedAt) {
        existing.updatedAt = s.updatedAt;
      }
    } else {
      byId.set(s.id, {
        id: s.id,
        title: s.title ?? null,
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        // no url — poll-only discovery
      });
    }
  }
  return viewsPanelWindow([...byId.values()], now);
}
