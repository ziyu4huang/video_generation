---
type: task
blocked by:
  - "04"
claimed: pi-agent (test/docs)
status: closed
resolved: 2026-08-05
---

## Question

Add the test and update docs (Task: this does the build).

- **Test** `bun-apps/pi-agent-ext-archify/__tests__/deck.test.ts`: run the builder on a 2-slide fixture manifest → assert the output is a valid OOXML zip containing `ppt/slides/slide1.xml` + `slide2.xml` and ≥2 `ppt/media/*` images. Gate the browser launch behind `ARCHIFY_DECK_TEST_BROWSER=1` so browserless CI can skip; runs locally by default. Follow `test-driven-development`.
- **Docs:** update the archify README and the design spec (`docs/2026-08-03-deck-design.md`) to describe `bun run deck`, the manifest schema, and the example.

Resolved when `bun test` passes and docs describe the command. Record the test file path + any browser-gate caveat as the answer.

## Resolution (2026-08-05)

- **`__tests__/deck.test.ts`** — 5 `parseArgs` unit tests (default/positional manifest, `--theme`/`--output`, bad `--theme`, unknown flag) + 1 browser-gated integration test. Integration spawns the builder on a 2-slide fixture (`mini.architecture` + `agent-run.lifecycle`) and asserts a valid OOXML zip: `PK\x03\x04` magic + `ppt/slides/slide1.xml`+`slide2.xml` + >=2 `ppt/media/*` (entry names grepped from the uncompressed central directory — no `unzip` dep).
  - Gate: `const RUN = process.env.CI ? process.env.ARCHIFY_DECK_TEST_BROWSER === "1" : true;` -> runs locally by default, CI opt-in.
- **Refactor:** `scripts/deck.ts` now exports `parseArgs` and guards `main()` with `if (import.meta.main)` so the test imports it without side effects.
- **Docs:** README gains a "Deck builder (`bun run deck`)" section; design spec annotated "approved + implemented".
- Verification: `bun run typecheck` **TSC_EXIT=0** (real exit, unmasked); `bun test` **55 pass / 0 fail** (6 new deck tests; integration 1.18s).

Note: caught + fixed a latent `noUncheckedIndexedAccess` typecheck failure that ticket-04 verification had masked via a `| tail` pipe (the pipe's exit hid tsc's non-zero). Lesson captured to memory.
