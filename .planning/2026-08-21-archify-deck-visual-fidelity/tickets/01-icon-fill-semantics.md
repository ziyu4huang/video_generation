---
ticket: 01-icon-fill-semantics
effort: archify-deck-visual-fidelity
type: task
status: closed
created: 2026-08-21
last: 2026-08-22
blocking: [05]
---
# 01 — stroke-only paths must say `<a:noFill/>` and `fill="none"`

> Spec §2.1, §4 (P1), risk §5.1. This is the effort's frontier.

## The defect

Every node icon and all five legend swatches render as radiating star bursts in the
`.pptx`. The HTML twin renders the same source IR as rounded-rect outlines, so the geometry
is fine — shape 36 is lucide `code`, shape 48 is `database`, both emitted with correct
coordinates. What is missing is fill semantics, in two independent places:

- `<p:spPr>` has **no fill element at all** → DrawingML inherits a fill from the shape style.
  Needs an explicit `<a:noFill/>`.
- `<a:path>` defaults to `fill="norm"` → each open subpath is closed and filled, which is
  what produces the burst. Needs `fill="none"`.

`lib/pptx-shapes.ts:85` already returns `{ fill: { type: "none" } }`, so the *model* knows.
The information dies somewhere between there and the XML.

## Answer this first

**Can `pptxgenjs@4.0.1` express either of these?** Not established — the package is not
installed in this worktree (isolated linker + globalStore, `bun-apps/bunfig.toml`), so
neither the option name nor the library's handling was inspected. Install it or read it out
of the global store, then check `addShape`'s fill handling and whether any per-path fill
attribute is reachable.

The answer decides the shape of the whole ticket:

- **it can** → a call-site change in `lib/pptx-shapes.ts`, small.
- **it cannot** → an XML post-process on the emitted part, materially larger, and it
  interacts with the byte-identity lock (see below). Do not start writing that until the
  question is actually answered.

## What to build

The fix, plus a **renderer-free** assertion: for both example decks, every `<p:sp>` whose
ShapeIR node has a stroke and no fill emits `<a:noFill/>`, and every `<a:path>` inside it
carries `fill="none"`. Read the parts with the existing `lib/read-zip.ts`; this belongs
next to `ooxml-lint`'s rules or inside them.

Include a test that the assertion **can fail** — feed it a shape with the fill elements
stripped — per the pattern `no-browser-deps.test.ts` established.

## Acceptance

- Both example decks satisfy the assertion.
- A visual check via ticket 05's procedure (or §6 of the spec by hand) confirms the icons
  render as outlines, not bursts.
- The legacy `examples/deck/` deck still builds. Its slide XML will **not** stay
  byte-identical to the round-1 capture if it contains stroke-only paths — that is a correct
  change, but diff the bytes and account for **every** one that moved, the way round 1
  caught the stray `algn="l"`. Count-equality is not evidence here.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Resolution

**closed: 2026-08-22** — P1 fixed, but **the attribution in this ticket and in
`spec.md` §2.1 was wrong**, and that correction is the main finding.

### What the blocking question turned out to be

`pptxgenjs@4.0.1` can express half of it and not the other half:

| | reachable? | how |
|---|---|---|
| `<a:noFill/>` on the shape | **yes** | by **OMITTING** `fill`. `fill: { type: "none" }` — what archify sent — emits **no fill element at all**, and so do `fill: "none"` and `{ color, transparency: 100 }`. Measured against all five spellings. |
| `<a:path fill="none">` | **no** | the path element is a hardcoded template literal, `` `<a:path w="${cx}" h="${cy}">` ``; `pathFill` / `ST_PathFill` appear 0 times in dist and typings |

Three cheaper routes than re-archiving were probed and closed: `jszip` is bundled
inside pptxgenjs's dist rather than declared as a package edge (does not
resolve); `Bun.Archive.write` writes a **tar** even when the target is named
`.zip`; patching bytes in place moves every later local-header offset, i.e. it
is a zip writer with extra steps. All 59 entries of a built deck are **STORE**
(pptxgenjs defaults `compression: false`), so `lib/write-zip.ts` needs no
deflate — header, bytes, central directory, EOCD, with CRC-32 the only
computation.

### The correction: neither half caused the bursts

Both halves were implemented, and **each was measured against a re-render**:

1. `<a:noFill/>` landed (`<a:noFill/>` 81 → 95 on the composed deck) → render
   **pixel-identical**, bursts unchanged.
2. `<a:path fill="none">` landed (9 of 13 paths on composed slide 4, correctly
   skipping the 4 filled ones) → render **pixel-identical**, bursts unchanged.

So the fill semantics were a real latent defect and **not** what the render was
showing. Inspecting the actual burst shapes found them to be neither stroke-only
nor custGeom:

```xml
<a:prstGeom prst="roundRect">
  <a:avLst><a:gd name="adj" fmla="val 269169"/></a:avLst>
</a:prstGeom>
```

`roundRect`'s adjustment is a percentage in hundred-thousandths, capped at
**50000** (50 % of the smaller side). Past that the preset's corner arcs
self-intersect — which is the star burst. **43 out-of-range values across the
two example decks, worst 317450 = 6.3x the ceiling.**

Root cause is a unit error at the library boundary, not in archify's model:
`lib/pptx-shapes.ts` already clamped its fraction to 0.5 correctly, then passed
that fraction as `rectRadius`. pptxgenjs's formula is

```
adj = round(rectRadius * 914400 * 100000 / min(cx, cy))
```

— `rectRadius * EMU` is a LENGTH IN INCHES. Its typings say "values: 0.0 to 1.0",
which reads as a fraction and is what the code (and its comment) believed. Passing
the fraction 0.222 for a 0.08 in legend swatch asked for a 0.222 **inch** radius.
Fix: pass `fraction * min(w, h)` in inches, which collapses the formula back to
`adj = fraction * 100000`.

### What shipped

- `lib/pptx-shapes.ts` — `fillOf` omits `fill`; `rect` passes `rectRadius` in inches.
- `lib/write-zip.ts` — STORE-only deterministic ZIP writer (+ `readZipEntries` in `read-zip.ts`).
- `lib/ooxml-postprocess.ts` — `<a:path fill="none">` scoped to shapes whose own
  `spPr` carries `<a:noFill/>`; `<a:ln>`'s noFill does not count, and `<a:lnTo>`
  path segments are not mistaken for it. Returns the original bytes untouched
  when nothing matches.
- `lib/ooxml-lint.ts` — **new permanent rule `shape-adjust-range`**: every
  `<a:gd name="adj" fmla="val N"/>` must satisfy `0 <= N <= 50000`. Renderer-free,
  runs everywhere (D1). Verified it CAN fail: 14 diagnostics on the pre-fix
  build, 0 after.
- Two unit tests rewritten. Both asserted what archify **sent**; one was even
  named "a pill, not an invalid adjust" while passing on `adj val="269169"`.
  A third (`fill:none becomes an explicit no-fill`) had the same defect.

### Byte accounting (this ticket's acceptance bar)

The D3 byte-identity comparison is a one-off capture from the prior effort, not
a live gate, so the legacy deck's five slide parts were diffed by hand at
element granularity. The only element that moved was `<a:noFill/>`:

```
slide1 +33 = 3 x 11B   slide2 +121 = 11 x   slide3 +165 = 15 x
slide4 +143 = 13 x     slide5 +88  =  8 x   total 50, nothing else
```

(`adj` attribute values changed in place; no element count changed for them.)

### Gates

`bun test` **424 pass / 21 skip / 0 fail** (was 405/21/0; +19 new).
`bun run typecheck` clean. Both example decks: `ooxml lint` clean, `blip` 0,
`adj` out-of-range **0**, legacy still **5 slides / 388 native shapes**.
Build cost 0.26 s -> 0.27 s (the zip rebuild is ~10 ms on a 302 KB deck).

### The path-level half was built, measured, and REMOVED (decided 2026-08-22)

`lib/write-zip.ts` (STORE-only deterministic ZIP writer, + `readZipEntries`) and
`lib/ooxml-postprocess.ts` (`<a:path fill="none">` scoped to `<a:noFill/>` shapes)
were written, tested (19 tests, all green) and then **deleted**. Three
independent lines closed the question, and the third is decisive:

1. **Measured.** Composed slides 3 and 4 — the only two carrying patched paths —
   rendered **pixel-identical** with 9/13 paths patched and with 0 patched. The
   comparison was made in isolation after a control showed batch renders across
   different directories are not comparable (the `.pptx` files differ by a
   `docProps` timestamp, and a batch of six is not the deterministic condition;
   two identical batch runs of the SAME files ARE byte-identical, and two
   isolated renders of the two files ARE byte-identical).
2. **Spec.** `ST_PathFillMode="norm"` means "fill using the shape's fill". Once
   `<p:spPr>` carries `<a:noFill/>`, `norm` has nothing to fill with, so
   `fill="none"` is redundant rather than merely undetectable.
3. **Structural — the decisive one.** A `ShapeIR` node carries **one style** and
   emits **one `<a:path>`**. A per-subpath fill that differs from the shape's
   fill cannot arise from archify's model at all. The post-process could never
   express anything the shape-level fill does not already say; it was
   unreachable code with a zip rebuild attached.

Kept instead, at zero cost: the `fillOf` call-site fix, which removes a genuine
DrawingML ambiguity (an absent fill element means "inherit from the shape
style"). Suite returned 424 -> 405 pass with the 19 tests for the removed
modules; `examples/deck/` returned 303 KB -> 302 KB, and the composed deck's
slide-4 render is byte-identical to the patched build.

**If a future ticket needs OOXML post-processing**, this is the receipt for how:
pptxgenjs writes all entries STORE (`compression: false` default), so a writer
needs no deflate — header, bytes, central directory, EOCD, CRC-32 only. `jszip`
does not resolve (bundled in the dist, not a package edge) and
`Bun.Archive.write` emits a tar even for a `.zip` target.
