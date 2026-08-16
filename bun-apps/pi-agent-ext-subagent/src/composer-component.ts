import { type Component, Text } from "@earendil-works/pi-tui";

/**
 * Deferred compose-in-render component (ticket 02, effort
 * 2026-08-15-subagent-tui-display).
 *
 * Wraps a composer closure `(width: number) => string` and composes the
 * content INSIDE `render(width)`: the render-time terminal width reaches the
 * width-aware pure render helpers (ticket 01), so resize re-flow comes for
 * free from the Component.render(width) contract — the host screen re-reads
 * terminal columns every frame; no manual resize subscription and no
 * stdout-columns polling.
 *
 * The composed string is delegated to a fresh `Text(...).render(width)` —
 * Text's word-wrap acts as a backstop (our strings are already
 * column-truncated by the ticket-01 helpers, so the wrap normally passes
 * through unchanged).
 *
 * `setComposer` mirrors the old `Text.setText` reuse pattern: the mounting
 * sites reuse `context.lastComponent` across renders when it is already a
 * ComposerComponent, swapping only the closure instead of forcing a new
 * component.
 */
export type Composer = (width: number) => string;

export class ComposerComponent implements Component {
  private composer: Composer;

  constructor(composer: Composer) {
    this.composer = composer;
  }

  /** Swap the composer closure (incremental update; no new component forced). */
  setComposer(composer: Composer): void {
    this.composer = composer;
  }

  render(width: number): string[] {
    let text: string;
    try {
      text = this.composer(width);
    } catch (error) {
      // Systemic barrier (hotfix): the TUI frame loop has no exception
      // barrier of its own — a composer throw at render time surfaced as an
      // uncaughtException and killed the whole host session. Degrade to a
      // single error line instead; render-time failures must never crash the
      // host TUI.
      const message = (error as Error | undefined)?.message;
      text = String(message ?? error ?? "render error");
    }
    return new Text(text, 0, 0).render(width);
  }

  /** Composing is pure — there is no cached rendering state to invalidate. */
  invalidate(): void {}
}
