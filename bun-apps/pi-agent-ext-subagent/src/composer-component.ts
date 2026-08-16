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

/**
 * The one degradation message for a render-time throw. Kept unthemed on
 * purpose: theming is itself a render-time call and must not be able to throw
 * inside the barrier that exists to catch throws.
 */
export function renderErrorLine(error: unknown): string {
  const message = (error as Error | undefined)?.message;
  return String(message ?? error ?? "render error");
}

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
      text = renderErrorLine(error);
    }
    return new Text(text, 0, 0).render(width);
  }

  /** Composing is pure — there is no cached rendering state to invalidate. */
  invalidate(): void {}
}

/**
 * The same barrier for a COMPONENT subtree rather than a string composer.
 *
 * WHY BOTH EXIST
 *   ComposerComponent's try/catch is what makes a render-time throw survivable,
 *   and every string-composing surface goes through it. But ticket 03's settled
 *   EXPANDED report is not a string — it is a `Container` of a header `Text`
 *   plus a `Markdown` body — so it returned a bare Container and escaped the
 *   barrier entirely. Two crash hotfixes (2026-08-16) had already been spent on
 *   exactly this failure mode on the call-render side; this closes the one
 *   remaining path instead of leaving the third occurrence to find it.
 *
 * The subtree is built LAZILY inside `render` so a throw in the BUILDER (e.g.
 * reading `.content` off a partial result) is caught by the same barrier as a
 * throw inside a child's own `render`. A successful build is cached; a failed
 * one is dropped so the next frame retries rather than latching the error.
 */
export class GuardedComponent implements Component {
  private readonly build: () => Component;
  private built: Component | undefined;

  constructor(build: () => Component) {
    this.build = build;
  }

  render(width: number): string[] {
    try {
      this.built ??= this.build();
      return this.built.render(width);
    } catch (error) {
      this.built = undefined;
      return new Text(renderErrorLine(error), 0, 0).render(width);
    }
  }

  invalidate(): void {
    this.built?.invalidate?.();
  }
}
