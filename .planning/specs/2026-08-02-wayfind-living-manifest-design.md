# Wayfind Layer 3 — Living Effort Manifest

**Status:** Design (awaiting plan)
**Date:** 2026-08-02
**Branch:** `feature/wayfind-living-manifest` (off `main` @ `c0e66965`)
**Depends on:** Layers 1–2 (effort front-matter manifest + `wayfind_effort` tool, merged in #1006)

## Goal

Make the effort manifest (layer 1) a **living** artifact: once an effort has a
manifest, its `last:` self-tracks on every write and its lifecycle `status` shows
in the status bar — so any session can glance at `.planning/` (or the bar) and
see a current picture of each effort. The manifest stays **opt-in**: only efforts
that already have one (created via layer 2's `wayfind_effort` `create`, or by
hand) self-track and self-display. Legacy prose-only efforts are untouched.

## Background (layers 1–2, already on `main`)

- `EffortMeta` (`effort`/`created`/`last`/`status`/`owner`) + `parseMapFrontmatter`
  / `serializeMapFrontmatter` in `map.ts`.
- `readMap`/`writeMap` round-trip the manifest; `writeMap` emits front-matter
  **only when `meta` is present** (legacy byte-compat guarantee).
- `validateEffortMap(map, folderEffort)` conformance check.
- `wayfind_effort` tool (`effort-tool.ts`): `create`/`validate`/`status`, with
  backing cwd-based fns `createEffort` / `validateEffort` / `effortStatus`.
- `WayfindOverlay` (`overlay.ts`): renders **one transient activity line**
  `🧭 wayfind │ {emoji} {text}`, set per-command-action via `setLine`, cleared on
  `dispose`. No persistent state; `render(theme, width)` gets no cwd/session.

## Design (approved — Approach 1: minimal-surface living manifest)

### 1. `touchEffortManifest(cwd, effort)` — new helper, `map.ts`

Reads `.planning/<effort>/map.md`; if it has front-matter, sets `meta.last =
today()` and writes the file back with the body byte-for-byte unchanged. **No-op**
when the map is absent or has no front-matter (legacy-safe, opt-in).

- Called from `writeTicket` (which `closeTicket` delegates to, so the close
  path is covered once) and `appendDecision` — the two mutation chokepoints that
  write files other than `map.md`.
- `writeMap` stamps `last:` **inline** (it already serializes `map.md`) when
  `meta` is present — no extra read.
- Implementation regenerates **only** the leading front-matter block in place
  and leaves everything after the closing `---` **verbatim** (raw substring), so
  prose/sections/decisions are never reflowed. (A `parseMapFrontmatter` →
  `serializeMapFrontmatter` round-trip is **not** used for the body — it
  normalizes leading whitespace and would not be byte-safe for hand-written maps.)

### 2. Persistent manifest status in the overlay

- New `WayfindOverlay.setActiveEffort(effort: string | undefined, cwd: string)`.
- `render(theme, width)` precedence:
  1. Transient action set (current `setLine` state) → render the action line
     **unchanged** (actions still win while a command runs).
  2. Else if `activeEffort` set → read its manifest via `readEffortMeta` and
     render `🧭 wayfind │ 🗺️ {effort} · {status}`; render `· (no manifest)`
     when the effort has no front-matter (legacy).
  3. Else → `[]` (unchanged).
- New lightweight `readEffortMeta(cwd, effort): EffortMeta | null` in `map.ts`:
  reads **only** `map.md` + `parseMapFrontmatter` (no `tickets/` scan), so the
  per-render cost is one tiny file read. Returns `null` when no map / no
  front-matter.
- Wiring: `handleWayfinderChart` (and any site that sets
  `state.activeEffortBySession`) calls `overlay.setActiveEffort(effort, ctx.cwd)`
  alongside it; `endGrillForSession` / `session_shutdown` clears it.

### 3. `/wayfind validate [effort]` — `commands.ts`

Add `validate` to `WAYFIND_KEYWORDS` + a `handleWayfindValidate` handler:
resolve `effort` from the arg or the session's active effort (same fallback as
the other subcommands), run `validateEffort(cwd, effort)`, and `notify` the
rendered result (reuses `renderValidate` from `effort-tool.ts`). Surfaces the
conformance check that already exists but is currently only tool-reachable.

## Data flow

- **Write (self-track):** command or tool mutates a ticket/map →
  `writeTicket`/`appendDecision` (via `touchEffortManifest`) or `writeMap`
  (inline) bumps `meta.last` → `map.md`
  front-matter stays current.
- **Display (self-describe):** composite widget `render` → `WayfindOverlay.render`
  → (idle + active effort?) `readEffortMeta` → manifest status line.

## YAGNI / out of scope

- **No manifest caching** (Approach 2): the file is tiny; a read-per-render is
  fine at this scale. Caching + invalidation is deferred until profiling shows a
  need.
- **No auto-manifest for legacy maps** (Approach 3): `writeMap` keeps emitting
  front-matter only when `meta` is present, preserving the layer-1 byte-compat
  guarantee.
- **Status transitions stay manual.** Layer 3 auto-stamps `last:` only — it
  never flips `active → paused/complete`. That's a deliberate act (the closing
  ceremony / human), not a write side-effect.
- No new tool actions on `wayfind_effort` (the existing `create`/`validate`/
  `status` suffice for layer 3).

## Testing

Co-located with the layer-1/2 tests (`tests/`), same `bun run test:unit` guard:

- `touchEffortManifest`: stamps `last:` on a manifest map; no-op on a legacy
  (front-matter-free) map; no-op when no map; preserves the body unchanged.
- `writeMap`: stamps `last:` inline when `meta` present; leaves legacy output
  front-matter-free.
- `readEffortMeta`: returns the manifest (no ticket scan); `null` for legacy /
  missing.
- `WayfindOverlay.render`: action line takes precedence; manifest line when
  idle + active effort; `(no manifest)` for a legacy active effort; empty when
  no active effort.
- `/wayfind validate`: notifies valid on a conforming effort; notifies problems
  on a missing-Destination map; "no map" on a missing effort.

## Risks

- **Render-frequency file read:** mitigated by `readEffortMeta` (map.md only,
  no ticket scan). Watch if the widget render rate is high; cache later if real.
- **appendDecision double-write:** it edits the body via regex, then
  `touchEffortManifest` re-reads + rewrites for the front-matter bump. Two
  reads/writes, but isolated and correct. Acceptable; revisit if it surfaces.
