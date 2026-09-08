# Ticket 02 — svg seam liveness bound

Status: done

## Goal

A wedged WebView can no longer hang a conversion: every await on the WebView
(navigate, waitReady, measure, screenshot) is raced against a TS-side liveness
budget; expiry resolves to the existing degrade path (null) per the parent's
best-effort contract. Injectable view factory + budget make the stall
unit-testable without a real WebView (map D1-D3).

## Files

- `bun-apps/s2-agent-ext-file2md/src/raster/svg.ts` (waitReady :67-83,
  captureWrapper :93-133 — probe pass :98-110, capture pass :114-133)
- `bun-apps/s2-agent-ext-file2md/__tests__/svg-liveness.test.ts` (new; or
  extend `svg-lane.test.ts` if that file exists under that name — follow the
  existing naming)

## Scope

1. `SvgRasterOptions` gains `livenessMs?: number` and `createView?: (width:
   number, height: number) => SvgViewLike`; define the minimal structural
   `SvgViewLike` (navigate/evaluate/screenshot/close?). Default path
   unchanged: `webViewAvailable()` gate, real `new Bun.WebView`.
2. Add `withLiveness<T>(p: Promise<T>, ms: number): Promise<T | null>` —
   Promise.race against a timer that resolves null; CLEAR the timer on
   completion (an uncleared Bun timer pins the event loop) and attach a
   swallowed `.catch(() => {})` to the losing promise (closing a wedged view
   can reject).
3. Wrap each PASS whole (probe pass, capture pass) — not individual calls —
   so navigate/measure/screenshot hangs are covered too (map D2).
4. Guard the `finally` close: if `view.close()` can reject, swallow; do not
   let it turn a degrade into a throw.

## Done when

- [ ] Unit test: `createView` returns a fake whose `evaluate` NEVER resolves
      (stalled web process) + `livenessMs: 50` → both
      `renderSvgFileToPng` and `renderSvgTextToPng` return `null` in
      < 1 s wall clock (assert elapsed), not process-hang.
- [ ] Unit test: fake view whose `navigate` never resolves (the hang site
      waitReady-only racing would miss) → same null-in-budget outcome.
- [ ] Unit test: healthy fake view (scripted evaluate/screenshot responses)
      + generous livenessMs → returns the png bytes; the timer does not
      delay test exit (suite finishes promptly).
- [ ] No unhandled rejections (clean process exit; the losing-promise catch
      proven by a fake that REJECTS after the budget).
- [ ] Existing svg-lane tests green; `bun run typecheck` clean (the
      structural interface must accept `Bun.WebView`).

## Risks

- `Bun.WebView`'s real type surface vs the structural `SvgViewLike` — if
  direct assignment fights the types, a thin adapter at the default-factory
  site, not `any` at call sites.
- Real-WebView behavior cannot be CI-verified (no renderer in CI, by
  discipline); the bound is proven by fakes only — live receipt optional,
  not a gate.

## Resolution

closed: 2026-09-09 — `raceLiveness` (rejects; caller catches → null) + `opts.livenessMs` (SVG_LIVENESS_MS=10s) + `opts.createView` DI; loser-rejection swallow + `closeQuietly` guard; `__tests__/svg-liveness.test.ts` 4/4 (stalled probe, stalled capture, healthy-fake full flow, timer-constant pin). D10/D14 deviations recorded on the map.
