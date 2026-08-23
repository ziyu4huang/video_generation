---
status: done
blocking: []
---
# 04 — kgLlmModel config-file parsing
Spec: D5. Anchors: zk ingest.ts:201 (`opts.kgLlmModel ?? process.env.PI_KG_LLM_MODEL`), bun-apps/tests/config-parity.test.ts (~:57 — notes kgLlmModel "deferred — carried via IngestOptions, not loadConfig").
## Work
Carry kgLlmModel through the existing loadConfig path (config file), final precedence IngestOptions > config file > env PI_KG_LLM_MODEL. Update config-parity.test.ts: replace the deferral note with coverage asserting the parity (config key parsed, precedence order).
## Acceptance
- config-parity test updated and green from bun-apps/ (`bun run test` or scoped equivalent).
- zk + hermes tests green; no schema-cost impact (no tool surface change).

## Resolution
- `kgLlmModel` carried via hermes `loadConfig` (MemoryConfig field, trim-guarded); precedence call-opts > config file > env `PI_KG_LLM_MODEL`, with the zk `ingest.ts` env fallback remaining terminal.
- config-parity allowlist updated atomically with the code change.
- 110-line precedence test added (`src/config-kg-llm-model.test.ts`); hermes 1627/0 + config-parity 2/0 green.
