type: research
claimed: charting-session 2026-08-16

## Question

Within recent SDD cycles, what is the cost anatomy, and where did the documented frictions actually bite? For ≥2 recent SDD workspaces under `.planning/*/sdd/` (e.g. knowledge-pipeline, 2026-07-25-simplify-ext-prompt-weight): split cost between implementer dispatches, reviewer dispatches, review-package generation, fix-loop rounds, and re-dispatches/NEEDS_CONTEXT waste; count per-finding fix waves vs the one-fix-wave policy; measure fix-loop depth distribution. Sources: `progress.md` ledgers, reports/reviews files, `~/.pi/subagents/runs/*.json`. Deliverable: cost-split table + friction-event list with estimated cost each. Feeds ticket 05.

## Resolution

### Method & sources

Workspaces inspected (12): `done/2026-08-15-btw-panel-in-webui`, `2026-08-08-knowledge-pipeline/sdd/{2026-08-10-planning-sync, 19-leanrag-redundancy-aware-retrieval, 2026-08-10-staleness-dependency-graph}`, `2026-07-25-simplify-ext-prompt-weight`, `done/2026-08-14-build-hitl-webui`, `done/2026-08-01-subagents-live-visibility`, `done/2026-08-02-hardening-*`, `done/2026-07-25-inspect-hooks-*`, `done/2026-07-25-pi-ext-subagent-*`, `sdd/2026-08-07-codebase-design-skill`, `sdd/2026-08-08-core-interface`. Dispatch counts reconstructed from `progress.md` ledgers, brief/report/review-package files, and squash-merge commit bodies (178611dd, b7f1e78c, 1fcb4504). **Token attribution is best-effort**: the target cycles' run telemetry is rotated out (`~/.pi/subagents/runs/` holds only Aug-16 JSONs; logs only Aug 3–6), so per-dispatch cost = role-calibrated medians from the 200 surviving runs — implementer **858K median** (n=18, min 40K / max 1.58M), finisher 41K, devops 115K; reviewer has no surviving telemetry, estimated **~200K/round** (package bytes/4 input ≈ 3–32K tok + repo reads + verdict; final whole-branch reviews with 80–235KB packages ≈ 300–400K). Package-gen ≈ 10K each. Treat estimates as ±50%.

### Cost-split per workspace (estimated tokens)

| Workspace (tasks) | Implementer | Fix rounds | Reviewer (task) | Reviewer (final/fix re-review) | Package-gen + briefs | ~Total | ~Per task |
|---|---|---|---|---|---|---|---|
| btw-panel-in-webui (12) | 11×858K ≈ 9.4M | 2×858K ≈ 1.7M (T3 + final wave F1–F4) | 12×200K ≈ 2.4M | final 300K + re-review 200K | 500KB pkgs ≈ 125K + 88.5KB briefs ≈ 45K | **~14.2M** | ~1.18M |
| planning-sync 09-impl (7) | 7×858K ≈ 6.0M | 1×858K (TDD fix wave) | 7×200K ≈ 1.4M | final 350K (81.5KB pkg) + re-review 200K | 214KB pkgs ≈ 54K + 70KB briefs ≈ 35K | **~8.7M** | ~1.24M |
| kp-19 leanrag (3) | 3×858K ≈ 2.6M | 1×~500K (2 hardening findings) | 3×200K ≈ 600K | final 400K (128KB pkg) + fix-review 150K | 200KB pkgs ≈ 50K + 2.6KB briefs ≈ 1K | **~4.3M** | ~1.43M |
| staleness 10-impl (9) | 9×858K ≈ 7.7M | 0 | **0 (no review packages persisted; per-task reviewer skipped)** | 0 | 0 + 67KB briefs ≈ 34K | **~7.8M** | **~0.86M** |
| simplify-ext-prompt-weight (6) | ~3 big + ~4 probe rounds ≈ 3.2M | 0 (T3 re-run folded in) | 3×200K ≈ 600K (T5 skipped **by policy**) | 0 | none persisted | **~3.9M** | ~0.65M |
| hitl-webui (8 tasks / 5 phases) | 9×~700K ≈ 6.3M | 1 (P4 T2B) | 8×200K ≈ 1.6M | 5 phase finals ≈ 1.0M | moderate | **~9M** | ~1.1M |

Reviewer share of total: btw ~20%, planning-sync ~22%, leanrag ~27%, staleness 0%. Fix-loop share: btw ~19%, planning-sync ~17%, leanrag ~15%.

### Fix-loop depth distribution (all observed fix events)

- **Depth 0 (clean first review): 31 of 40 reviewed tasks** (btw T1/T2/T4–T11, planning-sync T1–T7, leanrag T1–T3, hitl 7/8, core-interface 3/3, prompt-weight reviewed tasks).
- **Depth 1 (one fix wave + clean re-review): 9 events** — btw T3 + btw final F1–F4; planning-sync final (1 CRITICAL + 1 IMPORTANT + 1 minor); leanrag final (2 findings); hitl P4 T2B; hardening T2; pi-ext-subagent T3; inspect-hooks final.
- **Depth 2: 1 case** — kp-03 Phase-2 "2 fix waves" (pre one-fix-wave policy; map.md EXECUTE note). No depth >2 anywhere.
- Per-finding (unbatched) fix waves: **1 clear case** — btw T3, a single human-approved-deviation ruling cost a full fix dispatch + re-review ≈ **1.06M tokens for 1 finding**. All final waves post-Aug-10 batched correctly (btw F1–F4 one wave; planning-sync A+B+ride-along one wave; leanrag 2 findings one wave).

### Friction events found, with estimated cost

| # | Friction | Where | Est. cost |
|---|---|---|---|
| F1 | NEEDS_CONTEXT churn (brief's verbatim code referenced non-existent symbols → implementer round wasted, re-dispatch succeeded with identical code) | subagents-live-visibility T2 | ~858K (1 implementer round) |
| F2 | Per-finding fix wave (single finding got its own fix + re-review; policy says one wave per round) | btw-panel T3 | ~1.06M |
| F3 | Pre-policy double fix wave | kp-03 Phase-2 (2 waves) | ~1.0M extra vs one batched wave |
| F4 | Rework/reset waste: 3 implementer commits dropped via `reset --hard` (ADR-superpowers-0004 port-contract violation catchable at plan review), re-done in wayfind | codebase-design-skill PIVOT | ~2.5M (3 rounds) |
| F5 | Implementer dispatch failure absorbed by controller ("implementer died post-staging"; 2 more tasks "implementer was mechanical tester/committer, reviewer sole gate") | btw-panel T8 (+T4/T6 degraded) | ~0.9M absorbed |
| F6 | Plan-defect parked findings: 21 "minor (deferred)" lines in btw ledger, ~15 marked "plan-mandated verbatim" — reviewer re-litigates the plan every task; final triage ACCEPTed 3 of 4 final findings untouched | btw-panel (also hitl P4 plan defects) | ~100–200K/round extra reviewer output + ledger churn |
| F7 | BLOCKER: probe children load no repo skills → A/B unverifiable, worked around by building a subprocess A/B harness | prompt-weight T4→T5 | ~500–850K extra implementer work |
| F8 | Re-dispatch after compaction: **no occurrence found** in surviving ledgers — where progress.md existed (btw, hitl, core-interface) zero re-dispatches; but planning-sync/leanrag/staleness ran **without any ledger** (policy carve-out), i.e. the compaction-recovery contract was simply absent, not violated | — | 0 observed / unquantified risk |
| F9 | Reviewer rounds 4–5 tier escalation: **not observed** in any surviving artifact | — | 0 |

### Where the money actually went / savings levers (grounded in the numbers)

- **Per-task review is rarely load-bearing; the whole-branch final review is.** staleness shipped 9 tasks with zero reviewer rounds (0.86M/task — cheapest cycle) and went green; prompt-weight T5 skipped its reviewer by policy. Meanwhile the single highest-value catch across all cycles — planning-sync's CRITICAL mass-deletion bug, invisible to per-task tests — came from the **cumulative final review**, and btw's only Important (F1) also came from the final. Dropping per-task review for verbatim/mechanical tasks and keeping one whole-branch review saves ≈200K × N (btw: ~2.4M of 14.2M, 17%).
- **Briefs can shrink ~30× without harm.** leanrag's plan-slice briefs totalled 2.6KB for 3 clean tasks vs btw's 88.5KB for 12 tasks (and btw T3's 330-line brief still produced the cycle's only NEEDS_CONTEXT-class deviation). Slim briefs cut ~45K of generation per btw-scale workspace and reduce implementer input, with no observed quality loss.
- **One-fix-wave batching demonstrably works.** Every final wave after Aug 10 (btw F1–F4, planning-sync 2 findings + ride-along, leanrag 2 findings) fixed all findings in one dispatch + one re-review; the unbatched cases (btw T3: 1.06M for one finding; kp-03-P2 double wave: ~1M extra) are pure overhead. Extending the final-wave policy to task rounds is already 90% proven.
- **Fixed per-task overhead ≈ 250–350K (brief + package + verdict + dispatch preamble) regardless of task size.** btw's T4/T6/T9/T10/T11 were small glue tasks each paying full implementer+reviewer+package freight (1.18M/task avg). Merging mechanical steps into task-sized chunks (ticket 05's fewer-but-bigger tasks) saves ~1M per merged pair at observed dispatch costs.
- **Plan defects, not implementer defects, dominate parked findings** (~15 of 21 btw minors are "plan-mandated verbatim"; hitl P4 logged explicit "Plan defects found"). Pre-SDD plan review — or marking plan-verbatim items non-reportable by reviewers — removes most parked-finding churn and the F6 tax without touching the layer that catches real bugs.

closed: 2026-08-16 (research pass, charting session)
