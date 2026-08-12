# pi-agent-ext-file2md

The ubiquitous language of pi-agent-ext-file2md — a file→Markdown bridge that gives a pure-text agent eyes. PDFs are rasterized page by page, each page is described by a local vision-LLM subagent, and the pages are stitched into one `.md` dropped into a project-local vault. The agent never has to "see" the file.

## Language

### The bridge

**file2md**:
The file→Markdown bridge (`<files...>` → Markdown) — the pi tool and CLI entry point.
_Avoid_: converter, parser, OCR (it is a VLM-described Markdown bridge, not a text extractor)

**Pure-text agent**:
The design intent — the consuming agent is text-only; file2md gives it eyes so it never has to "see" a binary file. The reason the bridge exists.
_Avoid_: text agent, blind agent (it is the text-only consumer the bridge serves)

### The pipeline

**Rasterize**:
PDFs are converted to page images (one per page) before description. Images skip this step.
_Avoid_: render, convert (it is PDF→page-image rasterization specifically)

**Per-page description**:
Each page image is described by the vision-LLM subagent independently — the unit of VLM work.
_Avoid_: summary, OCR (it is a VLM page description, not text extraction or summarization)

**Stitch**:
The per-page descriptions are assembled into one `.md` with frontmatter + per-page sections, then dropped into a project-local vault.
_Avoid_: merge, concatenate (it is structured assembly with frontmatter + sections)

**Resumable pipeline**:
Per-page VLM output is cached, and transient errors (429 / network) are retried — so an interrupted run resumes from the last cached page instead of restarting.
_Avoid_: cache, checkpoint (it is a cached + retrying pipeline, not a store)

### The vision model

**Vision-LLM subagent** (VLM):
The local LM Studio vision model that describes each page. Its resolution (`resolveLLM` / `resolveModel`) is forked from pi-agent's shared helpers.
_Avoid_: vision API, OCR engine (it is a local vision-LLM subagent, not a service or extractor)

**Shared VLM subagent**:
file2md's VLM subagent is reused by flux2 and ltx (scenePipeline VLM verification, etc.) — one shared local-vision client across packages, not a per-package one.
_Avoid_: VLM client, vision tool (it is the shared subagent downstream packages call)

### Text extraction strategies

**Text-layer extraction**:
Direct text extraction from PDF's embedded text layer using mupdf — the `--extract text` path. Fast, pure-text, but loses figures and visual content.
_Avoid_: OCR, text dump (it is native PDF text-layer extraction, not image-to-text OCR)

**Text-as-prior**:
Feeding extracted text into the VLM as a prior context so it describes figures and renders equations without re-describing the already-captured body text — used by the `--extract hybrid` path on figure-bearing pages.
_Avoid_: VLM-only, full describe (it is text-prior-augmented figure description, not a fresh page description)

**Figure-bearing page**:
A page identified via a text-density heuristic (low character count per area) as likely containing figures/diagrams — the route to VLM in `--extract hybrid` mode.
_Avoid_: pdfimages, image list (it is a heuristic detection applied during hybrid extraction, not a separate image-extraction step)
