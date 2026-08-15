# 01 — Convergence mechanism

## Question

How should file2md output become knowledge cards?

## Resolution

**Closed during the charting grill (2026-08-01).**

Deterministic `zk_ingest source:generic` over the conversion output (`./vlm-out/<slug>/`).
Zero-token, idempotent — the `generic` adapter derives canonical id `generic:<slug>` from the
H1/filename, and `ingestRecords` dedups 1:1 by canonical id (re-converging the same doc is a
no-op). One card per `.md`, tags harvested from frontmatter / `#hashtags` / `[[wikilinks]]`.

This mirrors hermes' deterministic convergence and the PRD principle "deterministic is the
convergence sink." LLM `obsidian_distill` stays a **manual opt-in** for high-value docs (not
auto-converged) — rejected as the default for being token-expensive and non-idempotent.

**Facts verified at chart time**: `adaptGenericMarkdown` → `id: generic:${slugify(titleSlugSrc)}`
(`src/ingest.ts:713`); `ingestRecords` dedups by canonical id (`src/ingest.ts` header comment).
