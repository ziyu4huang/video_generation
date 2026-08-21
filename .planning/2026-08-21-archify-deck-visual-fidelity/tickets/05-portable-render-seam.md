---
ticket: 05-portable-render-seam
effort: archify-deck-visual-fidelity
type: task
status: open
created: 2026-08-21
last: 2026-08-21
depends: [01]
---
# 05 — `pptx → N images`, portably, as a tool and never as a gate

> Spec §2.5, §3 D1 + D2 + D3, §6.

## What to build

`lib/deck-render.ts`:

```ts
export interface DeckRenderer {
  readonly id: "quicklook" | "libreoffice";
  available(): boolean;                                   // probe, never throw
  renderSlides(pptx: string, outDir: string): Promise<string[]>;  // slide-N.png
}
export function pickRenderer(): DeckRenderer | null;
```

Two backends, one naming contract, callers never learn which ran:

- **`quicklook`** — darwin. Quick Look thumbnails only the **first** slide, so this backend
  splits the deck into N one-slide decks and renders each. Measured 0.24 s for six slides,
  zero install. Splitting reuses the deck builder; `ir` paths must be absolutised, because
  they are relative to the config file and the generated configs do not live beside it.
- **`libreoffice`** — any platform where `soffice` is on `PATH`. Converts the whole deck to
  PDF, rasterizes the pages. **Unmeasured — not installed on this machine.** Do not claim a
  number for it in docs; measure it or say it is unmeasured.
- **neither available** → `pickRenderer()` returns `null` and the caller reports the reason
  by name. Never a silent success, never a throw into a build.

Then `deck render <config> [--out <dir>]`, wired the same way `deck` already is.

## Explicitly not built

- **No golden-pixel baselines, no image diffing, no CI gate** (D1, D3). Every permanent
  assertion in this effort lives in tickets 01–04 and needs no engine. This ticket produces
  pictures for humans.

## Acceptance

- On darwin: six images from the composed example, in one call.
- With `PATH` stripped of both binaries: `pickRenderer()` returns `null`, the command exits
  non-zero with a message naming what it looked for. No stack trace.
- `no-browser-deps.test.ts` still passes untouched — these are system binaries, outside its
  scope by construction.
- A receipt under `bun-apps/s2-agent-ext-archify/receipts/`, in the shape round 1 used for
  the XSD work: the four defects before, the same four after, the exact commands, and the
  backend and OS each image came from.
- Spec §6's hand-rolled recipe is deleted from the docs in favour of the command.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
