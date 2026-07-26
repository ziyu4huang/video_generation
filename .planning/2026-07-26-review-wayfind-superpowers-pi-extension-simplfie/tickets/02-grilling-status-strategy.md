---
type: grilling
status: closed
claimed: wayfind-decouple-session (2026-07-26)
blocked by: [01]
---

# 02 — Grilling: status-display strategy after dropping the core-task dep

## Question

Once `pi-agent-ext-wayfind` no longer imports `getSharedStatusWidget()` from
`pi-agent-ext-core-task`, how does it display its TUI status line? The choice
governs the implementation (map's *Not yet specified*) and the supersession ADR.

## Options on the table (research-grounded, ticket 01)

- **A — Duck-type the global (recommended)**: read
  `globalThis.__piCoreTaskStatusWidget` best-effort (no import, no package dep);
  when present, `addSection({ id: "wayfind", order: 2, render })` exactly as
  today; when absent (core-task not loaded), fall back to no status (or
  `ctx.ui.setStatus`). **Reverses ADR-0002's *dependency* while keeping its
  *coordination intent*** (one composite widget, deterministic ordering, no
  footer collision). Coupling becomes a loose string+shape contract, not a
  build-time dep. Respects the jiti constraint (global, not module-level).
- **B — Revert to an independent `ctx.ui.setStatus()` footer line**: the
  pre-ADR-0002 approach. No dep, no global coordination. Risk: re-introduces the
  footer collision ADR-0002 fixed (now only vs core-task's above-editor widget —
  a *different* surface, so the collision may be milder; needs checking) and
  loses the deterministic above-editor section ordering.
- **C — No status display**: drop the TUI status entirely. Simplest; loses the
  "wayfinding active" visual feedback.

## Notes for the grilling

- The jiti constraint means **any** cross-extension singleton must be
  `globalThis`-backed — so A is not a hack, it's the same pattern core-task
  itself uses; B sidesteps it by not sharing state at all.
- `planning-with-files` (ADR-0002's other consumer) was removed in PR #620;
  wayfind is now the only external section in the widget. **This is the premise
  that makes re-examining ADR-0002 timely.**
- The `StatusSection` shape (`{ id, order?, render(theme, width): string[] }`)
  is small and stable — duck-typing it carries low contract-drift risk.

## Resolution (2026-07-26)

**Strategy: A — duck-type the global. No fallback.**

- Read `globalThis.__piCoreTaskStatusWidget` best-effort (no import, no package
  dep). When present, register wayfind's section exactly as today:
  `widget.addSection({ id: "wayfind", order: 2, render })` + `setUICtx` / `update`
  via the existing `WayfindOverlay`. When absent (core-task not loaded), the
  section simply doesn't render — ADR-0002's accepted consequence, retained
  (core-task is always loaded in practice; earliest in the manifest).
- **Coupling after reversal**: the build-time package dependency on core-task is
  GONE; a loose runtime string+shape contract remains (the global key
  `__piCoreTaskStatusWidget` + the `{ addSection, setUICtx, update }` /
  `StatusSection` surface). This is the intended trade-off: decoupled at build
  time, loosely coordinated at runtime, unified widget UX preserved.
- **Type approach (implementation note, not a decision)**: define a local
  structural interface matching the widget's surface and cast the global to it
  — no `instanceof`, existence-check only (same cross-loader discipline
  core-task's own singleton guard already uses).
- **Net code change** (handoff spec): `src/index.ts` (drop import `:16`, swap
  the `getSharedStatusWidget()` call `:24` for a global read + structural cast,
  update comments `:8`/`:49`); `package.json` (drop the `workspace:*` dep);
  `src/overlay.ts` comment-only; supersede ADR-0002. Tests unaffected (ticket 01).
- This unblocks ticket 03 (scope boundaries); the implementation itself is the
  `writing-plans` / SDD handoff, not a map ticket.
