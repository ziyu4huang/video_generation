/**
 * guarded-invalidate.test.ts — defense-in-depth for the overlay→tui invalidate
 * wiring seam. See ../src/guarded-invalidate.ts for the full rationale.
 *
 * These tests PROVE the guard neutralizes a misbehaving overlay whose
 * invalidate() re-enters its invalidateFn — exactly the bug e411f7fa removed
 * from MenuOverlay. The existing no-op invalidate() STAYS in place; this guard
 * is additive belt-and-suspenders so a FUTURE overlay reintroducing the bug
 * cannot crash the agent with a RangeError cascade.
 *
 * Mocking style mirrors menu-render.test.ts's "tuiInvalidate -> overlay.invalidate"
 * propagation, but inverted: here the overlay is the reentrant (misbehaving)
 * side, and the guard is what's under test.
 */
import { expect, test } from "bun:test";
import { createGuardedInvalidate } from "../src/guarded-invalidate.ts";

/** A minimal Component whose invalidate() re-enters invalidateFn — i.e. it
 * violates the cache-bust contract the way MenuOverlay did pre-e411f7fa.
 * Represents the WORST-CASE future overlay. */
interface ReentrantOverlay {
  setInvalidate(fn: () => void): void;
  invalidate(): void;
}

function makeReentrantOverlay(): ReentrantOverlay {
  let invalidateFn: () => void = () => {};
  return {
    setInvalidate(fn) {
      invalidateFn = fn;
    },
    invalidate() {
      invalidateFn();
    }, // THE BUG: re-enters invalidateFn
  };
}

/** A minimal TUI whose invalidate() mirrors the vendored pi-tui cascade:
 * tui.invalidate() synchronously calls every overlay's invalidate(). A bounded
 * depth cap throws a synthetic RangeError (matching the real failure mode) so
 * the unguarded scenario is fast + deterministic instead of waiting for a real
 * stack overflow at ~10k frames. */
function makeCascadeTui(overlay: ReentrantOverlay, cap = 64) {
  let count = 0;
  let depth = 0;
  const tui = {
    invalidate() {
      count++;
      if (++depth > cap) throw new RangeError("Maximum call stack size exceeded");
      overlay.invalidate();
    },
  };
  return { tui, count: () => count };
}

// Guard neutralizes an EXTERNAL cascade: something calls tui.invalidate() while
// the picker is open. The cascade terminates instead of recursing to RangeError,
// and the legitimate first call still propagates.
test("guard neutralizes a reentrant overlay on external tui.invalidate() — no RangeError, propagates", () => {
  const overlay = makeReentrantOverlay();
  const { tui, count } = makeCascadeTui(overlay);
  overlay.setInvalidate(createGuardedInvalidate(tui));

  // Path: tui.invalidate() [count=1] -> overlay.invalidate() -> guarded fn
  // (first, non-reentrant -> propagates) -> tui.invalidate() [count=2] ->
  // overlay.invalidate() -> guarded fn (reentrant -> no-op). Cascade STOPS.
  expect(() => tui.invalidate()).not.toThrow();
  // Exactly 2 tui.invalidate() calls: the external caller's + the one guarded
  // propagation. The infinite reentrant tail is suppressed — the whole point.
  expect(count()).toBe(2);
});

// Guard neutralizes a STATE-CHANGE cascade: move()/setQuery() requests a render
// by calling invalidateFn() directly. Same outcome: terminates, propagates once.
test("guard neutralizes a reentrant overlay on state-change invalidateFn() — propagates exactly once", () => {
  const overlay = makeReentrantOverlay();
  const { tui, count } = makeCascadeTui(overlay);
  const guardedFn = createGuardedInvalidate(tui); // what move()/setQuery() call
  overlay.setInvalidate(guardedFn);

  // Path: guardedFn (first, non-reentrant -> propagates) -> tui.invalidate()
  // [count=1] -> overlay.invalidate() -> guardedFn (reentrant -> no-op). Stops.
  expect(() => guardedFn()).not.toThrow();
  expect(count()).toBe(1); // exactly one propagation; reentry suppressed
});

// Companion documenting test: the RAW pre-guard wiring (what the editor used
// before this change) WITH the same misbehaving overlay DOES recurse to a
// RangeError. This locks in WHY the guard exists. Guarded by try/catch so the
// test itself PASSES while documenting the danger.
test("UNGUARDED wiring with a reentrant overlay recurses to RangeError — documents why the guard exists", () => {
  const overlay = makeReentrantOverlay();
  const { tui } = makeCascadeTui(overlay);
  // The RAW pre-guard seam: () => tui.invalidate().
  overlay.setInvalidate(() => tui.invalidate());

  let threw: unknown = null;
  try {
    tui.invalidate();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(RangeError);
});
