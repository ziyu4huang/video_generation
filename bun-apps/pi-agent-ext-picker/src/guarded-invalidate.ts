/**
 * guarded-invalidate.ts — structural re-entry guard for the overlay→tui
 * invalidate() wiring seam.
 *
 * CONTEXT: the vendored @earendil-works/pi-tui TUI.invalidate() (tui.js ~428)
 * synchronously cascades into EVERY overlay's invalidate() with no re-entry
 * guard (read-only — we cannot patch it). MenuPickerEditor wires its overlay
 * via:
 *   this.overlay.setInvalidate(() => this.tui.invalidate());
 *
 * The Component.invalidate() contract is a cache-bust ONLY (must NOT request a
 * render): commit e411f7fa made MenuOverlay.invalidate() a no-op for exactly
 * this reason, and that no-op STAYS — this helper is additive defense-in-depth
 * ON TOP OF it.
 *
 * RISK THIS GUARDS: if ANY overlay (now or future) ever calls invalidateFn()
 * from inside its invalidate(), the cascade re-enters tui.invalidate() and
 * recurses until "RangeError: Maximum call stack size exceeded". We make that
 * IMPOSSIBLE at the wiring seam: only the FIRST, non-reentrant call (the
 * legitimate render request from move()/setQuery()) propagates to
 * tui.invalidate(); reentrant calls during an in-flight cascade become no-ops.
 *
 * SCOPE: the flag MUST be per editor instance (the returned closure is created
 * once per editor in the constructor), NOT module-level — a shared flag would
 * be corrupted by concurrent overlays. Each editor creates its own guard.
 *
 * NOTE: this file is intentionally identical to its sibling in
 * @repo/pi-agent-ext-core-task. The two packages do not share a util package
 * and do not depend on each other, so duplicating a ~20-line helper keeps them
 * decoupled (per repo "no cross-ext import" convention) rather than introducing
 * a new package dependency for such a small, self-contained guard.
 */

/** Minimal structural shape of the pi-tui TUI surface this guard needs. Kept
 * structural (no pi-tui import) so the helper is dependency-free and trivially
 * mockable. The real `TUI` satisfies this. */
interface InvalidateTarget {
  invalidate(): void;
}

/**
 * Wrap a tui.invalidate() callable in a re-entry guard. Returns a fn suitable
 * for passing to overlay.setInvalidate(). Reentrant invocation while a cascade
 * is already in flight is a no-op; only the first (non-reentrant) call
 * propagates. See the file header for the full rationale.
 */
export function createGuardedInvalidate(tui: InvalidateTarget): () => void {
  let inCascade = false;
  return () => {
    if (inCascade) return; // reentrant call during an in-flight cascade — skip
    inCascade = true;
    try {
      tui.invalidate();
    } finally {
      inCascade = false;
    }
  };
}
