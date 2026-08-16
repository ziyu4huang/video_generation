# Ticket 04 — hermes orchestration (blocked-by: [02])

Goal: Batch build hook in hermes walk-and-ingest.

Scope: post-ingest phase (fire-and-forget, vector-backfill pattern): gather cards+entities via seam, inject embedFn (card_vectors/cache path, skip when unavailable) + summarizeFn (llm-chat with per-layer token budget), call zk buildLayer loop with checkpoints; DEVOPS-free config knob (hierarchyEnabled default on, env override).

Acceptance: e2e — ingest fixture corpus → tree built with N layers; surreal-down → skip clean; kill-mid-build → resume completes.
