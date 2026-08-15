# zk-spawn: .planning/ state enumeration (PARTIAL — budget stopped inspection)

Task: enumerate `.planning/` efforts, classify each (status / stage / wayfind? / webui?), quote status evidence, report git log.

**Completeness note:** directory enumeration is COMPLETE (every folder listed below).
Content inspection is PARTIAL — maps/specs read for ~20 of 33 non-done efforts before the
token budget cut inspection. `done/` entries were classified by location alone (the repo's
convention: `done/` = finished, archived). Unread items are marked `inspected: no`.

## 1. Top-level inventory

- Effort folders at `.planning/` root: 33 (list below)
- `.planning/done/`: 152 archived efforts (finished)
- `.planning/specs/`: 65 flat design specs
- `.planning/plans/`: 73 flat plan records
- `.planning/sdd/`: 0 files (empty fallback dir)
- `.planning/knowledge/`: 8 knowledge docs (not efforts)
- Loose files: CONVENTIONS.md, UPSTREAM-SOURCES.md, REVIEW-2026-08-08.md,
  REVIEW-2026-08-15-ext-four-packages.md, REVIEW-2026-08-15-pi-agent.md

## 2. Root efforts (33) — status evidence quoted where read

| Effort | Purpose | Status | Stage | wayfind? | webui? | Evidence (verbatim) | inspected |
|---|---|---|---|---|---|---|---|
| 2026-07-19-goal-todo-handoff-stopgap | Manual goal/todo hand-off protocol | done (superseded) | — | no | no | "Shipped as **PR #678**… SUPERSEDED by 2026-07-19-a" | yes |
| 2026-07-20-brainstorm-code-review-bun-apps-pi-agent-ext-too | Brainstorm code review of tool-gate ext | abandoned (empty map) | DECIDE | yes | no | "## Decisions so far\n\n<!-- none yet -->" | yes |
| 2026-07-25-biome-check-organize-imports-error-fix-it | Fix biome organize-imports error | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-25-do-we-have-cron-monitor-to-implment-auto-merge-i | Cron monitor for auto-merge? | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-25-improve-obsidian | Obsidian ext: type guardrails + god-file split + bug fixes | undecided (spec only, no Status: done marker found) | DESIGN | no | no | spec: "四階段、各自獨立 commit" (no completion marker seen) | yes |
| 2026-07-25-next-unfinished | "next unfinished" router | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-25-simplify-bun-apps-deps | Trim bun-apps deps + wayfind↔superpowers boundary | in-progress/unclear (spec says "design approved", plan exists, no done marker) | EXECUTE (plan.md exists) | no | no | "Status: design approved (all sub-decisions resolved)" | yes |
| 2026-07-25-simplify-ext-prompt-weight | Cut extension prompt token cost | DONE | — | no | no | "# Status: COMPLETE (2026-07-26)" (COMPLETED.md) | yes |
| 2026-07-25-simplify-pipeline-routing | Collapse piBoundaryOverrides 4 rules → 2 | undecided (spec only, no plan) | DESIGN | no | no | spec present w/ literal target text; no plan/Status: done | yes |
| 2026-07-26-model-preset-system | Named model-tier presets for subagent ext | undecided | DESIGN | no | no | "Status: design (awaiting approval)" | yes |
| 2026-07-29-add-goal-find-out-why-status-bar-always-show-ret | RCA: status-bar retry-loop message | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-29-continue-01-5-ticket-01-grilling-config-knob-aut | Continue 5-ticket grilling set (memory routing) | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-31-finding-if-there-wroks-not-merge-to-remote-defau | Find unmerged work; summarize tool-gate | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-07-31-let-s-continue-to-improve-base-on-known-upstream | 14 upstream-improvement tickets | in-progress (16 tickets + handoff doc; map not read before cutoff) | EXECUTE (tickets exist) | no | no | files: tickets/01–14, handoff-watchdog-hardening.md | no |
| 2026-08-01-continue-improve-the-pipeline-between-extension- | 6 tickets: ext↔ext pipeline (file2md→hub) | in-progress (map not read) | EXECUTE (tickets exist) | no | no | files: tickets/01–06 | no |
| 2026-08-01-let-s-review-any-where-about-control-agent-reply | Audit reply-language control sites | in-progress (1 ticket, map not read) | EXECUTE | no | no | tickets/01-audit-reply-language-control-sites.md | no |
| 2026-08-01-what-s-to-do-next | Router effort → hermes stable-ID | done (routing decision made) | — | yes | no | "PR #980 … merged to main — effectively closes the … effort" | yes |
| 2026-08-02-01 | unknown ("01") | abandoned (empty map) | DECIDE | yes | no | "## Destination\n\n01" | yes |
| 2026-08-02-02 | unknown ("02") | abandoned (empty map) | DECIDE | yes | no | "## Destination\n\n02" | yes |
| 2026-08-02-06-used-signal | Hermes "used vs dropped" memory signal | in-progress (spec+plan+SDD reviews exist; no COMPLETED marker) | EXECUTE | no | no | plan: "one implementer subagent per task … reviewer APPROVE/CHANGES" | yes |
| 2026-08-02-any-other-tickets-related-memory-not-finished-ye | Query: unfinished memory tickets? | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-08-02-base-on-the-remaning-backlogs | Router from remaining backlogs | abandoned (empty map) | DECIDE | yes | no | "<!-- none yet -->" | yes |
| 2026-08-02-map-state-planning-2026-08-02-migration-complete | Resume tool-gate GATES migration (ticket 04) | in-progress (map not fully read; migration later completed per done/ entries — likely superseded/done) | EXECUTE | no | no | "Next pick: 04 — rollout file2md" | yes (partial) |
| 2026-08-02-try-to-checkout-code-use-gh-and-learning-from-ht | 6 hermes tickets (rejected ledger, pin field, used-signal…) | in-progress (map not read) | EXECUTE | no | no | tickets 01–06 | no |
| 2026-08-08-knowledge-pipeline | 21 tickets: hermes/LeanRAG knowledge layer | in-progress (largest live effort: 21 tickets, brainstorm/, plans/×6, map) | EXECUTE | no | no | files: tickets/01–21, plans/ incl. 2026-08-10-planning-sync.md | no |
| 2026-08-09-inspect-hooks-phase2-firing-counts | Hooks phase-2 firing counts | in-progress (spec+plan+2 SDD brief/report pairs, no done marker) | EXECUTE | no | no | sdd brief/report task1+task2 | no |
| 2026-08-10-hermes-architecture-deepening | 4 tickets: codec unification, lite cards, dedup | in-progress (map not read before cutoff) | EXECUTE | no | no | files: tickets/01–04, architecture-review, lessons.md | no |
| 2026-08-10-pi-agent-ext-webui-from-scratch | Build pi-agent-ext-webui from scratch | likely done (only sdd/03 progress.md left at root; sibling `done/2026-08-10-pi-agent-ext-webui-from-scratch` exists) | done/archived | no | YES | root folder holds only sdd/03-agentic-mutex-plan/progress.md | no |
| 2026-08-15-cc-subagent-tui | 8 tickets: CC-style subagent TUI | in-progress — ACTIVE (git log: tickets 01–07 marked done, wave 2 complete) | EXECUTE | no | TUI-adjacent (no) | "docs(planning): cc-subagent-tui ticket 07 done (PR #1437)" | no |
| 2026-08-15-snapshot-row-single-source | 5 tickets: single-source snapshot row | in-progress (map.md, plan.md, spec.md, tickets 01–05) | EXECUTE | no | TUI-adjacent (no) | git: runview-phase2 landed; effort not in done/ | no |
| devops-sync-reporting | DevOps sync reporting effort state | in-progress (STATE-zk-spawn.md + round2; latest commit 52fb2fc0 "hand-off") | EXECUTE | no | no | STATE-zk-spawn-round2.md (not read) | no |
| zk-spawn | THIS task label; holds interactive-result-ui research | in-progress | — | — | — | zk-spawn/interactive-result-ui-research.md (not read) | no |

## 3. done/ (152 efforts) — archived, all treated as DONE

Sample titles suggest heavy webui overlap late in the list, e.g.:
`2026-08-13-explorer-pi-agent-webui-presentatoin-and`, `2026-08-14-build-hitl-webui`,
`2026-08-15-btw-panel-in-webui`, `2026-08-15-runview-phase2-agentrow`,
`2026-08-15-src-entry-migration`, `2026-08-15-subagent-budget-knob`.
Full list captured in §6.

## 4. Flat dirs

- `.planning/specs/` (65): design specs incl. webui-adjacent
  `2026-07-18-subagent-tui-visibility-design.md`.
- `.planning/plans/` (73): plan records.
- `.planning/sdd/`: empty.

## 5. git log (.planning/, last 15) — verbatim

```
52fb2fc0 docs(planning): devops-sync-reporting effort state and hand-off
eac1151e docs(planning): cc-subagent-tui ticket 07 done (PR #1437) (#1438)
0ed6776d docs(planning): cc-subagent-tui ticket 06 done; wave 2 complete (#1434)
fbfd891e chore: housekeeping — btw-panel sdd review diffs, zk-spawn research, glm-5.3 bump, src-entry next-goal ledger (#1427)
92d119c8 docs(planning): mark cc-subagent-tui ticket 05 done (#1425) (#1426)
62b5b537 docs(planning): kp13 wave-a handoff + wave-c report (sdd artifacts) (#1424)
dbe5e2da docs(planning): mark cc-subagent-tui ticket 04 done (#1416); wave 1 complete (#1417)
2af44ade docs(planning): mark cc-subagent-tui ticket 03 done (#1414) (#1415)
50a955a4 docs(planning): mark cc-subagent-tui ticket 02 done (#1412) (#1413)
eeaca435 docs(planning): mark cc-subagent-tui ticket 01 done (#1410) (#1411)
5036564d refactor(pi-agent): retire the stale-dist machinery (ticket 05 — effort complete) (#1406)
8fbd9952 fix(core-runtime): hard-cap budget grace window (1.25x ceiling) (#1405)
aeff501b feat(workflow): src-entry migration — the blast-radius package (ticket 04) (#1403)
3ff2c856 docs(planning): cc-subagent-tui implementation plan (writing-plans) (#1404)
25000f35 feat(superpowers,wayfind): src-entry migration (ticket 03) (#1401)
```

## 6. done/ full list (152)

2026-07-19-a, 2026-07-19-brainstorm-how-to-improve-wayfind-extension-fina,
2026-07-19-build-plan-coordinator, 2026-07-19-load-map,
2026-07-19-review-the-workflow-pack-feature-via-pi-agent-ex,
2026-07-20-is-it-possible-to-automate-reduce-memory-to-allo,
2026-07-21-brainstorm-code-review-bun-apps-pi-agent-ext-way,
2026-07-21-land-superpowers-wayfind-boundary,
2026-07-21-review-bun-apps-pi-agent-ext-superpowers-see-if-,
2026-07-22-brainstorm-and-code-review-to-improve-bun-apps-p,
2026-07-23-self-reflection-to-improve-these-related-pi-agen,
2026-07-23-the-tool-schema-api-cost-too-much-how-to-continu,
2026-07-23-try-to-add-gate-to-verify-tool-gate-extension-qa,
2026-07-23-try-to-convert-archify-into-bun-apps-pi-agen-ext,
2026-07-23-wayfind-done-command, 2026-07-24-continue-brainstorm-what-to-improve-tool-gate-ex,
2026-07-24-extract-subagent-package, 2026-07-25-align-superpowers-with-subagent-ext,
2026-07-25-brainstorm-review-new-subagent-move-to-bun-apps-,
2026-07-25-close-measurement-action-loop-coverage,
2026-07-25-core-task-list-loop-the-continue-develop-frontie,
2026-07-25-do-as-you-suggesnt-then-continue-develop,
2026-07-25-hermes-memory-neutralize-remaining-sqlite-strings,
2026-07-25-i-think-it-works-fine-let-s-continue-study-next-,
2026-07-25-inspect-hooks-hook-observability,
2026-07-25-just-write-spec-for-next-iter-after-self-reflect,
2026-07-25-p1-p0-p1-keyword-i-1-i-5-tradeoff-want-need-i-wa,
2026-07-25-pi-ext-subagent-need-improve-it-s-tui-subagent-a,
2026-07-25-review-the-slash-command-memory-sync-markdown-it,
2026-07-25-subagent-always-on-progress-widget,
2026-07-25-subagents-tui-relocate-to-subagent-pkg,
2026-07-25-tool-gate-audit, 2026-07-25-what-more-inspect-tool-need-add-for-pi-agent-ext,
2026-07-26-adopt-upstream-sdd-reworks, 2026-07-26-continue-improve,
2026-07-26-critical-path-integration-tests,
2026-07-26-explorer-other-pi-agent-ext-in-bun-apps-see-any-,
2026-07-26-known-issues-disposition, 2026-07-26-restore-main-ci-827-regressions,
2026-07-26-unify-subagent-model-config, 2026-07-26-wayfind-skill-content-review,
2026-07-27-perfect-wayfind-superpowers-core-task-coexistence,
2026-07-28-continue-improve-wayfind-superpowers-including-h,
2026-07-28-finding-b-syncmarkdownmemories-per-entry-n-1-908,
2026-07-28-hermes-lock-path-instrumentation,
2026-07-28-hermes-surrealdb-graph-search,
2026-07-28-study-and-write-to-obsidian-vualt-notes-users-hu,
2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory,
2026-07-29-persistent-to-planning, 2026-07-30-file2md-for-pdf-file-it-should-be-able-to-direct,
2026-07-30-hermes-failure-memory-md-41-112-71-memory-search,
2026-07-30-let-s-use-wayfind-superpower-ext-angle-to-review,
2026-07-30-self-reflection-to-fix-these-error,
2026-07-30-spawn-pi-enoent-resolved, 2026-07-30-subagents-viewer-redesign,
2026-07-31-5d-stable-id-md-status-frontmatter-5b-content-ke,
2026-07-31-core-task-length-continue, 2026-07-31-core-task-quota-retry,
2026-07-31-watch-dot, 2026-07-31-why-startup-s2-agent-sh-so-slow,
2026-08-01-2026-07-31-5d-stable-id-take-04-two-follow-ups-s,
2026-08-01-a-new-pi-agent-ext-response-language-i-don-t-wan,
2026-08-01-charting-2026-08-01-uncommitted-planning-memory-,
2026-08-01-continue-the-map-to-finding-all-response-languag,
2026-08-01-docs-superpowers-plans-is-use-by-claude-code-s-o,
2026-08-01-forced-reply-language-injection, 2026-08-01-hermes-legacy-id-graph-orphan,
2026-08-01-look-for-a-lighter-alternative-before-we-commit-,
2026-08-01-subagents-live-visibility, 2026-08-01-subagents-visibility-finish,
2026-08-01-ticket08, 2026-08-01-two-natural-next-steps-whenever-you-want-them-ch,
2026-08-01-what-s-next-for-subagent-develop-map,
2026-08-02-05-session-roll-up-all-landed-pr-what-1005-herme,
2026-08-02-1b-decay, 2026-08-02-await-pr-merge-behind-dirty-tree-rca,
2026-08-02-can-we-harden-spec-plan-then-start-develop,
2026-08-02-core-task-review, 2026-08-02-devops-sweep-branches-tool,
2026-08-02-hardening-to-resolve-problem-we-find-about-wrong,
2026-08-02-hermes-dangling-reference-sweep, 2026-08-02-hermes-failure-lifecycle,
2026-08-02-hermes-memory-pin-field, 2026-08-02-hermes-numeric-isolation,
2026-08-02-hermes-proactive-consolidation,
2026-08-02-improve-extension-co-operation-less-hard-couplin,
2026-08-02-improve-wayfind-tui, 2026-08-02-migration-complete-end-to-end-recap-you-kicked-o,
2026-08-02-subagents-completed-visibility-4b,
2026-08-02-subagents-mid-flight-intervention, 2026-08-02-taxonomy-gating-field-migration,
2026-08-02-wayfind-interactive-widget, 2026-08-03-start-scoping-the-core-tools-migration,
2026-08-04-final-state-both-migrations-complete-correct-com,
2026-08-04-improve-superpowers-wayfind,
2026-08-04-scripts-pr-finish-sh-i-want-this-script-hardenin,
2026-08-04-tell-me-what-zk-spwan-is-doing-is-it-parts-of-kc,
2026-08-05-archify-deck-builder,
2026-08-05-let-s-continue-to-learning-from-prevous-wayfind-,
2026-08-07-continue-improve-pi-ext-subagents-related-still-,
2026-08-07-current-subagent-run-show-in-context-and-bottom-,
2026-08-07-find-resolve-path,
2026-08-07-fix-skill-conflicts-pi-memory-bulk-dedup-collisi,
2026-08-07-how-is-current-memory-finding-duplicate-conflict,
2026-08-07-i-ll-sync-via-the-proper-tool-this-time-scripts-,
2026-08-07-let-s-self-reflection-base-on-wayfind-error-and-,
2026-08-07-move-sync-into-devops,
2026-08-07-we-need-configurable-subagent-paralel-run-to-fol,
2026-08-07-yes-look-at-it-and-let-s-unified-all-to-pi-agent,
2026-08-08-code-quality-roadmap, 2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task,
2026-08-08-improve-codebase-architecture,
2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or,
2026-08-08-subagent-display-ux, 2026-08-08-subagent-expanded-display-flicker,
2026-08-08-subagents-follow-model-preset, 2026-08-08-wayfind-architecture-deepening,
2026-08-08-wayfind-port-ask-matt-writing, 2026-08-08-wayfind-port-new-skills,
2026-08-08-wayfind-skill-resync, 2026-08-09-gate-recall-guard,
2026-08-09-merge-deploy-into-devops,
2026-08-09-merge-tool-gating-contract-into-core-interface,
2026-08-09-subagent-efficiency-guardrails, 2026-08-09-subagent-tui-toolcall-pairing,
2026-08-09-subagent-upstream-sync, 2026-08-09-subagent-workflow-tsconfig-strictness,
2026-08-10-improve-subagents-batch-tui, 2026-08-10-pi-agent-ext-webui-from-scratch,
2026-08-10-simplify-recent-code, 2026-08-10-subagent-tool-split,
2026-08-10-superpowers-tighten-and-document,
2026-08-11-extensions-browser-distinguish-skill-commands,
2026-08-11-knowledge-card-typecheck-gate, 2026-08-11-merge-pi-agent-cli-into-pi-agent,
2026-08-11-superpowers-bootstrap-trim, 2026-08-12-subagent-cluster-reconciliation,
2026-08-12-unified-merge-all-exsting-unfinished-knowledge,
2026-08-13-explorer-pi-agent-webui-presentatoin-and,
2026-08-13-search-wayfind-effort-then-continue-previous,
2026-08-14-build-hitl-webui, 2026-08-14-subagent-workflow-arch-review,
2026-08-15-btw-panel-in-webui, 2026-08-15-runview-phase2-agentrow,
2026-08-15-src-entry-migration, 2026-08-15-subagent-budget-knob,
check-and-actually-see-use-context-inspect-tool-, core-runtime-extraction,
i-want-the-default-vault-root-can-be-store-in-pi,
let-s-make-superpower-status-can-full-integrate-,
perment-solve-these-issues-architecturely,
review-pi-agent-deploy-single-exec-binary-ensure

## 7. Not yet done (hand-off)

Read these to finish classification: map.md of
2026-07-31-let-s-continue-to-improve…, 2026-08-01-continue-improve-the-pipeline…,
2026-08-01-let-s-review-any-where-about-control-agent-reply,
2026-08-02-try-to-checkout-code…, 2026-08-08-knowledge-pipeline,
2026-08-09-inspect-hooks…, 2026-08-10-hermes-architecture-deepening,
2026-08-15-cc-subagent-tui, 2026-08-15-snapshot-row-single-source;
plus devops-sync-reporting/STATE-zk-spawn-round2.md and zk-spawn/interactive-result-ui-research.md.
