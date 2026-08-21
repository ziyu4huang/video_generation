---
type: research
claimed: charting-session 2026-08-16
status: closed
---

## Question

Produce KEEP/CUT evidence for the probe-eligible surfaces: (a) WAYFIND 16 ported extra skills (ask-matt, code-review, codebase-design, diagnosing-bugs, handoff, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, subagent-dispatch-discipline, teach, to-questionnaire, triage, wait-what, wizard, writing-for-agents) — primary evidence = usage census: grep each skill name across .planning/** (maps/specs/tickets/ledgers), session-adjacent logs (~/.pi/agent/sessions count if greppable cheaply), and the repo docs; A/B probes (reusing done/2026-07-25-simplify-ext-prompt-weight's harness — locate scripts/probe-runner.ts there) ONLY for ambiguous high-value cases; (b) SUPERPOWERS re-probe of prior-flagged candidates only (verification-before-completion [prior verdict: unloadable], brainstorming [prior: redundant-but-gate-blocked]) — does bootstrap gating still depend on them post using-superpowers changes?; (c) SUBAGENT cut candidates (sacred watchdog EXCLUDED from probing): spawnSubagentSubprocess (any caller? grep repo + manifests), retry-loop-detector, git-scope audit machinery, viewer-stack restructuring options (subagent_runs archive tool vs viewer overlap — dedup/shrink, keeping the tracking substrate), stale dist/ artifacts + dangling jsdoc (subagent-context-widget). Deliverable: per-item verdict table (KEEP/CUT/RESTRUCTURE + evidence line + est. LOC delta), ready for ratification.

## Resolution

### (A) WAYFIND 16 ported skills — usage census

Columns: `planning` = files under `.planning/**` mentioning the name, **excluding this effort's own 22-skill enumeration** (ticket 01 inflates every row by ~1–2; excl counts shown); `xref` = other wayfind skill files referencing it; `code` = `.ts` files outside wayfind mentioning it; `wf-co` = planning files mentioning it AND "wayfind" (skill-context confirmation). Session-log check (`~/.pi/agent/sessions`, first-200-file sample): every skill, incl. the weakest tier, appears in 12+ wayfind-context session files.

| skill | planning(excl) | wf-co | xref | code | LOC | verdict |
|---|---|---|---|---|---|---|
| ask-matt | 10 (8) | 8 | 1 | 0 | 88 | KEEP — dedicated done port effort (`done/2026-08-08-wayfind-port-ask-matt-writing`); roadmap track-E anchor |
| code-review | 31 (29) | 25 | 2 | 7 | 127 | KEEP — roadmap item B; 25 wayfind-context planning files; generic-word risk checked, co-mentions are skill-context |
| codebase-design | 29 (27) | 20 | 2 | 0 | 114 | KEEP — own spec + plan + implementation effort (`2026-08-07-codebase-design-skill*`) |
| diagnosing-bugs | 7 (5) | 5 | 1 | 0 | 142 | KEEP (weak tier) — port ticket `01-port-diagnosing-bugs` + zk-spawn report routing; 13 session wf-co files |
| handoff | 111 (109) | 64 | 2 | 4 | 17 | KEEP — generic word inflates raw count, but 64 wf-co + port batch + roadmap E confirm |
| improve-codebase-architecture | 23 (21) | 20 | 2 | 0 | 84 | KEEP — own effort dir w/ brainstorm output (`2026-08-08-improve-codebase-architecture`); roadmap C |
| prototype | 120 (117) | 50 | 4 | 37 | 26 | KEEP — most xref'd (4) — other skills route to it; 130 session wf-co files |
| research | 254 (252) | 102 | 2 | 99 | 23 | KEEP — generic word, but port ticket 02 + 102 wf-co + routing target (`findings.md`/`research/` convention) |
| resolving-merge-conflicts | 11 (9) | 9 | 1 | 0 | 16 | KEEP (weak tier) — port batch + roadmap D; all 9 hits skill-context |
| subagent-dispatch-discipline | 6 (4) | 4 | 1 | 0 | 52 | KEEP (weak tier) — created by `done/2026-08-09-subagent-efficiency-guardrails` ticket 05; 12 session wf-co |
| teach | 13 (11) | 8 | 1 | 10 | 142 | KEEP — 8 wf-co; zk-spawn report section; code hits partly generic-word, planning side is clean |
| to-questionnaire | 6 (4) | 4 | 1 | 0 | 55 | KEEP (weak tier) — port batch + report artifact-convention reference; 12 session wf-co |
| triage | 28 (26) | 18 | 1 | 3 | 112 | KEEP — `/triage` is a registered wayfind slash command (commands.ts) — load-bearing beyond skill body |
| wait-what | 8 (6) | 6 | 1 | 0 | 13 | KEEP (weak tier) — dedicated port ticket 03; 13 session wf-co files |
| wizard | 6 (4) | 4 | 1 | 0 | 44 | KEEP (weak tier) — port batch + zk-spawn report `### wizard` section; 65 session wf-co files |
| writing-for-agents | 5 (3) | 3 | 1 | 0 | 83 | KEEP (weak tier) — dedicated done port effort (paired with ask-matt); 12 session wf-co |

**Net (A): 16/16 KEEP, 0 CUT.** No skill has planning=0 (the CUT bar); even excluding port-history, each has ≥3 skill-context planning refs + session-log exposure. Honest caveat: evidence is dominated by port-history/roadmap/report references rather than observed `/wayfind`-command invocations; "weak tier" (diagnosing-bugs, resolving-merge-conflicts, subagent-dispatch-discipline, to-questionnaire, wait-what, wizard, writing-for-agents) survives on that basis alone — if ratification wants a harder bar (live invocation only), re-probe the weak tier via A/B before cutting. Cheapest weak-tier cut would save only ~365 LOC total across 7 skills — poor risk/return vs. breaking wayfind cross-routing.

### (B) SUPERPOWERS re-probe

- **verification-before-completion → CUT, but gate-attached (conditional).** Runtime: already UNREGISTERED by default — `src/superpowers.ts:46` `DEFAULT_SKILL_EXCLUDE` (Phase-3 clean-pass, ADR-0008); zero runtime load today. But it is **load-bearing for a test gate**: `tests/skills-fidelity.test.ts:40` `PORTED_SKILLS` list reads `skills/verification-before-completion/SKILL.md` (120 LOC) byte-compared to its fixture (120 LOC), and `skills/systematic-debugging/SKILL.md:189` cross-references it (that file is itself byte-pinned — editing it needs a rebaseline). Cut path: delete skill dir + fixture, drop the `PORTED_SKILLS` entry, edit systematic-debugging L189 + rebaseline its fixture. Est. delta: **−241 LOC + 2-line edit + 1 rebaseline**. Verdict stands as prior ("unloadable") and the gate dependency is the only blocker — safe to cut in a cleanup PR that touches the fidelity fixtures atomically.
- **brainstorming → KEEP (redundant-but-gate-blocked, prior verdict confirmed).** Load-bearing today: (1) `skills/using-superpowers/SKILL.md` L22+L30 hard-routes "before plan mode → brainstorming first" (using-superpowers is byte-pinned AND its body is injected by bootstrap — the reference is live glue); (2) `src/superpowers.ts:288` phase table routes DESIGN → brainstorming; (3) listed in both `tests/skills-fidelity.test.ts` and `tests/skills.test.ts` expected sets. Payload is 1,165 LOC (SKILL.md 151 + visual-companion.md 291 + scripts/server.cjs 723) — the server.cjs visual companion is the fat part and is NOT referenced by any gate; **RESTRUCTURE option: cut `visual-companion.md` + `server.cjs` (−1,014 LOC) after confirming no runtime references**, keep SKILL.md (gate-pinned). Full cut would need using-superpowers rebaseline + phase-table edit + 2 test lists — not worth it.

### (C) SUBAGENT candidates (watchdog excluded, per ticket)

1. **spawnSubagentSubprocess → KEEP.** One real external caller: `pi-agent-ext-obsidian/src/lib/subagent.ts` (import L3 + call L308). It is the package's public cross-package API (also re-exported via `index.ts`; consumed by obsidian). Cut breaks obsidian. 403 LOC (spawn-subagent-subprocess.ts) + 149 (detach-run.ts companion).
2. **retry-loop-detector.ts → KEEP.** 94 LOC + 168-line test; single live consumer `subagent-tool.ts:36` — i.e., it guards the actual dispatch path. Cutting saves ~262 LOC but removes retry-loop protection from live dispatch; poor trade. Not cuttable under the code>0 rule.
3. **git-scope.ts → KEEP (core machinery).** 148 LOC with **6 importers** (subagent-tool, subagents-tool, subagent-tool-run, subagent-tool-schema, child-dispatch, subagent-run-persistence) + dedicated test — this IS the scope-audit substrate; cutting ripples through the whole dispatch path.
4. **subagent-runs-tool.ts (198) vs subagent-viewer.ts (717) → KEEP both; no RESTRUCTURE needed.** Unique surfaces: (i) runs-tool is model-callable (defineTool, list/get actions, status/cwd filters, includeHistory, token stats) reading **durable cross-session records** (`~/.pi/subagents/runs`, last-200); (ii) viewer is the human `/subagents` TUI (list/output/**follow** modes) reading the **in-flight registry + session branch**; (iii) overlap is limited to status vocabulary + preview formatting, most of which already lives in shared `time-format.ts` (19 LOC) / core-runtime helpers; (iv) different data stores entirely — durable JSON records vs live registry/branch; (v) neither can absorb the other without conflating model-tool and TUI concerns. Optional micro-dedup (~30 LOC shared fmt) is not worth the churn. Keeping the tracking substrate = keeping runs-tool + persistence, which this does.
5. **Stale dist/ + dangling jsdoc → CUT (trivial cleanup).** `dist/` is git-IGNORED (local build output only) and contains `subagent-context-widget.{js,d.ts}` whose source `src/subagent-context-widget.ts` **no longer exists** (23 src files, none named context-widget). Dangling reference: `src/subagent-tool-render.ts:363` jsdoc `{@link SubagentContextWidget}` — symbol gone, 1-line fix. Est. delta: **~0 repo LOC (dist ignored) + 1-line jsdoc edit + `rm -rf dist && rebuild` locally.**

### Method note

Census run per the task's exact loop from repo root (`grep -rli` over `.planning --include=*.md`; xref over wayfind skills dir excluding self; code over `bun-apps --include=*.ts` excluding wayfind). Two refinements found necessary: (1) this effort's own ticket-01 22-skill enumeration self-inflates every planning count — re-ran excluding `2026-08-16-simplefied-redesign*` (excl column); (2) generic-word skills (research/prototype/handoff/triage/teach/code-review/wizard) validated by "wayfind" co-mention per file (wf-co) + one-line spot-checks — e.g. raw `prototype`/`handoff` hits include coincidences ("Live prototype ticket", "## Execution handoff") but wf-co subsets are skill-context. Session logs (`~/.pi/agent/sessions`, 542 MB) greppable cheaply via head-200-file sample — weak-tier skills show 12–65 wayfind-context session files each. macOS BSD grep: `-m1` cannot be compounded with other flags (`-rmi1` silently fails under `2>/dev/null`) — use `-m 1` separately or per-file grep. No A/B probes needed: no skill landed in AMBIGUOUS after wf-co + session confirmation. All subagent evidence from single-file greps + file heads + `git check-ignore`.
