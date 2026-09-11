All organs read and verified. Here is the plan — written to drop into `map.md` nearly verbatim.

**Learnings applied while planning:** #2 (label ≠ content → the A/B receipts must carry a playbook **sha256**, not just "playbook included") and the skill-precedence insight in the learnings log (why the playbook is deliberately **not** a skill).

---

# Effort: `2026-09-11-selfimprove-playbook`

Content slug per CONVENTIONS ("self-arc-N names belong to the series"; siblings self-arc-23/24 are claiming numbers in other worktrees). **No `arc-ledger.json` entry** — series claims only. Verified: ledger max is 22, all `done`; no `self-arc-2[34]` dir in this tree.

## Destination

The self-develop loop grows an **operational playbook organ** (ACE-style): a curated, itemized, evidence-cited strategy artifact at `.planning/playbook.md`; **read at arc open** (arc-plan.ts `--include-playbook`, receipt records the playbook's sha256); **curated at arc close** (a Reflector/Curator step wired into the self-reflect-next-goal close-out SOP — itemized add/supersede/miss deltas, never bulk rewrites); **seeded** ExpeL-style from the last ~10 arcs by one GLM-5.3 extraction dispatch with every evidence link machine-verified; and **measured honestly** via a paired with/without arc-open dispatch plus per-arc cite/miss counters — closing with receipts, one PR through the devops chain.

## Context (verified 2026-09-11, this worktree @ 8596f802)

- **Learnings log exists, append-only, prose**: `bun-apps/s2-agent-ext-devops/skills/learnings/SKILL.md` (170 lines; entries 2026-08-07→2026-09-06, tagged `[tool-quirk]`/`[insight]`/`[convention]`). Its own 2026-09-06 entry mandates dual-write into `.pi/agents/hard-problem.md` (verified — 7 numbered operating learnings in the def). Retrieval is **description-match only** — nothing guarantees an arc-open session sees it. That is gap A+C, confirmed.
- **Close-out has no reflector step**: `bun-apps/s2-agent-ext-devops/skills/self-reflect-next-goal/SKILL.md` WRITE steps 0–7 cover push→write→validate→repoint→doctor; "Honest reflection rules" separate verified/argued but nothing extracts helped/hurt into a durable strategy store. Gap B, confirmed. The file format is strict-v2 and validator-pinned (`scripts/validate-next-goal.ts`, `tests/validate-next-goal.test.ts`) — **do not add sections to the next-goal file itself**; deltas go to the playbook.
- **Planner prompts are ad-hoc scratch**: `arc-plan.ts --prompt-file` (bun-apps/s2-agent-ext-subagent/scripts/arc-plan.ts:11) with per-arc hand-written prompts (e.g. `output/arc-plan-self-arc14/prompt.md`, `output/selfimprove-plan/prompt.md`). No committed template, no guaranteed common context. Gap A's injection point, confirmed.
- **Voyager-shaped promotion already exists**: `.planning/knowledge/README.md` — trigger/lesson/procedure/evidence candidates, promoted via writing-skills then deleted; skill-worthy bar = reusable+procedural+non-trivial. So workflow induction (AWM/Voyager) needs **pointers, not new machinery**. Also: `knowledge/` is transient staging — the wrong home for a durable playbook.
- **Reviewer verdicts are harvestable by name** (self-arc-22, PR #2261): `arc-review.ts --name arc-reviewer` persists a standard pi-runs record; `reviewer-harvest --name arc-reviewer --timeout 0` → exit 0. This is the A/B adjudication instrument.
- **Evidence tier**: CONVENTIONS.md "Evidence permanence tier" — committed receipts go to `.planning/<effort>/evidence/` (text/JSON, ≤256KB/file, ≤1MB/effort); maps cite committed paths, **never** `output/`. A/B receipts must land there.
- **Terminal-with-provenance gate**: `bun-apps/s2-agent-ext-wayfind/scripts/effort-audit.ts` exit 0 required at close (status flip + Shipped-as in the same PR).
- **Collision surface**: audit-gate-fidelity (active) edits ultracode `samples/audit-ext-packages.js`, devops `local_ci` src, ext `package.json` scripts. Self-arc-24's surface unknown (other worktree). This effort touches only: `s2-agent-ext-subagent` (arc-plan.ts + tests), `s2-agent-ext-devops` **skills markdown only**, `.planning/`.

## Decisions

- **D1 — Home & path**: `.planning/playbook.md`, a root file beside CONVENTIONS.md (root files are "by design" per CONVENTIONS Directory-shape). NOT `knowledge/` (transient staging, consumed on promotion); NOT a skill (skills load by description-match — unreliable at arc open — and the SKILL.md surface drags the no-bash-skills seal; per learnings-hardening D1, agent-defs stay the quirk carrier, the playbook is the strategy carrier).
- **D2 — Schema & anti-collapse**: itemized entries, hard caps, supersede-in-place (see schema below). Caps enforced by a committed test, not by discipline. No entry without resolving Evidence (ExpeL discipline: insights must trace to trajectories).
- **D3 — Curator = the closing session itself**, folded into the self-reflect-next-goal WRITE chain (one new step before writing the successor), committing deltas in the same PR. A dedicated GLM-5.3 reflector dispatch is deferred to fog — minimal honest version first.
- **D4 — Read-at-open is mechanical**: `arc-plan.ts --include-playbook` prepends the playbook to the planner task; `plan-receipt.json` gains `playbookIncluded` + `playbookSha256` (learning #2: the label is not the content — receipts name the bytes).
- **D5 — Boundary vs learnings skill** (prevents duplicate-org drift): learnings = append-only **facts about the toolchain** (quirks/insights; dual-write to hard-problem.md per its convention); playbook = curated **operational strategies** (what to DO at arc open/close; supersede-able, capped). New quirk → learnings; new/changed strategy → playbook delta.
- **D6 — Measurement is mechanical, not vanity**: cite-count of `PB-nn` ids in plans, repeated-mistake checklist hits, paired A/B with harvestable reviewer verdict. Explicitly rejected: entry count, playbook size, "was read" booleans as success metrics.
- **D7 — Scope fence**: no model learning, no semantic retrieval (≤150 lines reads whole), no AWM code-induction — repeating procedures get a playbook pointer to `.planning/knowledge/` staging (the existing Voyager path).

## Playbook schema (`.planning/playbook.md`)

```markdown
---
version: 1
updated: YYYY-MM-DD
entries: <n>        # hard cap 25
---
# Loop playbook — curated operational strategies (read at every arc open)

<2–3 line header: what this is, the D5 boundary vs the learnings skill,
and the curator rule (itemized deltas only, supersede never delete).>

### PB-01 — <imperative one-line strategy>
- **Scope:** arc-open | arc-close | deploy | receipts | planning
- **Strategy:** <1–3 sentences, operational — WHAT to do, commands where load-bearing>
- **Evidence:** <.planning/<effort>/ (map/evidence path) and/or PR #N>
- **Confidence:** high (receipted on ≥2 independent arcs) | medium | low
- **Status:** active | superseded-by PB-<mm>   # never deleted
- **Added/Updated:** YYYY-MM-DD · misses: <n>  # close-out bump; 2 misses ⇒ demote or rewrite
```

Curator rules (enforced by test where mechanical): every `Evidence:` resolves on disk or via `git log --grep "#N"`; duplicate/near-duplicate topic ⇒ supersede the old entry, never append; over cap ⇒ demote lowest-confidence/stalest first; total file ≤150 lines / ~8KB.

## Seeding plan (ExpeL batch extraction)

1. Corpus = last ~10 arc maps (`2026-09-08-self-arc-14` … `2026-09-10-self-arc-22-review-harvest`, plus `2026-09-06-learnings-hardening`, `2026-09-10-audit-gate-fidelity` Context) + learnings SKILL.md + CONVENTIONS.md.
2. One GLM-5.3 extraction dispatch through the loop's own machinery: prompt → `output/playbook-seed/prompt.md`, run `bun bun-apps/s2-agent-ext-subagent/scripts/arc-plan.ts --prompt-file … --out output/playbook-seed` (no flag yet — pre-t03). Prompt demands: candidate entries in schema, each with a **specific** evidence pointer, both helped AND hurt extracted, ≤20 candidates, dedup against learnings (D5 boundary).
3. Executor curates (model output is a proposal, not truth): verify every Evidence link resolves, drop unverifiable ones, merge near-dups, cap at **≤20 entries**. Copy the dispatch receipt (plan.md, plan-receipt.json) into `evidence/seed-extraction/` (text-only, ≤256KB/file).

## Measurement plan

- **Seed quality (t02 gate)**: schema test green; 100% Evidence resolution; ≤20 entries, ≤150 lines.
- **A/B (t05)**: identical directive prompt dispatched twice via arc-plan.ts, once `--include-playbook`, once without. Mechanical checks: with-plan cites ≥1 `PB-nn` id in plan.md (grep); receipt `playbookSha256` recorded; a 5-item repeated-mistake checklist (silence-wait degeneracy, transcript-as-settle-signal, stale-local-main commitScope panic, version-label trust, hand-rolled git) scored on BOTH plans by the executor. Adjudication: `arc-review.ts` on both plans, `reviewer-harvest --name arc-reviewer` verdicts harvested; receipts into `evidence/ab-arc-open/`.
- **Ongoing (recorded in every closing map from this arc on)**: `playbookCited` (ids), `repeatedMistakeCoveredByEntry` (target 0; any hit = a miss on that entry).

## Tickets

**Execution order:** t01 → t02 → t03 → t04 → t05 → t06 → t07.

- **t01 — scaffold**: `.planning/2026-09-11-selfimprove-playbook/{map.md,evidence/}` in house shape; branch `selfimprove-playbook` via `prepare-feature-branch-cli`; no ledger entry. Confirm sibling surfaces before editing (`git log origin/main -5 -- bun-apps/s2-agent-ext-devops/skills/` and the devops local_ci path). Status: open.
- **t02 — schema + seeded playbook**: `.planning/playbook.md` per schema above; seed per plan; NEW test `bun-apps/s2-agent-ext-subagent/tests/playbook-schema.test.ts` (schema conformance, Evidence resolution incl. `git log --grep` PR check, caps, supersede-not-delete). Subagent package — already this effort's code surface; keeps wayfind untouched (unknown self-arc-24 surface). Status: open.
- **t03 — read-at-open flag**: `arc-plan.ts --include-playbook` (reads `.planning/playbook.md`, prepends a "Loop playbook — cite the PB ids you apply" block); `plan-receipt.json` gains `playbookIncluded` + `playbookSha256` (Bun.CryptoHasher). Test with tmp-fixture playbook (flag composes + hashes; no flag ⇒ absent). Do not disturb the scripts-allowlist entry. Status: open.
- **t04 — close-out wiring (markdown only)**: `self-reflect-next-goal/SKILL.md` WRITE gains one step (between doctor and finish): *Reflect & Curate* — propose itemized playbook deltas (add/supersede/miss-bump), commit in the same PR, next-goal file shape UNCHANGED; `session-closeout-sop/SKILL.md` gains the condensed twin line in §A + one line in §B (arc-open prompts run with `--include-playbook`). Add the D5 boundary paragraph to the playbook header. Status: open.
- **t05 — A/B experiment**: per measurement plan, on a REAL queued goal (the current LATEST head's residuals or this arc's successor directive — not a toy). Receipts to `evidence/ab-arc-open/`. Status: open.
- **t06 — one PR via devops chain**: scoped local CI (subagent + devops canonical gates — using `merge_pr_after_local_ci` is fine; the collision ban is on *editing* those files), `arc-review.ts` on the diff, harvest the verdict by name, squash-merge, `verify-merge`. No ext `package.json` / local_ci src edits; no core-src ⇒ no redeploy (state `iff-src-changed` in the PR body). Map + tickets + evidence ride the PR. Status: open.
- **t07 — close-out per CONVENTIONS**: successor `output/next-goal-<ts>.md` (strict v2, validated, repointed, retention ≤10), map `status: done` + Shipped-as in the SAME PR, cross-effort links added to BOTH maps: `Builds-on: 2026-09-06-learnings-hardening` (generalizes the log), `Builds-on: 2026-09-10-self-arc-22-review-harvest` (A/B uses the harvestable reviewer); `effort-audit.ts` exit 0. Status: open.

## Frontier

**t02** — the seeded playbook is the artifact t03–t05 all wire to and measure against; everything downstream is untestable until it exists with verified evidence links.

## Fog of war

- **Self-arc-24's surface** (other worktree, claim unmerged) — if it touches subagent scripts or the two devops SKILL.md files, rebase-order with the sibling before t03/t04; surface, don't improvise.
- **Reviewer adjudication of plan quality is a weak instrument** (the drive-case learnings say self-report is weak) — mitigated by mechanical cite-counts + mistake checklist as primary; reviewer verdict is corroborating only.
- **GLM-5.3 seed extraction may hallucinate evidence links** — mitigated by t02's mechanical resolution test; expect to drop candidates.
- **Long-term adherence is a convention, not a gate** — a future effort-audit red for "closed without a curator pass" is a candidate follow-up, deliberately out of scope this arc.
- **Whether ≤150 lines stays sufficient** as arcs accumulate — the demote path is the pressure valve; revisit after ~10 closes.

## Immediate executor sequence

1. `bun bun-apps/s2-agent-ext-devops/src/sync-default-branch-cli.ts --mode rebase`; then `prepare-feature-branch-cli` → branch `selfimprove-playbook`.
2. Collision check (per t01), scaffold the effort dir + this map.
3. Write the seed-extraction prompt, dispatch via arc-plan.ts, curate → `.planning/playbook.md` + schema test (t02).
4. t03 flag + tests; t04 SOP edits; run `( cd bun-apps/s2-agent-ext-subagent && bun run check && bun run typecheck && bun test )` (resolve actual script names from its package.json at run time — local_ci resolves by NAME).
5. t05 A/B receipts → `evidence/ab-arc-open/`; t06 PR via `merge_pr_after_local_ci`; t07 close-out + successor + effort-audit exit 0.
6. Never delete a failing A/B receipt — it is the evidence trail.