# 06 — session commit → extraction loop

type: grilling
blocked by: 04 (extraction writes typed cards)

## Question

OpenViking's "sessions become memory" loop is the thing that beats native agent memory on LoCoMo: session commit → async summary + memory extraction → LLM dedup decisions (`skip/create/none` + per-item `merge/delete`) against similar existing memories → `memory_diff.json` audit trail.

kcard already has adjacent machinery: hermes journal ingest (`adaptHermesMarkdown`), distill gate/converge (adaptive threshold), `supersede.ts`, dictionary+LLM relation extractors. Questions:

- Is the loop: hermes journal (capture-only per context-lifecycle D1) → distill converge → **new** extraction pass producing typed cards with dedup-merge? Or does distill converge get upgraded to be the extraction loop?
- Dedup-merge: OpenViking asks an LLM `skip/create/merge/delete` per candidate against similar existing cards. kcard's dedup-first LeanRAG port is deterministic (frequency-vote). Which lane decides merge/delete — deterministic near-dup signal first (LeanRAG), LLM only on the ambiguous band? (Note leanrag-simplify D8 removed near-dup 0.3/signature mechanisms — don't resurrect them silently.)
- Audit trail: memory_diff equivalent — a per-run diff artifact (goes in vault as derived md? gitignored output/?).
- Async model: OpenViking queues on commit. kcard's trigger surface — on hermes distill converge, on-demand `zk_ingest` action, or a scheduled lane?
