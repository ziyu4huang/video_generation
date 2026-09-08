# Ticket 04 — deck seam (vendored slim renderer)

## Goal

`src/raster/deck.ts`: self-contained `pptx → slide-N.png`, no archify import
(entangled with DeckError/deck-build), no new deps — pure-Bun zip walk,
probe-only availability, bounded render limit.

## Files

- `src/raster/deck.ts` (PptxRenderError, crc32, readZipText,
  rewriteZipEntries/repackZipEntry, promoteSlideFirst, countSlides,
  QUICKLOOK/LIBREOFFICE, pickRenderer, rendererStatus, RenderOptions.limit)
- `__tests__/deck.test.ts` (renderer-free pure-part tests)

## Done when

- [x] pure-part tests mirror archify's deck-render.test.ts: crc32 PKZIP
      vector, repack replace + add round-trips, not-a-zip refusal,
      promoteSlideFirst reorder/no-op/refusal, countSlides, slide-N naming,
      pickRenderer null + looksFor on empty PATH
- [x] no import of archify (grep-assert by construction — the file imports
      only node:fs/node:os/node:path)
- [x] live smoke: real INCOSE deck, quicklook backend, limit 2 →
      slide-1.png 112 KB + slide-2.png 136 KB
- [x] typecheck green

## Resolution

closed: 2026-09-08 — 11/11 tests; live smoke receipt cited in map Context.
