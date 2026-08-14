/**
 * render-service.ts — the in-memory view registry for the generic render
 * framework (specs/06 D1).
 *
 * Pure: no I/O, no `bun`, no `pi`. Holds a Map of named views; `render()`
 * replaces (never appends — v1 is replace-only), advances `updatedAt`, and
 * notifies subscribers. The registry does NOT know the server port: it accepts a
 * `urlFor(viewId)` callback so the caller (T8 wiring) can compose the real URL
 * from `server.url` at render time.
 */
export type RenderMode = "md" | "html";

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
  content: string;
  title?: string;
  /** Present-as-view (spec Decision A): declarative HITL controls, when this view is a presentation. */
  controls?: Control[];
  /** The pending-presentation id this view answers to (the appexec respond id). */
  presentId?: string;
  updatedAt: number;
}

export interface RenderInput {
  content: string;
  mode?: RenderMode;
  view?: string;
  title?: string;
  controls?: Control[];
  presentId?: string;
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
