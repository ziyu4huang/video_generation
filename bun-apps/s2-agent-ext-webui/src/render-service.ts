/**
 * render-service.ts — the in-memory view registry for the generic render
 * framework (specs/06 D1).
 *
 * Pure: no I/O, no `bun`, no `pi`. Holds a Map of named views; `render()`
 * replaces (never appends — v1 is replace-only), advances `updatedAt`, and
 * notifies subscribers. The registry does NOT know the server port: it accepts a
 * `urlFor(viewId)` callback so the caller (T8 wiring) can compose the real URL
 * from `server.url` at render time.
 *
 * view-notifications (spec 02-A): `mode:"url"` is a third view kind — a URL
 * POINTER into the /files tree (`content` is not required for it); `openUrl()`
 * registers/re-opens one with id stability (`url:<view>` / `url:<url>`), so a
 * re-open UPDATES (bumps `updatedAt`, floats the panel row), never duplicates.
 */
export type RenderMode = "md" | "html" | "url";

/**
 * A declarative HITL response control (spec #05 contract): the browser renders
 * one button per control; `takesInput` reveals a free-text tweak field next to
 * it. Lives HERE (not protocol.ts) because Control is a view-model concept that
 * rides RenderView + /api/view/:id — it never appears in a WS frame.
 */
export interface Control {
  id: string;
  label: string;
  takesInput?: boolean;
}

export interface RenderView {
  id: string;
  mode: RenderMode;
  /** View body. Absent for `mode:"url"` views (URL pointer — see `url`). */
  content?: string;
  title?: string | null;
  /** The path-absolute URL a `mode:"url"` view points at (e.g. `/files/0/a.html`). */
  url?: string;
  /** Present-as-view (spec Decision A): declarative HITL controls, when this view is a presentation. */
  controls?: Control[];
  /** The pending-presentation id this view answers to (the appexec respond id). */
  presentId?: string;
  updatedAt: number;
}

export interface RenderInput {
  /** View body; may be omitted for `mode:"url"` views. */
  content?: string;
  mode?: RenderMode;
  view?: string;
  title?: string | null;
  controls?: Control[];
  presentId?: string;
  /** URL pointer for a `mode:"url"` view. */
  url?: string;
}

/** Input for {@link RenderService.openUrl} (view-notifications spec 02-A). */
export interface UrlViewInput {
  /** View name from the `webui:open` payload, when carried. Drives the registry id. */
  view?: string;
  /** Display title, already normalized to `string | null` by the caller. */
  title?: string | null;
  /** Path-absolute /files URL (encoding authority is server-side, 01-B). */
  url: string;
}

/**
 * Registry id for a `mode:"url"` view (spec 02-A id-stability rule):
 * `url:<view>` when the payload carries a view name, else `url:<url>` — the
 * path-absolute url is itself stable per rendered file, so both forms make a
 * re-open land on the SAME id (update, never duplicate).
 */
export function urlViewId(view: string | undefined, url: string): string {
  return view ? `url:${view}` : `url:${url}`;
}

export interface RenderResult {
  viewId: string;
  url: string;
}

export type RenderListener = (viewId: string, updatedAt: number) => void;

export interface RenderServiceOptions {
  /** Compose the browser URL for a view id. Default: `(id) => "#" + id`. */
  urlFor?: (viewId: string) => string;
  /** Injectable clock (epoch ms). Default: `Date.now`. */
  now?: () => number;
}

export class RenderService {
  private readonly views = new Map<string, RenderView>();
  private readonly listeners = new Set<RenderListener>();
  private readonly urlFor: (viewId: string) => string;
  private readonly now: () => number;

  constructor(opts: RenderServiceOptions = {}) {
    this.urlFor = opts.urlFor ?? ((id) => `#${id}`);
    this.now = opts.now ?? (() => Date.now());
  }

  render(input: RenderInput): RenderResult {
    const viewId = input.view ?? "main";
    const mode = input.mode ?? "md";
    const updatedAt = this.now();
    const view: RenderView = {
      id: viewId,
      mode,
      content: input.content,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.controls !== undefined ? { controls: input.controls } : {}),
      ...(input.presentId !== undefined ? { presentId: input.presentId } : {}),
      updatedAt,
    };
    this.views.set(viewId, view);
    for (const listener of this.listeners) {
      try {
        listener(viewId, updatedAt);
      } catch {
        /* a listener must never break render() */
      }
    }
    return { viewId, url: this.urlFor(viewId) };
  }

  /**
   * Register (or re-open) a `mode:"url"` view (view-notifications spec 02-A).
   * Same id (per {@link urlViewId}) REPLACES the entry — bumps `updatedAt`,
   * refreshes `title` — never duplicates. Fire `view_update` to subscribers
   * exactly like `render()`, so tabs / SSE / panel light up for free.
   */
  openUrl(input: UrlViewInput): RenderResult {
    const viewId = urlViewId(input.view, input.url);
    this.render({
      view: viewId,
      mode: "url",
      url: input.url,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
    return { viewId, url: this.urlFor(viewId) };
  }

  listViews(): RenderView[] {
    return [...this.views.values()];
  }

  getView(id: string): RenderView | undefined {
    return this.views.get(id);
  }

  subscribe(listener: RenderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
