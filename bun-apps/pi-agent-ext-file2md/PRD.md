# PRD — pi-agent-ext-file2md

## Problem

Pure-text agents cannot read binary/visual input files — a PDF page or image
is opaque to them. To work with such files they need them converted to
structured Markdown they can actually parse. The conversion must happen locally
(a vision-LLM subagent rasterizes PDF pages, describes each via a vision
language model, and stitches the result into Markdown with frontmatter +
per-page sections) and drop into a project-local vault for ingestion. The agent
also needs a lightweight way to ask a single ad-hoc question about one image
without running the full pipeline.

## Solution

A file→Markdown bridge for Pi, powered by a vision-LLM subagent. The `file2md`
tool rasterizes PDF pages (or directly reads images), classifies the document
profile (paper/slides/poster/diagram/image), describes each page via LM Studio
serving a local vision model (e.g. Qwen3-VL or Gemma), and writes structured
Markdown with frontmatter + per-page sections that a pure-text agent can read.
Resumable pipeline with caching and retry for transient errors. A second,
lighter tool (`vision_ask`) exposes the single-image Q&A primitive so the agent
can interrogate one image inline.

## Architecture

```
input (pdf|image)
  │
  ├─ classifyKind()        MECHANICAL  magic bytes → "pdf" | "image"      [local]
  ├─ rasterizePdf()        pdf2image CLI → fallback PDFKit (Swift)       [local]
  ├─ classifyProfileViaVlm()  VLM subagent on page 1 → profile token     [1 VLM call]
  └─ for each page:
       explainPage()       VLM subagent (profile system prompt + image)  [1 VLM call/page]
                          → frontmatter + ![[png]] + body markdown
  ⇒ manifest.json (resumability) + <slug>.md (MOC index note)
```

Two VLM "subagents" (single-turn, disposable pi-agent sessions):
- **Classifier** (`classify-vlm.ts`) — looks at page 1, emits exactly one
  profile token. Fast, cheap, constrained output.
- **Page explainer** (`agents.ts`) — per-profile system prompt turns one page
  image into Obsidian markdown. Output is post-processed by `normalizeEmbeds`
  + `normalizeFrontmatter` to repair recurring model defects.

A third primitive, `askImage` (`ask.ts`), is a bare "ask one question about
one image" helper — generic, not describe-specific. It is already consumed by
`pi-agent-ext-flux2` (image gate verification) but is **not yet exposed as a
tool** (see roadmap T1).

## Exposed surface

### Tools (agent-callable)
| Tool | Description |
|------|-------------|
| `file2md` | PDF/image → structured Obsidian markdown via local LM Studio VLM (full pipeline, writes to disk). Supports `--extract vlm|text|hybrid` strategy (default: `vlm`); `text` uses mupdf text-layer extraction (no VLM, figures lost), `hybrid` uses mupdf text + VLM on figure-bearing pages only. |
| `vision_ask` | Ask one question about one image; returns the answer inline (no disk pipeline). Lightweight single-image Q&A wrapping the `askImage` primitive. |

### Library API (consumed by other packages)
`runVlmDescribePipeline`, `DEFAULT_VLM_MODEL`, `classifyKind`,
`classifyProfileViaVlm`, `explainPage`, `askImage`, `resolveLLM`,
`slugify` / `layoutFor` / `loadManifest`, `withRetry`, `rasterizePdf`.

Consumers today: `pi-agent` (`file2md` + `pdf-to-vault` commands),
`pi-agent-ext-flux2` (`askImage` for gate verification).

## Key Dependencies

- LM Studio (serving a vision model at `http://localhost:1234/v1`)
- `mupdf` (npm, Artifex — AGPL-3.0 licensed. Accepted for this internal tool; distribution gate applies if file2md is ever redistributed externally)
- `pi-agent-ext-obsidian` (vault output)
- `pi-agent` (hosts file2md command)

## Use

```bash
pi -e bun-apps/pi-agent-ext-file2md
# Then: file2md({input: "paper.pdf"})
# Or CLI:
bun bun-apps/pi-agent/src/cli.ts cli file2md paper.pdf
```

---

## Quality improvement roadmap

> **Status (2026-07-11):** P0 + P1/P2 items are **implemented** on branch
> `feat/vlm-tool-subagent-quality` (S2 quality gate, T1 `vision_ask` tool, S1
> cross-page context, T2 parallel pages, S3 few-shot, T3 lang/mode, S4 vote
> classification) — 162 deterministic tests. This section is retained as the
> design record; the reactive `normalize*` repairs remain as a safety net.

The extension is correct and well-tested on its deterministic core, but the
**tool surface is narrow** and the **VLM subagents leave coherence and
reliability on the table**. This section is the prioritized plan to raise
tool + subagent quality. Priorities: **P0** = highest leverage, ship first.

### Tool quality

#### T1 — Expose `vision_ask` as a tool  (P0)
`askImage` is already battle-tested (flux2 image gate) but only reachable as a
library import. Agents have no way to ask a quick question about one image
without launching the full describe pipeline. Wrap it as a `vision_ask` tool:
`{image, question, systemPrompt?, model?}` → inline text answer.

- **Why:** turns an in-use primitive into a first-class agent capability;
  cheap to add (the function exists), high composability payoff.
- **Acceptance:** `vision_ask` registered, documented, with a deterministic test
  (mocked session) covering the question→reply path and error case.

#### T2 — Parallel page extraction with a concurrency cap  (P0)
`file2md` processes pages strictly sequentially. A 20-page paper = 20
serial VLM calls. Extract pages concurrently with a small cap (default 3–4,
env-tunable `PI_VLM_CONCURRENCY`), preserving manifest write order and
resumability guarantees.

- **Why:** near-linear speedup on the dominant cost (per-page VLM latency).
- **Acceptance:** pages complete out of order but manifest stays consistent;
  resumability still skips only non-`done` pages; concurrency env-knob tested.

#### T3 — Lighter describe controls  (P1)
Optional params to avoid hardcoded behavior: `lang` (output language, default
`zh-TW`), `mode` (`summary` | `verbatim` | `hybrid`), so callers aren't locked
to the current 繁中 summary style. Pass-through to the profile prompts.

### Subagent quality

#### S1 — Cross-page context for multi-page docs  (P0, biggest quality lever)
Today each `explainPage` call is a fresh session with **only that page's
image** — page 5 cannot see the title/abstract/section from page 1, so
coherence, term consistency, and reference resolution all degrade. Feed a
small rolling context into each page call: doc title, running section, and a
shortlist of key terms / acronyms extracted from earlier pages.

- **Why:** the single biggest determinant of multi-page extraction quality;
  isolation is the root cause of inconsistent naming and lost references.
- **Acceptance:** a `PageContext` accumulator threads title/section/terms
  across pages within one doc; unit-testable (no model needed); opt-out flag
  for the single-image path where it does not apply.

#### S2 — Output quality gate before marking "done"  (P0)
A page is marked `done` whenever the VLM returns non-empty text — even if the
frontmatter is unparseable, the `![[png]]` embed is missing, or the body is a
two-token hallucination. Add a deterministic `validatePageMarkdown()` gate:
frontmatter parses (and has `title`/`page`/`kind`), the embed line is present,
body length above a floor. Gate failure → counts as retryable within the
existing `withRetry` loop.

- **Why:** converts silent garbage into caught-and-retried failures; the gate
  itself is pure and unit-testable (extends the deterministic test surface).
- **Acceptance:** `validatePageMarkdown` tested for pass + each failure mode;
  pipeline only writes `done` on a passing page; manifest records gate
  failures as the retry reason.

#### S3 — Few-shot example in profile prompts  (P1)
The profile system prompts describe the desired shape in prose, then
`normalizeEmbeds` / `normalizeFrontmatter` patch up the recurring ways the
model gets it wrong (stray angle brackets, unclosed frontmatter). Add one
canonical input→output example per profile so the model sees the exact shape.
Goal: **prevent** defects rather than repair them (and eventually retire some
of the reactive normalization).

- **Why:** few-shot is the cheapest prompt-level lever for format adherence.
- **Acceptance:** each profile prompt carries a compact example; the existing
  `normalize*` tests still pass (they remain as a safety net, not primary).

#### S4 — Smarter classification + hint honoring  (P2)
Classification reads only page 1. Documents whose first page is atypical
(cover, branding, a figure) get mis-profiled. Options: sample 2–3 pages and
majority-vote, and/or surface classifier confidence. Lower priority because
`--type` already lets the caller force a profile.

### Engineering / hygiene (background, not blocking)

- **De-fork `sessions.ts`** — it duplicates `pi-agent`'s
  `src/cli/sessions/shared.ts` (`resolveLLM`/`resolveModel`/session wiring). Extract
  the model-resolution + session-factory primitives into a neutral shared
  module both consume, then delete the fork. Until then, any model-id grammar
  fix must be applied in two places (pinned by `sessions.test.ts`).
- **Extend deterministic test coverage** to the new pure functions this
  roadmap introduces (`validatePageMarkdown`, `PageContext` accumulator,
  `vision_ask` wrapper) — they are exactly the kind of pure logic the existing
  suite excels at, and they raise quality without needing a live model.

## Non-goals

- Replacing LM Studio with a different inference server (out of scope; the
  `resolveLLM` abstraction already allows swapping the model/provider).
- Multi-document cross-referencing (each input is processed independently).
- Real-time / streaming UI (the tool reports progress via `console.error` +
  optional NDJSON `emit`; richer UX belongs in the GUI host, not here).
