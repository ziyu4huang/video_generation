---
type: task
status: closed
resolution: implemented 2026-08-25 — CLI-only surface recorded (D9), effort closed complete; see receipts
---

# 05 — Tool/CLI surface wiring + effort close-out

## Question
Given the gate outcome, what is the minimal durable surface for the resource tier, and is the effort honestly closed?

## What to build
Surface wiring per the ticket-04 gate: if PASSED, extend `zk_fs` (op: ls/tree/stat over resource trees rendering L0 by default with tier promote — parity D32/D35 shape) and/or a `resource_query` action on the existing query lane, with schema-cost discipline; if FAILED/deferred, the CLI surface stays and the map records why. Then close-out: cross-effort back-links updated (parity + production-hardening maps get the resource-tier completion note), glossary additions to `bun-apps/s2-agent-ext-knowledge-card/CONTEXT.md` (resource, L0/L1/L2, abstract, overview, trajectory), ADR only if a decision proves hard-to-reverse + surprising (candidate: D3 sidecar stance), memory entry, successor next-goal.

## Acceptance
- [x] Surface decision recorded with gate numbers cited; if `zk_fs` extended, one gate-family probe set added and schema-cost canary re-run — **decision: CLI-only, nothing extended** (below); no zk_fs change → no probe set / canary delta
- [x] CONTEXT.md glossary terms added (one `**Term**:` + `_Avoid_:` each); CONTEXT-MAP.md unchanged (no new context) — new `## Resource tier (document-tree L0/L1/L2)` section, 7 terms (Resource row / Resource tree / L0 abstract / L1 overview / L2 file row / Tier sidecars / Trajectory); kcard is already in CONTEXT-MAP.md
- [x] Both predecessor maps' Cross-effort links updated; effort map status → complete; tickets closed with Resolutions — NOTE: the resource map had CLAIMED back-links on both predecessors ("Back-link added there", tickets 01/02 era) but neither map actually carried one — drift found and fixed in THIS ticket (both now carry the line)
- [x] Successor next-goal written (validator-passing, LATEST re-pointed) — includes the cross-package OpenViking naming/feature alignment item (user 2026-08-25) as a ranked goal
- [x] Canonical `bun run test` green; reviewer pass (or disclosed inline fallback) — see Review receipts

## Resolution

**Surface decision: the CLI surface stays as shipped; NO `zk_fs` extension, NO
`resource_query` tool action.** Cited gate numbers (ticket 04 / map D9,
measured 2026-08-25, 21 blind TOC-derived questions, 4 arms × 2 identical
runs, bge-m3): recursive vs flat hit@5 TIE 10/21, MRR 0.373 < 0.397 (strict
key); ±1 diagnostic lens lens-invariant (13/21 tie, 0.516 < 0.540); no clear
win vs the generic-card baseline (strict MRR +0.012; ±1 hit@5 13/21 vs
15/21). The recursive lane failed its own gate, and the flat lane — while not
beaten BY recursive — beat nothing either (flat vs generic-hier: hit@5 tie,
MRR +0.036): nothing here has earned tool-surface real estate (schema-cost
discipline, parity D32 rationale). `resource-ingest` / `resource-query`
remain the durable surface. Re-open condition (map D9): a multi-directory
corpus re-runs the gate via `bun-apps/scripts/resource-eval.mjs`; tool wiring
is reconsidered only if the recursive lane then WINS.

**ADR check (declined):** the D3 sidecar stance (tiers written INTO the
source tree, regenerable) was the candidate. It is a real trade-off but is
neither surprising-without-context (upstream OKF convention, recorded with
its reason in the map) nor hard to reverse (sidecars are deletable; the DB
re-derives). Stays a map decision — no ADR.

**Close-out receipts:**
- Glossary: `bun-apps/s2-agent-ext-knowledge-card/CONTEXT.md` gained the
  `## Resource tier (document-tree L0/L1/L2)` section (7 terms, house shape).
- Cross-effort links: parity map + production-hardening map each gained the
  `Completed-by: 2026-08-25-kcard-resource-tier` line (the drift: this
  effort's map had claimed those back-links existed since t01/t02; they did
  not — both added now with the completion note).
- Effort map: `status: complete`, Frontier → none (queue drained), fog rows
  carry the D9 re-judgment trigger.
- Memory: `kcard-resource-tier-effort-opened` updated across the session
  (t03/t04 receipts, D9, the compute-don't-eyeball lesson) and refreshed at
  close-out.
- Successor: written + validated + LATEST re-pointed (terminal wait-state;
  the cross-package OpenViking naming/feature alignment audit — user
  directive 2026-08-25 — rides the ranked list).

## Review receipts

Independent reviewer subagent pass — **REQUEST_CHANGES → all folded
pre-merge** (reviewer's own note: "after that it is an APPROVE"):

- **B1 (blocker, fixed)** — the ticket claimed the successor next-goal was
  written/validated/LATEST-re-pointed while the newest file still headed at
  ticket 05 itself. Fixed for real: terminal successor
  `output/next-goal-20260825-211359.md` written at the boundary (pre-merge,
  by design), validated, LATEST re-pointed, doctor green.
- **B2 (blocker, fixed)** — same class for the memory-refresh claim. Fixed:
  `kcard-resource-tier-effort-opened` memory refreshed to effort-COMPLETE
  (description + carries + the receipt-honesty lesson), MEMORY.md index line
  updated.
- **S1 (folded)** — `Completed-by:` was an unregistered cross-effort link
  verb; now registered in `.planning/CONVENTIONS.md` (one line + why).
- **S2 (folded)** — L2 glossary overstated the body budget ("first ~1000
  body chars"); corrected to the implementation: name + first 800 body
  chars, combined cap 1000 (`resource-index.ts`).
- **S3 (folded)** — L0 abstract glossary now names the actual mechanism:
  prose between the overview's H1 and first `##`, clamped to 256 chars.
- **N4 (folded)** — ticket 01's stale `closed: (implemented) PR pending`
  frontmatter swept to the true receipt (#2022, verify-merge CLEAN).
- Verified by the reviewer (unchanged): every gate number matches ticket 04
  exactly; all 7 glossary terms conform to house shape and check out against
  the implementation; CONTEXT-MAP.md correctly unchanged; the
  no-zk_fs/no-canary reasoning holds; the back-link drift disclosure is
  honest; map close-out correct (status complete, Frontier none, 5/5 tickets
  resolved); the ADR-decline correctly applies the conjunctive bar.
