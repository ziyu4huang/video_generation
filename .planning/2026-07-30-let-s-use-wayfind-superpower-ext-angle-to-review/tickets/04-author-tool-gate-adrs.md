## Question

Author ADRs for tool-gate's architectural decisions — today they live only in
scattered specs/plans (`docs/superpowers/specs/2026-07-20-tool-gate-s1-*` etc.),
not as durable decisions, so the rationale is easy to lose. Land them in
`bun-apps/pi-agent-ext-tool-gate/docs/adr/` (the wayfind/superpowers convention).

**ADRs to write (pull from the existing specs/plans):**
- **S1 — escape hatch:** the always-on `enable_tool` tool that activates dormant
  gates same-turn (rationale: gating must be recoverable without a restart).
- **S2 — keyword precision:** removing over-broad bare words (image/scene/video/
  movie/…) + word-boundary matching for single ASCII tokens; the false-fire
  rationale.
- **`requires` co-occurrence:** noun∧verb gating for core nouns (image/video/pdf)
  whose bare form false-fires (docker image, video call) but whose recall on
  common intents (generate an image) must survive.
- **S3 — telemetry:** `TOOL_GATE_LOG` opt-in (F4: flipped opt-out→opt-in) to
  quantify the dormant-tool miss rate.
- **cost-gate removal:** gating the phantom `movie-director-cost.ts` (measured
  offline, never runtime-loaded) inflated savings ~536 tok/req — removed.

**Incorporate** any new architectural decision surfaced by
[03 Close known gate-content gaps](03-close-known-gate-content-gaps.md) if it
changes a decision (keyword tweaks alone do not — they're implementation, not
architecture).

**type:** task
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — done: 5 ADRs landed

Authored `docs/adr/0001-0005` in the package: **0001** escape-hatch (S1), **0002** keyword-precision (S2), **0003** `requires` co-occurrence, **0004** opt-in telemetry (S3), **0005** remove phantom `cost` gate. Each follows the repo ADR format (Context / Decision / Consequences / Alternatives considered), pulled from the S1/S2/S3 specs + the inline `tool-gate.ts` audit notes. Cross-referenced from the new `CONTEXT.md`.
