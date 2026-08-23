---
effort: 2026-08-23-file2md-vision-extraction
created: 2026-08-23
last: 2026-08-23
status: complete
---
# file2md-vision-extraction — make the optional vision layer usable and non-reasoning

## Destination

`s2-agent-ext-file2md`'s `mode: vlm` becomes *actually usable and predictable*: (1) a
vision root-cause bug in the per-page VLM path is fixed so content is never silently
emptied; (2) the provider catalog pre-wires a **non-reasoning vision model** mechanism so
that the moment a genuinely no-thinking VLM is available, `capabilities.vision` uses it and
the server stops burning reasoning tokens; (3) the caption-only figure-page gap (the real
content loss on a fully-text-layer spec) is documented honestly with the exact trigger rule,
so an agent reading a converted USB4 spec knows when vision is required.

## Context (measured 2026-08-23 on this machine, bun 1.4.0, LM Studio `:1234`)

- **The USB4 spec is 100% text-layered. `mode: vlm` never fires on it.** `USB4
  Specification 2.0 - CLEAN.pdf` → 839 pages, **all `provenance: text`**; every page body
  (after frontmatter) > 20 chars. The pipeline only triggers vision/OCR when a page's text
  layer is < `OCR_TEXT_MIN_CHARS` (8) — no page qualifies, because every caption-only figure
  page still carries its caption text. Same for DVSEC (14p) and Connection Manager (96p):
  all `text`.
- **The real content loss is the caption-only figure pages.** Of 839 pages, 31 are < 900
  bytes; e.g. `page-269` body = `Figure 4-42. PRTS19 Pattern Generator` (the actual diagram
  is a vector drawing the text layer cannot capture), `page-096` / `page-105` = CTLE /
  transmitter-equalization figure captions with the plots missing. **These are the pages an
  agent reading the converted spec actually wants described — and vlm never visits them.**
- **The only working vision model is `qwen/qwen3.8-27b`.** `google/gemma-4-12b` fails to
  load on LM Studio (`HTTP 400 "Failed to load model"`). `/v1/models` lists both, but only
  qwen serves.
- **"No think mode" is NOT achievable with the installed models.** Measured against the live
  server (single trivial text ask, `max_tokens=50`):
  - baseline: **5.3s / 50 reasoning tokens**
  - `chat_template_kwargs.enable_thinking=false`: **12.9s / 183** (flag ignored, *more*
    reasoning)
  - top-level `enable_thinking=false`: **4.9s / 49**
  - `reasoning={effort:"none"}`: **8.7s / 110**
  Every path still burns reasoning tokens. Both installed vision-capable models (qwen3.8-27b,
  gemma-4-12B) have `enable_thinking` in their chat templates and default it ON. Confirms
  `bun-apps/s2-agent/src/pre-load-providers.ts:119-126` — *"LM Studio's MLX server serves
  Qwen 3.8 as an always-on reasoning model … it ignores client-side thinking knobs."*
- **The `reasoning:false` catalog flag is host metadata, not a server instruction.** The
  pi-ai `openai-completions` adapter only emits a thinking-disable signal inside branches
  gated on `model.reasoning` (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:564-661`).
  A `reasoning:false` entry makes pi *treat* the model as non-reasoning but sends **no**
  disable instruction, so the server keeps its server-side default (thinking ON).
- **The genuine, reachable root-cause symptom is a too-low `max_tokens` truncation.** Raw
  test on one figure page: at `max_tokens=1000` the always-on reasoning burn (2059 tokens)
  consumed the output budget → **empty `content`** with `finish_reason: length` (the
  documented "strange message"). At `max_tokens >= 2000` the same page returns good content
  in ~89s with ~728 reasoning tokens. The file2md path resolves the model from the catalog
  whose `maxTokens: 65_536`, so the *shipped* CLI is **not** affected — the empty-content
  case is a per-call-opt footgun in the vision primitive, not a shipped-config bug.
- **VLM is an opt-in layer and the default `resolveVisionLLM({})` thinking is already `off`**,
  but "off" has no effect because the server ignores it. `capabilities.vision` =
  `lm-studio/qwen/qwen3.8-27b` (seeded `~/.pi/workflows/model-tiers.json`, default from
  `pre-load-providers.ts` §3).

## Tickets

- `tickets/01-vision-max-tokens-guard.md` — **open** — make `runVisionInference` / the VLM
  prompt carry a non-truncating `max_tokens` (from the model's registered budget) and add the
  empty-content guard: if content comes back empty with `finish_reason: length`, retry/raise
  l ow-level so a vision call never silently yields an empty page (OCR-degrade fallback stays).
- `tickets/02-non-reasoning-vision-model-id.md` — **open** — register a sibling
  non-reasoning vision model id in `pre-load-providers.ts` and pre-wire the sibling-id
  mechanism (catalog-only, no `thinking` flag path), so `capabilities.vision` points at it the
  moment a genuinely no-thinking VLM is loaded; keep the working qwen fallback.
- `tickets/03-caption-figure-page-gap.md` — **open** — document the caption-only figure-page
  loss (the measured spec gap) with the exact trigger rule + when vlm/ocr is required; add an
  advisory note in the file2md SKILL/completion checklist.

## Decisions

- **D1 — no `thinking:off` flag, no `reasoning:false` sibling-config claim.** Verified
  falsified on this server: neither the client knob nor a `reasoning:false` catalog id stops
  the MLX server burning reasoning. The catalog change is real but must be described as
  *pre-wiring for a future non-reasoning model*, not as a live disable.
- **D2 — the reachable shipped bug is the max_tokens truncation footgun**, not the always-on
  reasoning. Fix the vision primitive so a too-low budget can never silently empty a page.
- **D3 — the figure-page gap is a documentation + advisory trigger, not an auto-vision
  heuristic.** Auto-triggering vlm on every caption-only page would force a ~90s LM Studio
  round-trip per image, which is the wrong default for a 31-page set; surface it and let the
  caller opt in (`--extract vlm --pages <figure pages>`).

## Execution order

1. **Ticket 01 — vision max-tokens guard** (shippable now; the shipped correctness fix).
2. **Ticket 02 — non-reasoning vision model id** (catalog pre-wire; mechanism + tests now, live
   activation blocked on a non-reasoning model being loaded — not a blocker for 01/03).
3. **Ticket 03 — caption figure-page docs** (informational; independent of 01/02).

Choice pairs: 01 → 03 is order-agnostic (different files, no dependency); 02 is the only one
with an external blocker (a non-reasoning VLM being installed), so it ships its mechanism and
tests regardless.

## Frontier

cleared — all three tickets closed 2026-08-23 and shipped in PR #1913
(`06bf6006`, squash, verdict **CLEAN**, `branchSpent: true`). Delivered:

- **Ticket 01 (empty-output guard)**: `runVisionInference` gains a
  completed-but-empty guard (`emptyIsError`); `explainPage` + `vision_ask` opt in; a
  reasoning-truncated call now degrades (OCR) instead of writing a blank page. +7 tests.
- **Ticket 02 (non-reasoning id pre-wire)**: `qwen/qwen3.8-27b-nothink`
  (`reasoning:false`) registered in the catalog as the `capabilities.vision` selection
  target once a genuinely no-thinking VLM is loaded; working qwen stays the default.
- **Ticket 03 (caption-page docs)**: SKILL + architecture doc the caption-only figure-page
  trigger rule (`--extract vlm --pages <list>` opt-in).

Follow-up: **s2-agent version bump `0.3.0 → 0.4.0`** (minor, host-contract catalog change)
committed and pushed as a separate PR (`file2md-version-bump` branch).

## Fog of war

- **No non-reasoning vision-capable model is installed.** Both installed VLMs are
  always-on-reasoning. Completing ticket 02's intent (a live non-reasoning `capabilities.vision`)
  requires an LM Studio model download outside the repo; the ticket ships the catalog
  mechanism + tests, not the model.
- **`gemma-4-12b` is unloadable on this machine** (400) — pre-wiring its sibling id is untestable
  live.
- Whether LM Studio *can* disable thinking at the model-session level (a server-side toggle,
  not a client param) is unprobed.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-23-file2md-bun-only-redesign` (the v2 bun-only vision
  tier, `src/vlm/*`, `capabilities.vision` wiring) — this effort hardens that VLM tier.
- **Shares-decision-with**: `.planning/2026-08-21-vision-tier-centralization` — both keep
  exactly one resolution leaf for vision (`resolveModelRole` / `capabilities.vision`); this
  effort does not add a second, it only adjusts what the leaf points at and how the VLM call
  is budgeted.
- **Shares-decision-with**: `.planning/2026-08-22-context-lifecycle` — the "one leaf per
  concern, no extension hardcodes" rule; a non-reasoning vision id must be a catalog entry,
  never a file2md hardcode.
