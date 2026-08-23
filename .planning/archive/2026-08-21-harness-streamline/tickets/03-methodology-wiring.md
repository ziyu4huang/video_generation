---
type: task
blocking: 1
---

## Question

Wire the EXISTING (unreferenced) document-reviewer prompts as the spec/plan critic pass: pointer lines in `skills/using-superpowers/references/pi-routing.md` + `pi-tools.md` — after writing a spec or plan, BEFORE execution, dispatch a reviewer subagent using `skills/brainstorming/spec-document-reviewer-prompt.md` (specs) / `skills/writing-plans/plan-document-reviewer-prompt.md` (plans). Zero SKILL.md edits → no rebaseline, no LOCAL-DIVERGENCE entry. Composes with host `pipeline-gate.ts` (parses `### Task N` + Run:/Expected:) — reviewer critiques the artifact, host gate validates markers; no parallel gate. Also: ADR-0008 note recording D4 rationale (verification-before-completion stays deleted; verify gate = host pipeline-gate). Basis: D2 amendment (supersedes ticket-08's sweep-if-unreferenced line for spec-document-reviewer-prompt.md).

## Resolution

Landed 2026-08-21 (phase S7, branch feat/superpowers-s7-reviewer-wiring). The existing-but-unwired reviewer templates are now the sanctioned spec/plan critic pass: pi-routing.md gains "Reviewer second pass (specs + plans)" (dispatch a reviewer subagent with the template BEFORE execution; composes with host pipeline-gate, never replaces it); pi-tools.md gains the dispatch mechanics (read-only reviewer: no commitScope/watchdog). ADR-0008 amendment records D4 (v-b-c stays deleted; verify gate = host pipeline-gate + reviewer pass; exclude entry kept as inert history). references.test.ts pins the wiring incl. template existence. Zero SKILL.md edits — no rebaseline, no divergence rows. Gates: superpowers 140/0 + typecheck; adr-citation/skill-reference/routing-contract 24/0.

closed: (landed)
