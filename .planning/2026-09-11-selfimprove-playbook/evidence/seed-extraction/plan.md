### PB-01 — Sync the tree to the default-branch tip before executing a queue head
- **Scope:** arc-open
- **Strategy:** Never execute a next-goal from whatever HEAD is lying around. Run `sync-default-branch-cli --mode hands-on` (or the `sync_default_branch` tool) first; only `handsOn.callerAtTip: true` licenses proceeding. An abort (`dirty_tree`, `divergent`, `worktree_conflict`) is a stop surfaced to the user, never a skip or a `--force` improvisation.
- **Evidence:** bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md (EXECUTE step 1 + mistakes table "Executing the queue head from a stale tree")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-02 — Claim series numbers via the arc-ledger at branch time, and sweep for sibling collisions before opening
- **Scope:** arc-open
- **Strategy:** Claim a series arc number by appending ONE entry to `.planning/arc-ledger.json` at branch time — never eyeball "max folder is N, so N+1 is free". Before opening any effort, check in-flight sibling efforts' file surfaces (their maps list them) and pick a scope that collides with none; work in a dedicated worktree when the memory worktree is occupied.
- **Evidence:** .planning/CONVENTIONS.md (arc-number ledger section); .planning/2026-09-10-self-arc-22-review-harvest/map.md (D1); .planning/2026-09-10-spwf-drive-ab/map.md (Context "Collision" bullet + dedicated-worktree note)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-03 — Push everything before writing the successor next-goal
- **Scope:** arc-close
- **Strategy:** A hands-off NEVER leaves uncommitted or unpushed work behind — the successor's Immediate steps must never be "commit my changes". Before writing the file: tree clean, every change committed on a feature branch and pushed (PR opened when reviewable); if a gate blocks the push, surface the blocker and stop rather than deferring it into the successor.
- **Evidence:** bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md (WRITE step 0 + mistakes table)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-04 — Supersede the next-goal at every merged ticket boundary — validated, then repoint LATEST
- **Scope:** arc-close
- **Strategy:** After ANY verified + merged ticket in a multi-ticket effort, supersede the file even mid-session: `LATEST-next-goal.md` must always name the queue head, never yesterday's ticket. Never hand off a file the validator rejects (exit 0 or fix), repoint the symlink only after validation, and finish with the doctor. When the queue drains, the successor's head is the effort close-out — the loop stops there.
- **Evidence:** bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md (WRITE steps 3–6 + ticket-queue "Boundary discipline"/"Termination")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-05 — Flip the map terminal-with-provenance in the SAME PR that lands Shipped-as
- **Scope:** arc-close
- **Strategy:** The close-out PR must flip front-matter `status:` to `done`/`complete` together with its `## Shipped-as` section citing verifiably merged PRs — never land the prose and leave the status stale. Verify with `effort-audit.ts` (exit 0) before merging.
- **Evidence:** .planning/CONVENTIONS.md ("Finished means terminal-with-provenance", cites #2225/#2219); .planning/2026-09-09-self-arc-20-dev-pipeline/map.md (Shipped-as: #2248 merged but map never closed, found live by the ledger check)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-06 — Run an independent reviewer pass and fix its blockers in the same session
- **Scope:** arc-close
- **Strategy:** Before merge, dispatch an independent reviewer (fresh GLM-5.3 process) on the arc's own outputs and preserve its verdict receipt. Treat REQUEST-CHANGES blockers as same-session work — fix, then re-review — never merge over them; the reviewer has caught vacuous PASSes and false-green verification that the executor missed.
- **Evidence:** .planning/2026-09-09-planning-audit/map.md (Reviewer round: 2 blockers incl. unanchored `#20` false-green, fixed same session); .planning/2026-09-10-spwf-drive-ab/map.md (Reviewer round: vacuous gemma C4 PASS caught)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-07 — Dogfood: gate the shipping PR with the very gate the arc ships
- **Scope:** arc-close
- **Strategy:** When an arc builds a new quality gate (reviewer, harvester, detector), use it to gate the arc's own PR end-to-end, and cite that in-the-loop proof in the PR body. A gate that has only gated other things has not yet proven it can bite its own author.
- **Evidence:** .planning/2026-09-10-self-arc-22-review-harvest/map.md (Shipped-as, PR #2261: v1 harvested REQUEST_CHANGES caught the missing empty-output guard; v2 APPROVE — "used to gate the very PR that ships it")
- **Confidence:** medium
- **Status:** active
- **Added:** 2026-09-11

### PB-08 — Pin immutable deployed version dirs; never run receipts against `current`
- **Scope:** deploy
- **Strategy:** Receipts and drives target an immutable `<version-dir>` by explicit path, never the `current` symlink — sibling sessions move it mid-arc. When a leg must touch `current`, resolve the symlink at run time and record the resolved label in the receipt.
- **Evidence:** .planning/2026-09-10-spwf-drive-ab/map.md (D2 + Context "current was moved again by a sibling — never used"); .planning/2026-09-09-self-arc-16/map.md (Fog of war: "Deployed `current` MOVED mid-arc")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-09 — Never trust a version label — byte-verify the deployed artifact
- **Scope:** deploy
- **Strategy:** "Deployed sha X" describes a label, not bytes; caches and noop redeploys can freeze stale content under a current label. Before relying on a pinned dir, grep the shipped bundle for the load-bearing symbol (property names / string literals — minification preserves those, not locals); after any cache-key fix, redeploy with `--force` once.
- **Evidence:** .planning/2026-09-10-spwf-ab-closing/map.md (Context: "0.10.3+gc172fd3 is the ONLY version dir grepping the F2 line in ext/superpowers/ext.cjs (=1)"); bun-apps/s2-agent-ext-devops/skills/learnings/SKILL.md (stale-core-cache + noop-redeploy entries)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-10 — Receipt the PRE-fix state before landing any fix, then re-receipt
- **Scope:** receipts
- **Strategy:** When a red is found on a surface about to be fixed, capture the failing-state receipt BEFORE the fix lands (the expected-throw, the gap, the mis-behavior), then re-run the same receipt post-fix so the flip is evidenced on both sides. A fix without its PRE-fix receipt proves nothing about what changed.
- **Evidence:** .planning/2026-09-09-self-arc-16/map.md (t02 execution order: PRE-fix receipts must complete BEFORE t03 lands; PRE-fix PASS 9/9 + gaps → POST-fix 11/11); .planning/2026-09-10-spwf-drive-ab/map.md (t04: RED → minimal fix → gates → redeploy → paired same-case re-run)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-11 — Pre-register expectations, prompts, and branch actions before running legs
- **Scope:** receipts
- **Strategy:** Write the checks/expectations for every case BEFORE running it (empty checks → UNSPECIFIED, never a default RED); freeze neutral prompt strings verbatim in the ticket and never edit them between legs; pre-commit the decision tree for probe outcomes (e.g. "≥4/5 → no fix; ≤2/5 → one strengthening line, never more") so results can't rationalize a post-hoc verdict.
- **Evidence:** .planning/2026-09-10-spwf-drive-ab/map.md (D3, D5); .planning/2026-09-10-spwf-ab-closing/map.md (D4 pre-committed C1 branches)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-12 — Adjudicate from preserved session bytes — and suspect the ruler before the subject
- **Scope:** receipts
- **Strategy:** Make attribution passive (record per-leg model via flags + env override + JSONL-derived receipt field; mismatch voids the leg), and when a prior map's narrative disagrees with artifacts, re-attribute from the session JSONL, not prose. When a behavioral verdict looks bad, first re-adjudicate the preserved bytes under a corrected detector — a "PARTIAL" can be a double detector artifact and the model was compliant all along.
- **Evidence:** .planning/2026-09-10-spwf-drive-ab/map.md (§0 re-attribution table, D1); .planning/2026-09-10-spwf-ab-closing/map.md (§0 "the model was blamed for what the ruler mis-measured", D2/D3)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-13 — Never delete a failing or SKIP receipt — preserve and annotate
- **Scope:** receipts
- **Strategy:** Failing, skipped, and infra-dead receipts are the evidence trail: keep SKIP-round receipts, keep pre-fix prefixes, disposition red rows explicitly instead of erasing them. Deleting the failure deletes the only proof of what was wrong.
- **Evidence:** .planning/2026-09-10-spwf-drive-ab/map.md (D6, F5 skip-round preserved); .planning/2026-09-09-planning-audit/map.md (D5 "Never delete a failing row — annotate")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-14 — Never prompt-engineer a green light; cap retry budgets; defer with a dated reason
- **Scope:** receipts
- **Strategy:** Cap legs per cell (e.g. ≤2) and never re-roll or reword prompts to convert a red into a pass — deltas are findings. On stalls or shared-infrastructure contention (sibling-owned endpoints), gate attempts behind measured preconditions, burn at most the budgeted windows, then record a DATED defer naming the blocker rather than thrashing.
- **Evidence:** .planning/2026-09-10-spwf-drive-ab/map.md (D6); .planning/2026-09-10-spwf-ab-closing/map.md (D5 gemma precondition + "DEFERRED with dated reason")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-15 — Record unreachable surfaces as gaps, never as passes
- **Scope:** receipts
- **Strategy:** What verification cannot reach (no credentials, dead infra, session died before behaving) is written as a recorded gap / UNTESTED-infrastructure with its cause — never a vacuous PASS. An empty-check or infra-death receipt that "succeeded" must be labeled UNSPECIFIED or untested, not green.
- **Evidence:** .planning/2026-09-09-self-arc-16/map.md (D3 recorded-gaps rule); .planning/2026-09-10-spwf-drive-ab/map.md (verdict matrix "UNTESTED-infrastructure" cells; reviewer caught the vacuous gemma C4 PASS)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-16 — Settle the knowledge ledger in the same session: Resolution on tickets, cross-links on BOTH maps
- **Scope:** planning
- **Strategy:** Any work that resolves, supersedes, or invalidates a decision in a wayfind ticket appends a `## Resolution` + `closed:` line to that ticket in the same session (correction note, never silent edit). On overlap, add the `Builds-on:`/`Completed-by:`/`Supersedes:` cross-link to BOTH efforts' maps — one-sided links are a documented exception, not the default.
- **Evidence:** .planning/CONVENTIONS.md ("Keep wayfind tickets current" + "Cross-effort links")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-17 — Commit and push .planning/ artifacts with the branch — never leave an effort untracked
- **Scope:** planning
- **Strategy:** `.planning/<effort>/` (map, tickets, plans, evidence) rides the branch's commits/PR and must be pushed to origin/main; never end a session with a new effort dir in `??`. Transient scratch (`task_plan.md`, `progress.md`, `findings.md`, `output/`) stays local by design.
- **Evidence:** .planning/CONVENTIONS.md ("Commit & push .planning/ artifacts (standing rule)")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-18 — Cite committed evidence/ paths for verdict flips, never output/ scratch
- **Scope:** planning
- **Strategy:** Load-bearing receipts a map cites live in `.planning/<effort>/evidence/` (text/JSON, ≤256KB/file, ≤1MB/effort), committed with the branch — `output/` is per-worktree gitignored scratch whose receipts die with the tree. A verdict flip without a committed evidence path is narrative.
- **Evidence:** .planning/CONVENTIONS.md ("Evidence permanence tier"); .planning/2026-09-10-spwf-ab-closing/map.md (D7 + "Verdict deltas + findings … evidence under evidence/")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-19 — Keep the successor's ranked list in focus scope; let the loop terminate
- **Scope:** planning
- **Strategy:** The 3–5 ranked entries are a focus queue: every entry in-scope (pad with dormant in-scope re-checks), out-of-scope items appear only when they BLOCK in-scope work, and a truly empty queue yields an explicit wait-state — never an invented goal. Surface queue drift (file ranking vs the map's `Execution order`) to the user instead of silently picking one.
- **Evidence:** bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md ("Focus scope" + READ "Queue drift rule" + ticket-queue "Termination")
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11

### PB-20 — Make audits committed, re-runnable tools with exit codes — not session tallies
- **Strategy:** Tree-wide audits (planning status, citation provenance, effort hygiene) land as a committed tool in the owning package (pure classifier + CLI twin + tests, exit 1 on red), and the tool's output is the census of record. Session tallies disagree with each other (observed 75-vs-72 on the same tree); when they do, encode the check, don't re-argue the count.
- **Scope:** planning
- **Evidence:** .planning/2026-09-09-planning-audit/map.md (D8 census-of-record + Context "delta itself evidence the audit must be a tool"; shipped as effort-audit.ts in PR #2239)
- **Confidence:** high
- **Status:** active
- **Added:** 2026-09-11