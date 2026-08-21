---
ticket: 06-ooxml-lint
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocking: [08]
---
# 06 — `lib/ooxml-lint.ts` + the `Bun.XML` order receipt

> Spec §4.6, §2.5, decisions D5 + D6.

## What to build

Promote `__tests__/helpers/read-zip.ts` → `lib/read-zip.ts` (one reader for lint and tests).

`lintPptx(parts) => OoxmlDiagnostic[]`, seven rules per spec §4.6. Rules 1–6 use
**`Bun.XML`** (1.46× faster; `spPr`'s children are distinct tags so key order IS document
order). Rule 7 — every `a:path` begins with `a:moveTo` — uses **`HTMLRewriter`**, because
repeated interleaved segment tags are exactly what `Bun.XML` collapses.

Correct the `Bun.XML` paragraph in `lib/svg-model.ts`: order is lost for *repeated* sibling
tags, not for differing ones. The conclusion (HTMLRewriter for SVG) does not change — an
SVG's siblings repeat constantly.

## Acceptance

- Zero diagnostics over a freshly built `examples/deck` PPTX.
- One unit test per rule feeding deliberately broken XML.
- An order receipt test pinning the §2.5 finding, so a future bun that fixes it is noticed
  rather than assumed.
- A one-off ECMA-376 XSD validation receipt under `receipts/` (D5 — not a permanent gate).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — `lib/ooxml-lint.ts` (7 rules) + `lib/read-zip.ts` (promoted from
`__tests__/helpers/`) + `__tests__/ooxml-lint.test.ts` (23 tests). Both example decks: **0
diagnostics**, ~17 ms over 36–40 parts.

Two false positives were found while calibrating, each now a test:
1. **ZIP directory entries are not parts** — a real `.pptx` has 19, absent from
   `[Content_Types].xml` by design. `readZipText` skips them.
2. **`<a:ext>` is two different elements** — `CT_PositiveSize2D` (cx/cy) under `<a:xfrm>` vs
   `CT_OfficeArtExtension` (uri) under `<a:extLst>`. Without the parent tag, every theme part
   reads as broken. The walker now carries it.

`svg-model.ts`'s `Bun.XML` paragraph is corrected: order dies for REPEATED sibling tags, not
for differing ones. The conclusion is unchanged (SVG siblings repeat constantly), and the
distinction is exactly what lets rules 4–5 use the faster parser.

**The XSD one-off ran and found something.** 36 parts valid, 2 invalid — both
`ppt/presentation.xml`, `<p:notesMasterIdLst>` two positions later than CT_Presentation
allows. Upstream and deliberate: pptxgenjs's own source comments that the correct position
"causes warning in modern powerpoint!". Byte-identical pre-refactor; accepted by every
consumer tested. Not fixed, and deliberately NOT a lint rule — a gate that fires on every
build is noise. Full write-up, including how to assemble the schemas so libxml2 can compile
them, in `receipts/archify-slide-composition-2026-08-21.md`.
