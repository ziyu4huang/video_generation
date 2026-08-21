---
ticket: 01-icon-fill-semantics
effort: archify-deck-visual-fidelity
type: task
status: open
created: 2026-08-21
last: 2026-08-21
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
