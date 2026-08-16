---
ticket: 07
status: open
blocked-by: [01]
---

## Goal

CUT the LLM kg extractor path (`kg.llm`) plus the interview/insights/switch command handlers (user-approved D5).

## Scope

- Keep dictionary extractor only — semantics byte-identical to `kg.llm=OFF`.
- Remove the handler code and its tests.

## Acceptance

- kgllm test file removed.
- Ingest outputs unchanged on the corpus fixture.
