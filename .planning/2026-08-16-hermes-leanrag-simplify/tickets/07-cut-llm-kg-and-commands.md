---
ticket: 07
status: done
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

## Resolution

CUT (D5): LLM kg extractor path — hermes no longer passes kgLlm/kgLlmModel across the zk seam (zk dictionary extractor = sole path, byte-identical to kg.llm=OFF per kp-03 D1/D3; zk package untouched). CUT interview + insights commands (+tests). KEPT switch-backend (recovery infra post-ticket-05).
