---
ticket: 06-ooxml-lint
effort: archify-slide-composition
type: task
status: open
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
