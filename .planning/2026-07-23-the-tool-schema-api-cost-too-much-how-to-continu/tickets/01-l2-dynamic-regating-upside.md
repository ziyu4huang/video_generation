---
type: research
status: closed
claimed: pi-session-2026-07-23
---

## Question

Does **L2 dynamic re-gating** (re-gate tools that fired early then went unused, instead of today's sticky-once) have real ROI? I.e. how often in real sessions does a gate fire on turn 1 and the tool never get called again — leaving its schema tax paid on every later turn for nothing?

**Method.** The signal lives in tool-gate telemetry: `TOOL_GATE_LOG_PATH=<file>` sessions emit `turn` events (`gatesFired`, `dormantGates`) alongside the actual tool-call stream. Analysis per gate that fired: was it ever CALLED in a subsequent turn? `Σ (fire-then-unused rate × gate schema cost)` = the L2-addressable waste. If no log exists yet, reason from the gate definitions: which gates fire on common session-openers ("inspect context" → inspect; "wayfind" → workflow/zk; "make an image" → flux2) and are then not needed — and propose a short capture run to measure it.

**Risk context (informs the decision this feeds).** Sticky-once is deliberate: a flux2 workflow must not lose the tool mid-task when a follow-up like "make it bigger" drops the trigger keyword. L2's ROI must clear the cost of a safety policy (never re-gate tools used in the last N turns, or while a workflow is active). This ticket quantifies the upside; the safety design stays in fog until 01 resolves.

## Findings (research pass 2026-07-23 — partial, inconclusive)

- **No telemetry captured yet.** `TOOL_GATE_LOG` / `TOOL_GATE_LOG_PATH` are opt-in (F4, 2026-07-20) and have never been enabled in a real session, so the fire-then-unused rate is **unmeasured**. Cannot quantify L2 ROI from data.
- **Reasoned upside is non-trivial.** This very session is the existence proof: the opener "inspect context" fired the **inspect gate (947 tok)**, and "wayfind" fired **workflow + zk gates (~2,000+ tok combined)** — all now sticky for the session. If the session pivots to unrelated work (e.g. editing a bun package), those ~3,000 tok are paid every turn for nothing. The waste scales with session length × pivot frequency.
- **But the upside is bounded by ticket 03's finding.** Once 03/04 gate the `cost`/`arxiv_*` tools, the always-on baseline drops further, and L2's relative value (recovering fired-then-unused) depends on how often real sessions pivot away from an early-fired gate.

## Status

**Open — needs a telemetry capture run to resolve.** A short Task graduates if pursued: enable `TOOL_GATE_LOG_PATH` across N representative sessions (or mine past session transcripts), compute per-gate `fired ∧ never-called-again` rate × gate schema cost. Until then L2's ROI is reasoned, not measured — keep it behind 03/04 in priority.

## Resolution (2026-07-23)

**VERDICT: DEFER L2 — not worth building.** The destination's bar was "gated by ROI, stop at diminishing returns"; L2 does not clear it, for four converging reasons:

**1. Telemetry gap (confirmed, no data to mine).** tool-gate logs gate *firings* (`turn`/`activate`/`miss_candidate`) but has **no `tool_call` listener** — it never records which gated tools are actually CALLED. And `TOOL_GATE_LOG` has never been enabled (zero captured logs in the repo). So fire-then-unused is **unmeasured**, only structurally reasoned. Quantifying it would first require a ~15-line `tool_call` telemetry addition + a capture run.

**2. Ceiling is conditional and concentrates on utility gates.** Per-gate fire-then-unused plausibility (costs post 04+05):
  - *Generation gates* (flux2 798, krea2 717, ltx 711, movie 431): fire-then-unused is **rare** — "generate an image" ⇒ the tool is called. Also workflow-critical ⇒ re-gating is unsafe. L2 upside ≈ 0.
  - *Utility gates* (inspect 947, collect_videos 723, file2md 694, arxiv 661, cost 536, pi_deploy 321): fire-then-unused is **plausible** (one-off inspect/research/deploy, then idle). Absolute ceiling (all 6) ≈ 3,882 tok; realistic (1–2 fire early) ≈ 1,000–1,900 tok — but ONLY on long sessions that fire a utility gate early then pivot away. Short sessions / sessions that keep using it ⇒ ≈ 0.

**3. Prefix caching DEFLATES the per-turn value (decisive).** Memory (2026-07-08, proven on zai + LM Studio) records `setActiveTools` toggling `tools[]` costs ≈ 0 — prefix caches are multi-entry, so a *stable* active set is cached and costs ~cache-read per warm turn, not the full schema cost. An idle-but-active tool (inspect, fired once) is therefore already ~free per warm turn (cached). L2 re-gating it saves only the **cache-read fraction (~10–25%)**, not the full 947 tok — AND pays a cache-miss re-send on the transition. So L2's realistic per-turn saving ≈ cache-read-cost × idle turns, far below the naive ceiling.

**4. Effort/risk is HIGH.** sticky-once is load-bearing (a flux2 workflow's follow-up "make it bigger" must not lose the tool), so any L2 needs a per-gate safety policy (utility-only + generous idle threshold), a `tool_call` telemetry prereq, ~50–80 LOC of before_agent_start changes, and L1/L2 corpus + regression tests. The UX regression risk (a re-gated tool "disappears", the agent must re-fire via `enable_tool`/keyword) is real.

**Net.** 04 (−1,197 startup, pure gate-add) and 05 (−533 transient, pure dedup) captured the clean suppression wins. L2 is the hard, risky, conditional one whose per-turn value is largely already eaten by prefix caching, against a 3.8%-at-200k baseline that is already modest. → **Diminishing returns. Defer.**

**Enabler for a future revisit (not built now):** add a `tool_call` listener to tool-gate's telemetry (~15 lines, opt-in, no behavior change) so fire-then-unused becomes measurable. Only worth it if L2 is genuinely back on the table — and even then, re-run this ROI check against a capture first; the prefix-cache argument likely still holds.
