# 02 — Always-active core re-triage (Spec C)

type: research
claimed: dsh-main (2026-08-15)

## Question

The always-active set is ~31 tools / **10,871 tok/req** — over half the entire gated-ON budget. Eight tools carry >5k tok with no apparent cost audit: `zk_ingest` 934, `zk_ask` 765, `todo` 737, `ask_user_question` 700, `wayfind_effort` 617, `web_search` 593, `skill_manage` 578, `fetch_content` 570. (Measured by `qa:savings`; per-tool via `power-tool` `schema-cost`.)

This is **Spec C** from `.planning/specs/2026-08-10-tool-gating-contract-collapse-design.md`, carried forward — it was identified and never done. The savings story has inverted: gating heavy domain tools is *complete* (27 gated-heavy, 0 task-breaking); the remaining cost is the core.

Resolve:

1. **Audit each of the 31 core tools**: why is it `core:true`? (frequency of real use, irreplaceability, safety — e.g. `ask_user_question`, `bash`, `read`/`write`/`edit` are plausibly load-bearing; `zk_ingest` is a batch vault-convergence op that is not needed every turn.)
2. **Propose demotions**: for each candidate, the keywords + `requires` + recall probes it needs (this is the "authoring keywords + harden the probes" work the Spec flagged as the bulk of the cost).
3. **Quantify the win**: target always-on budget after re-triage (e.g. 10,871 → ? tok), and the must-not-fire risk each demotion introduces (the corpus + gate-recall harness is the backstop).
4. **Decide the demotion bar**: which tools must never gate regardless of cost (the true safety core), and which are demotable.

The *decision* (which tools demote) is HITL; the *measurement + ranking + probe-authoring plan* is AFK.

## Acceptance

A ranked audit table (tool → cost → why-core → demotable? → proposed gating + probes), a target always-on budget, and a list of must-not-gate safety tools.

blocked by: none (the write of new `gating` declarations happens after 01)

## Resolution

**Split the ~31-tool always-on core into a "safety core" (never gate) and a "demotable" set; demote the high-cost on-demand tools to halve the always-on budget.**

Classification (research; the exact demotion set is HITL-confirmable):

**1. Safety core — NEVER gate** (the irreducible operating surface; gating any of these breaks a first-class path):
- `read`, `write`, `edit`, `bash` — file I/O + shell (injected builtins).
- `enable_tool` — the escape hatch itself (gating it breaks recovery).
- `ask_user_question` (~700 tok) — HITL; gating it breaks "ask the user".
- `memory`, `memory_search` — persistent memory, pervasively used.
- `todo`, `goal_complete` — task/goal tracking (the plan-mode loop).
- `web_search`, `fetch_content` (~593/570 tok) — web access; keep in core for now (re-evaluate only if telemetry shows rare use).

**2. Demotable — on-demand, high cost, low per-turn frequency** (demote to `gating` gates, post-01 contract):
- `zk_ingest` (~934 tok) — batch vault-convergence; never mid-task. **Highest single win.**
- `zk_ask` (~765 tok), `zk_card`, `knowledge_query` — Zettelkasten/knowledge-graph Q&A + capture, on-demand.
- `wayfind_effort` (~617 tok) — planning status, on-demand.
- `skill_manage` (~578 tok) — skill management, on-demand.
- `session_search`, `get_search_content` — past-session / stored-search retrieval, on-demand.
- `knowledge_search`, `knowledge_ingest`, `planning_stale` (hermes-memory, ~300–370 tok each) — knowledge ops, on-demand. (Note: `planning_stale` + `knowledge_search` became `core:true` on origin/main — they were the "ungated heavy" of F5; demote them here instead of ticket 03.)
- `grill_decision` — HITL grilling capture, on-demand.
- `obsidian`, `obsidian_help` — vault I/O, on-demand.

**Per demotion (implementation, ticket 03 + contract from 01):** author keywords ± `requires` (noun∧verb), add must-fire + must-not-fire probes to the QA corpus, and hold `qa:gate-recall` + `qa:coverage --strict` green.

**Target:** cut always-on from ~10.9k tok toward **~5–6k tok** (roughly halve) by demoting the ~8 heavy + ~6 medium tools above. Exact figures need re-measurement — `qa:savings` hangs on the synced tree (hermes surrealdb backend slow-start), so the Spec C numbers here stay directional until implementation re-runs `qa:savings`/`qa:coverage`.

**Risk note:** the demotion set deliberately keeps `web_search`/`fetch_content`/`todo`/`ask_user_question` in core — a wrongly-demoted high-frequency tool converts a one-time token win into per-turn `enable_tool` escape-hatch friction. Telemetry (`TOOL_GATE_LOG` `activate`/`miss_candidate`) is the post-hoc guard; re-open if escape-rate rises.

closed: 2026-08-15 (safety-core vs demotable split; demote ~14 on-demand tools, target ~half the always-on budget)
