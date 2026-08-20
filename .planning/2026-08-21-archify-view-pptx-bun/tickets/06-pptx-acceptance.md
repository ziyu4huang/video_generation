---
ticket: 06-pptx-acceptance
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [05]
---
# 06 — archify: the acceptance test that defines "shape design"

> Spec §5.1. Without this ticket, nothing structurally prevents a regression to images.

## What to build

`__tests__/pptx-shapes.test.ts`:

1. **Pure-Bun zip reader** (test helper, ~25 lines): walk ZIP local file headers
   (`0x04034b50`), read `method` / `compSize` / `nameLen` / `extraLen`, inflate method-8
   entries through `DecompressionStream("deflate-raw")`, pass method-0 through.
   `Bun.Archive` does NOT work here — probed with bytes / `Bun.file` / path, all
   `Unrecognized archive format` (it accepts tar/tgz only). Do not retry it.
2. Build a deck covering **all five** diagram types from `vendored/examples/`.
3. Per `ppt/slides/slideN.xml` assert:
   - `<a:blip>` count **=== 0** — the load-bearing assertion,
   - `<a:sp>` count **>= that slide's ShapeIR node count**,
   - every ShapeIR `text` string appears in the XML.

## Acceptance

- All five types pass.
- Deliberately swapping one shape back to `addImage` in a scratch copy makes the blip
  assertion fail (verify the test can actually fail before calling it done).

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
