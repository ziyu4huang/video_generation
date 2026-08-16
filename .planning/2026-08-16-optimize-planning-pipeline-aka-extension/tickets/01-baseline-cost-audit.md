type: research
claimed: charting-session 2026-08-16

## Question

What did recent efforts actually cost, end-to-end? Build a baseline table over ~5 recent efforts (e.g. `2026-08-16-webui-event-cards`, `2026-08-16-tool-gate-qa-harness-generalization`, `2026-08-16-power-tool-rearch`, `2026-08-08-knowledge-pipeline`): sessions per pipeline stage (chart/grill, per-ticket, spec, plan, SDD tasks, close), tokens and $ per stage where recoverable. Sources: `~/.pi/subagents/runs/*.json` (per-run usage fields), `git log` over `.planning/<effort>/` and repo commits referencing the effort, SDD ledgers (`progress.md` inside `.planning/<effort>/sdd/`). Deliverable: per-effort × per-stage cost table + top 3 cost lines by share. This grounds every later ticket; the batching envelope numbers in ticket 04 come from here.

## Resolution

### Measured base: the subagent runs DB

`~/.pi/subagents/runs/` holds exactly **200 JSON run records, all timestamped 2026-08-16 02:01–05:41 UTC** (~3.7 h window — the last-200 retention limit). Aggregate over those 200 runs:

- input 4,086,404 · output 1,151,511 · cacheRead 29,080,704 · **total 34,318,619 tok** (avg 171.6 K/run; cacheRead is 85 % of spend)
- `usage.cost` is **$0.00 on every run** (no pricing wired for `zai/glm-5.3`, 183 runs / `zai/glm-4.7`, 17) → tokens are the only measured currency; $ is unrecoverable from this DB.
- status: done 110 · turns 53 · budget 36 · failed 1.

### Per-effort × per-stage table

Sessions are **commit-session proxies** (1 squash-merged PR ≈ ≥1 session; single author throughout). Tokens are **measured** where the effort intersects the 3.7 h window. Stages often bundle into one commit — bundled stages are marked `(bundled)`.

| Effort | chart/grill | spec/plan | tickets (written/resolved) | SDD tasks | close | Sessions proxy | Measured subagent slice (08-16 window) |
|---|---|---|---|---|---|---|---|
| 2026-08-16-webui-event-cards | (bundled into #1505) | (bundled) | 6 / **0** `## Resolution` markers (00–03 shipped per commits) | none | 4–5 PRs (#1505,#1511,#1515/16,#1521) | 4–5 sessions, 1 day | **56 runs / 12.43 M tok (36 % of window)** |
| 2026-08-16-tool-gate-qa-harness-generalization | (bundled, 1 commit) | (bundled) | 4 / **4** | none | in same commit (#1519) | **1 session** | **0 runs / 0 tok** |
| 2026-08-16-power-tool-rearch | (bundled, #1440 precursor + #1464) | HANDOFF.md | 2 / 0 markers | none | ~5 PRs (#1464,#1471,#1474,#1506; adjacent #1501,#1514) | ~5 sessions, 1 day | 17 runs / 4.01 M tok (12 %) — fuzzy (ask-user keyword overlaps core-task work) |
| 2026-08-16-webui-view-notifications | (bundled) | (bundled) | 8 / 1 | none | 1 PR (#1476) shipped the whole feature | **1 session** | 1 run / 273 K tok |
| 2026-08-08-knowledge-pipeline | separate grill commits (e.g. #1171, #1286) | separate spec + plan commits (#1286→#1288, #1298, #1361…) | 21 / 14 | **3 SDD dirs**: planning-sync (5 tasks ×brief+report, 9 review diffs, final report), staleness (9 tasks), leanrag-19 (briefs/reports/reviews) | close-out commits (#1350, #1498) | **~9–15 sessions across 9 calendar days (08-08→08-16); 51 planning-dir commits (30 planning-side vs 14 impl-side)** | final-day tail only: **36 runs / 7.21 M tok (21 %)**; +45 hermes-family runs / 6.12 M ambiguous vs sibling hermes-arch effort |

Plus cross-effort overhead inside the window: **56 unattributed runs / 4.27 M tok (12 %)** — devops merge/integrate runners, probes, transcribers, finishers (roles: finisher 24, assessor 23, implementer 17, transcriber 9, devops 8…).

### Top 3 cost lines by share

1. **Limit-truncated dispatches — 25.98 M tok = 76 % of all measured spend.** 90/200 runs ended `budget`(36)/`turns`(53)/`failed`(1); they consumed 17.82 M + 8.07 M + 0.09 M tok while producing only 39 % of output tokens (`budget` runs alone: 52 % of spend, 41 % of output). Evidence: status×usage aggregation over the 200-run DB. This is the single biggest actionable line — most of it is re-reading big cached contexts (cacheRead-dominated) in dispatches that never complete.
2. **webui-event-cards execution slice — 12.43 M tok / 56 runs = 36 % of the window**, the largest single-effort share, for 4 shipped tickets in ~1 day with zero `## Resolution` markers. Evidence: runs-DB keyword attribution (event-cards/card-frame/answer-loop vocabulary over `task`+`cwd`+`agent`) + PRs #1505–#1521.
3. **knowledge-pipeline structural bulk — 9 calendar days, 21 tickets, 3 SDD dirs, 30 planning-side vs 14 impl-side commits** in its `.planning/` dir; its *final day alone* accounts for 7.21 M tok (21 % of window) — full-effort tokens are unrecoverable (DB truncated to 08-16). Evidence: `git log -- .planning/2026-08-08-knowledge-pipeline/` (51 commits, 08-08→08-16), ticket markers (14/21 resolved), `sdd/` listing, runs DB.

Counter-signal worth keeping: the two cheapest audited efforts (tool-gate-qa-harness-generalization: 1 commit, 4/4 resolved, 0 runs; view-notifications: 1 commit, 8 tickets, 1 run) show a whole effort can land in **1 session with ~0 subagent spend** when it is planning-only or shipped as one PR — the expensive pattern is per-ticket multi-PR execution with heavy dispatching.

### Coverage caveats (read before reusing these numbers)

- **Runs DB = last 200 dispatches, one 3.7 h day.** Anything before 2026-08-16 02:01 UTC (incl. all of knowledge-pipeline 08-08→08-15) has **no measured token data**. Numbers for those periods are commit/ticket proxies only.
- **Main-session tokens are not in this DB at all** — grill/map/spec/plan main-session costs (the actual target of this optimization effort) are invisible; only subagent dispatches are measured. The planning-pipeline cost is therefore *under*-represented, not over.
- **$ figures: none.** `usage.cost` = 0 on all runs (no price map for zai/glm models); without a price table any $ figure would be fabricated.
- **Attribution is best-effort keyword matching** (effort name / plan-path / distinctive vocab over `task`+`cwd`+`agent`). Fuzzy boundaries: kp vs hermes-arch (45 runs / 6.12 M ambiguous), power-tool-rearch vs ask-user/core-task. Coverage of the window: 144/200 runs attributed to audited efforts + 56 infra/unattributed.
- **Commit-session proxy over/under-counts**: single-author repo with squash-merge PRs (1 commit ≈ 1 PR, but a session can span many PRs; conversely chart/spec stages are bundled into impl PRs and invisible as separate stages).
- **Ticket closure discipline is inconsistent** (`## Resolution` present in 14/21, 4/4, 1/8, 0/6, 0/2) — resolved-counts understate shipped work for the 08-16 webui efforts.

closed: 2026-08-16 (research pass, charting session)
