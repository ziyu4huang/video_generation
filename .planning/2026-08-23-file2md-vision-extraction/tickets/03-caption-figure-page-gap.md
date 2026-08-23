# Ticket 03 — document the caption-only figure-page gap + advisory trigger

- **Engineer:** task
- **Depends on:** none
- **Status:** closed

## Context

Measured on the 839-page `USB4 Specification 2.0 - CLEAN.pdf`: the doc is **100% text-layer**
(839/839 pages `provenance: text`), so `mode: vlm` never fires — the pipeline only triggers
vision/OCR when a page's text layer is `< OCR_TEXT_MIN_CHARS` (8). But **31 pages are
caption-only** (< 900 bytes): e.g. `page-269` body = `Figure 4-42. PRTS19 Pattern Generator`;
`page-096` = CTLE frequency-response figure captions; `page-105` = transmitter-equalization
captions. In each, the actual diagram is a vector drawing the text layer cannot capture. These
are the pages an agent reading the converted spec actually wants described, and the pipeline
never visits them — a silent content gap.

The wrong fix (D3) is auto-triggering vlm on every caption page: a ~90s LM Studio round-trip
per image is an unreasonable default on a 31-page set. Instead: document the loss precisely and
give the caller an explicit opt-in.

## Done-when

- [ ] `bun-apps/s2-agent-ext-file2md/skills/file2md/SKILL.md` gains a note: a page whose body is a
      bare `Figure N-x. ...` caption (or < ~900 bytes) is a caption-only figure page — the
      diagram is not in the text layer; describe it with `--extract vlm --pages <list>`
      (or treat as an image via `--type image`).
- [ ] The completion checklist / truth-rules in the SKILL state the loss explicitly (the SKILL's
      "never claim fidelity for ... figures" rule extended with the caption-page case).
- [ ] `docs/architecture.md` (or README) notes the trigger rule + the measured
      all-text-839-page case, so a maintainer knows why `vlm` didn't fire.
- [ ] No code behavior change (documentation + advisory only, per D3).

## Scope / verification

Docs only — verifiable by reading the SKILL and confirming the trigger rule matches the
pipeline's `OCR_TEXT_MIN_CHARS`-gate (`src/pipeline.ts:55`, `extractPdfPage`).

## Notes

- This is the honest surfacing of the USB4 figure-page loss discovered during the processing
  run. It does not "fix" the missing diagram (an image-rendering concern out of scope) — it
  makes the gap explicit so the consumer can opt into vision.
