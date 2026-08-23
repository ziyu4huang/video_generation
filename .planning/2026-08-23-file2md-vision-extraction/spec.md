# Spec — file2md: usable, non-reasoning vision extraction

> STATUS: drafted 2026-08-23. Every runtime claim in §2 was **probed on this machine**
> (bun 1.4.0, LM Studio `:1234`, `qwen/qwen3.8-27b`). Raw numbers in `map.md` § Context.
> Verified against `bun-apps/s2-agent-ext-file2md` at the effort's base commit.

## §1 Goal

Make `s2-agent-ext-file2md`'s optional vision layer (`mode: vlm`) **usable and honest** —

1. A vision call can never silently yield an empty page; the always-on-reasoning truncation
   footgun is fixed at the primitive that all VLM page extraction flows through.
2. The provider catalog pre-wires a **non-reasoning vision model** mechanism so the moment a
   genuinely no-thinking VLM is loaded, `capabilities.vision` uses it and the server stops
   burning reasoning tokens — without touching the working `qwen/qwen3.8-27b` fallback.
3. The caption-only figure-page loss (the measured USB4 spec gap) is documented with its exact
   trigger rule, so an agent reading a converted text-layer spec knows exactly when vision is
   required and how to opt in.

**Non-goals** (explicit, YAGNI): making `mode: vlm` auto-fire on every caption-only figure
page (a ~90s/img LM Studio round-trip is the wrong default for a per-image cost); providing a
live non-reasoning model (requires an LM Studio download outside the repo); changing the
deploy inclusion policy for file2md; touching the text/OCR tiers.

## §2 Background (measured, not quoted)

### 2.1 The shipped vision model resolves to an always-on-reasoning model

`capabilities.vision` in `~/.pi/workflows/model-tiers.json` resolves to
`lm-studio/qwen/qwen3.8-27b`. That model is registered `reasoning: true` in
`pre-load-providers.ts` and, verified live, **always** burns reasoning tokens on the LM Studio
MLX server. For a trivial text ask at `max_tokens=50`:

| request | time | reasoning tokens |
|---|---|---|
| baseline | 5.3s | 50 |
| `chat_template_kwargs.enable_thinking=false` | 12.9s | 183 |
| top-level `enable_thinking=false` | 4.9s | 49 |
| `reasoning={effort:"none"}` | 8.7s | 110 |

Every path still burns reasoning. This matches the in-repo comment
(`pre-load-providers.ts:119-126`): *"LM Studio's MLX server serves Qwen 3.8 as an always-on
reasoning model … it ignores client-side thinking knobs."*

### 2.2 The real reachable defect — a truncation footgun

One figure page, raw query: at `max_tokens=1000` the ~2000-token reasoning burn consumed the
entire output budget → **empty `content` with `finish_reason: length`**. At `max_tokens >=
2000` the same page returns good content (~89s, ~728 reasoning tokens). The shipped file2md
CLI resolves the model's `maxTokens: 65_536`, so it is **not** affected; the empty-content
case is a per-call-opt footgun in the vision primitive (`runVisionInference`) that a caller
or tool override could hit.

### 2.3 The `reasoning:false` flag is host metadata, not a server instruction

The pi-ai `openai-completions` adapter (`dist/api/openai-completions.js:564-661`) emits a
thinking-disable signal only inside branches gated on `model.reasoning`. A `reasoning:false`
entry makes pi *treat* the model as non-reasoning but sends **no** disable instruction, so the
server keeps its default (thinking ON). Config alone cannot fix this on this server.

### 2.4 The figure-page gap is real and unvisited

The 839-page USB4 spec is 100% text-layer, so `vlm` never fires on it. But 31 pages are
caption-only (< 900 bytes): e.g. `page-269` = `Figure 4-42. PRTS19 Pattern Generator`; the
actual diagram is a vector drawing not in the text layer. These are the pages worth
describing, and the pipeline never visits them.

## §3 User stories

- As a **text-only agent** converting a born-digital spec, I want every page body to be
  meaningfully populated, so I never read an empty page from a vision call.
- As the **file2md caller** doing `--extract vlm`, I want a too-small output budget never to
  silently empty a page, so the result is trustworthy or explicitly degrades to OCR.
- As the **operator** who has loaded a non-reasoning vision model into LM Studio, I want
  `capabilities.vision` to use it (no thinking burn), so vision extraction is fast and cheap.
- As the **agent** reading a converted USB4 spec, I want the caption-only figure-page loss
  flagged, so I know which pages to re-run with vision and which need a diagram-aware path.

## §4 Implementation decisions

- **D1 — max-tokens guard in `runVisionInference`.** The single seam
  (`bun-apps/s2-agent-ext-file2md/src/vlm/vision-inference.ts`) that all VLM page extraction
  flows through. Add a bounded-but-sufficient `max_tokens` from the resolved model's registered
  budget (never below a floor, e.g. ≥ 2000) and a guard: on empty content with a length
  finish, surface it (retry once at a higher budget, else `ok:false` so the pipeline OCR-
  degrades) rather than returning an empty page silently.
- **D2 — sibling non-reasoning id in the catalog.** `pre-load-providers.ts` §1 `lm-studio`
  `models[]` already supports multiple entries per provider. Add a sibling entry
  (e.g. `qwen/qwen3.8-27b-vl` or a genuinely non-reasoning id when one exists) with
  `reasoning: false` and the same `input: ["text","image"]`, and document that
  `capabilities.vision` should point at it when a no-thinking VLM is loaded. Catalog-only; the
  `HOW TO ADD A PROVIDER` contract applies.
- **D3 — caption page advisory.** Do **not** auto-trigger vlm on every caption page. Add an
  advisory note to `skills/file2md/SKILL.md` + the completion checklist: a page whose body is a
  bare `Figure N-x. …` caption (or < 900 bytes) is a caption-only figure page — the diagram is
  not in the text layer; re-run with `--extract vlm --pages <list>` (or `--type` image) to
  describe it. Precision over auto-cost.
- **D4 — one resolution leaf.** All model resolution stays in
  `s2-agent-core-runtime`'s `resolveModelRole` / `capabilities.vision`; the new id is a catalog
  entry, never a file2md hardcode (`.planning/2026-08-21-vision-tier-centralization` D1).

## §5 Testing decisions

- **Regress the max-tokens guard at the primitive.** A unit test around `runVisionInference`
  (mock the child result) asserting that a too-low budget returns `ok:false` (or retries) with
  a non-empty error, never an empty `output` with `ok:true`. Tests the *external behavior*
  (no silent empty page), at the highest existing seam, prior art = `src/vlm/*.test.ts`.
- **Catalog sibling id is asserted by `pre-load-providers.test.ts`** (the existing multimodal
  assertion file): the non-reasoning id is present, `reasoning:false`, `input` includes
  `image`. No live-server test needed.
- **No new regression on the base suite**: the package's canonical `bun run test`
  (196 pass / 0 fail baseline), `bun run check`, `bun run typecheck` stay green.

## §6 Out of scope

Providing or downloading a non-reasoning VLM; changing the deploy inclusion policy; the
`--extract vlm` auto-fire heuristic on caption pages; the text/OCR tiers; the
figure-page *content* (the diagram itself) — that is an image-rendering concern beyond this
effort.

## §7 Further notes

- The base package test suite is green (196 pass / 0 fail) — measured, not assumed.
- The runtime default thinking for `resolveVisionLLM({})` is already `off`; the change is at
  the call-budget + catalog level, not the thinking flag (which is powerless here).
