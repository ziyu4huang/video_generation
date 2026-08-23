# Ticket 01 — vision: never silently empty a page (max-tokens / finish guard)

- **Engineer:** task
- **Depends on:** none
- **Status:** closed

## Context

`runVisionInference` (`bun-apps/s2-agent-ext-file2md/src/vlm/vision-inference.ts:47-108`) is the
single seam every VLM page call flows through. Measured on the live LM Studio `:1234` with
`qwen/qwen3.8-27b`: the model is **always-on-reasoning** and burns ~2000 reasoning tokens
first. Verified that at a low output budget (`max_tokens=1000`) the reasoning burn consumes the
entire budget and the request returns **empty `content` with `finish_reason: length`** — a
silent empty page. The shipped CLI is safe only because the catalog registers the model at
`maxTokens: 65_536`; a per-call override (tool param) or a custom `modelRuntime` model with a
low budget is vulnerable.

The current `runVisionInference` returns `{ output, ok: !result.failure }` with no guard: if
`result.failure` is null but `output` is `""` (the reasoning-truncation case), it reports
`ok: true` with an empty string — the pipeline then treats it as a valid extraction and, in
`extractPdfPage` (`pipeline.ts:376-387`), the `validatePageMarkdown` check **rejects** it
(empty body fails the `minBodyChars` floor) and OCR-degrades. So the *pipeline* does not emit
an empty page, **but** it burns a whole 90s LM Studio round-trip against nothing, and the
`vision_ask` tool (`extensions/file2md.ts:290-318`, a direct `askImage` consumer) has **no**
such guard — it returns `ok:true` with `reply:""` on the same footgun.

## Done-when

- [x] `runVisionInference` distinguishes **empty-output-due-to-truncation** from a genuine
      empty reply: returns `ok:false` with an actionable error (never `ok:true` + `""`).
- [x] `vision_ask` / `askImage` surface that as an `isError` (or explicit empty-reply message)
      rather than a bare empty content string.
- [x] A unit test reproduces the guard at the primitive: a stub child returning empty output
      with no failure ⇒ `ok:false` + error (or documented retry), never `ok:true` + `""`.
- [x] The package's canonical `bun run test` stays green (196 → 203 pass / 0 fail baseline),
      `bun run check` (exit 0) + `bun run typecheck` clean.

### Verification (2026-08-23)

- `bun test __tests__/vision-inference-guard.test.ts` → 7 pass / 0 fail.
- `bun run test` → 203 pass / 0 fail (was 196 baseline; +7 new).
- `bun run typecheck` → clean. `bun run check` → exit 0 (warnings are pre-existing or
  match the package's accepted non-null-assertion pattern in `ask-io.test.ts`).

## Scope / verification

Add the guard in `src/vlm/vision-inference.ts` (the seam) and confirm its consumer contract in
`pipeline.ts` (`extractPdfPage`, `explainPage`) and `extensions/file2md.ts` (`vision_ask`) +
`src/vlm/ask.ts`. Because the shipped path uses the catalog's 65_536 budget, the regression is
best proved by a unit test at the primitive, not a live-server test.

## Notes

- Do **not** claim a "no-think" fix here — verified falsified on this server (see map Context).
  This ticket is strictly the budget/empty-result correctness guard.
