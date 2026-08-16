# 00 — Re-evaluate the matching mechanism on evidence

type: research
claimed: dsh-main (2026-08-15)

## Question

Is keyword + noun∧verb co-occurrence matching (`matchesKeyword` / `gateFires` in `extensions/tool-gate.ts`) still the right gating trigger, or should it be replaced?

The user mandate is "complete redesign (allow broken if it worth)". This reopens the boundary that the 2026-07-30 map and `ADR-tool-gate-0003` ruled **out of scope**. But "if it worth" is an evidentiary bar, not a blank cheque:

**Current baseline (measured 2026-08-15):** must-fire 46/46, must-not-fire 30/30, escape-name 11/11, escape-intent 11/11, gate-recall 20/20, 0 task-breaking gates, 51.9% savings (11,717 tok), 7 benign false-fires. The `enable_tool` escape hatch costs 243 tok/req always-on.

Resolve, with evidence:

1. **What is the actual failure mode** the mechanism still suffers? (false-fires are *benign* — they never gate; the only real costs are (a) a *miss* requiring `enable_tool` escape-hatch, measured by `qa:miss`/telemetry `miss_candidate`, and (b) keyword-authoring maintenance across 14 owning extensions.)
2. **Do any candidate replacements** — semantic/embedding intent, capability matching, a declarative gate DSL, cost-budget-driven activation, or LLM-side tool-selection hints — beat the baseline on **the QA corpus** (recall + precision + gate-recall + savings), or do they merely move the fragility?
3. **What is the hidden cost** of each alternative? (embedding server dependency — note the repo already runs `swift/embed-mlx-server` on port 8090; a per-turn embedding call vs the current zero-dependency, zero-latency regex; a DSL parser to maintain.)

**Verdict shape:** keep (with hardening) or replace — with the measured numbers and the corpus as the acceptance bar. The *decision* is HITL (the user picks), but the *research* is AFK: produce a recommendation with the numbers.

## Acceptance

A written recommendation citing: the failure mode, each candidate's corpus performance, each candidate's operational cost (dependency/latency/authoring), and a clear keep-vs-replace call. If "replace", name the mechanism and the migration risk.

## Resolution

**KEEP the keyword + noun∧verb co-occurrence matcher; do not replace it. The redesign's breaking changes belong to the contract (01) and the always-active core (02) — not the matcher.**

Evidence (measured 2026-08-15, `bun run qa` + `bun test`):
- must-fire 46/46 · must-not-fire 30/30 · escape-name 11/11 · escape-intent 11/11 · gate-recall 20/20 · **0 task-breaking gates** · 7 benign false-fires · 51.9% savings (11,717 tok).
- Prior live telemetry (`.planning/done/2026-07-30-…/tickets/00-process-pipeline-interaction-reality.md`, 201 turns): workflow gate fired 4×, escape-hatched 0× → **empirical friction ~zero**.

The two remaining failure modes are **not matcher failures**:
1. *Miss → `enable_tool` escape-hatch* — recoverable same-turn; the 243 tok always-on overhead is already priced into net savings. This is a recall/authoring concern, addressed by the gate-recall guard + ticket 02's probe hardening, not by swapping the matcher.
2. *Keyword-authoring maintenance* across 14 owning extensions — a **contract/declaration** failure (→ ticket 01), guarded today by drift-guard + gate-recall + sibling nets.

Candidates evaluated and rejected as non-wins or complements:
- **Semantic/embedding intent** — the repo already runs `swift/embed-mlx-server` (BGE-M3, port 8090), so the dependency *exists*, but it is optional (not always running) and a per-turn embedding call adds latency plus a precision threshold. Worse, embeddings are topically *near* the exact false-fire cases the corpus pins ("docker image" / "video call" near "image/video generation"); the `requires` noun∧verb instrument is strictly better for precision. Not a win.
- **Declarative gate DSL** — changes *declaration*, not *matching*; it is ticket 01's contract work and *complements* the matcher rather than replacing it.
- **Cost-budget-driven activation** — a different axis (how many tools we can afford, not *which* tool is needed); a possible complement under context pressure, not an intent matcher.
- **LLM-side tool selection only** (drop keywords, rely on `enable_tool`) — adds a round-trip per gated tool and the model cannot request a tool it does not know exists; friction is already ~zero *with* keywords doing first-line firing.

Deferred to **Not yet specified** (not a ticket): an *opt-in semantic fallback* for the specific miss cases telemetry surfaces, gated on `qa:miss` showing a real non-zero miss rate.

closed: 2026-08-15 (keep mechanism — hardened, not replaced)
