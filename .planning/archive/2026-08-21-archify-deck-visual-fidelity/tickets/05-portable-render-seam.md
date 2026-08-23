---
ticket: 05-portable-render-seam
effort: archify-deck-visual-fidelity
type: task
status: closed
created: 2026-08-21
last: 2026-08-22
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

## Result (2026-08-22)

All acceptance items shipped on darwin, in one branch with the Phase 1 fixes:

- `lib/deck-render.ts` — `DeckRenderer` (`QUICKLOOK` / `LIBREOFFICE`), `pickRenderer()`,
  `rendererStatus()` (the named-reason companion). `bun run deck render <cfg>
  [--out] [--size]` wired in `scripts/deck.ts`.
- **darwin, one call**: 6 images from the composed example (`slide-1..6.png`),
  826 ms including the zip repacks; legacy example 5 images.
- **no backend**: PATH stripped → `pickRenderer()` null; CLI exits 1 printing
  `quicklook: needs darwin + qlmanage — not found here` / `libreoffice: needs
  soffice + pdftoppm — not found here`. No stack trace. Pinned renderer-free in
  `__tests__/deck-render.test.ts` (12 tests; no test spawns a backend — D1).
- `no-browser-deps.test.ts` untouched and green (system binaries were never its
  subject). Suite 477 pass / 21 skip / 0 fail; typecheck clean.
- Receipt: `receipts/archify-portable-render-seam-2026-08-22.md` — all four
  defects before/after, exact commands, backend + OS, both owed re-runs paid
  (P3: `拉近看 →` arrow restored; P4: column fill ~50 % → ~100 %).
- Spec §6 hand-rolled recipe deleted in favour of the command.

## Resolution notes

- **Route deviation, measured first**: the quicklook backend does NOT rebuild
  one-slide decks from a manifest — `renderSlides(pptx, outDir)` has no
  manifest (D2), a rebuild would picture a different file than the one on disk,
  and `qlmanage` was measured to honour `<p:sldIdLst>` order (not lowest id,
  not part-name order). Each copy rotates the target slide to the front;
  every part stays byte-as-built.
- **Zip handling is shell-free** like `read-zip.ts`: a ~100-line STORED-entry
  repacker (`repackZipEntry` + `crc32`, PKZIP vector-pinned). Data-descriptor
  zips are refused by name, not mis-read.
- **`Bun.which` takes an explicit `{ PATH }`**: the optionless form snapshots
  startup PATH and ignores later env changes, which would have made the probe
  untestable (`onPath()` helper).
- **LibreOffice remains unmeasured** (not installed here); no number claimed.
- **Quick Look cannot picture P2-class defects** (it breaks lines against the
  full box width, ignoring `rIns`) — charted in the map fog since P2; the
  receipt repeats it so the next person does not trust a one-line quicklook
  image over a wrap-budget refusal.
