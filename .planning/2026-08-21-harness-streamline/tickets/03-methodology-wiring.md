---
type: task
blocking: 1
---

## Question

Wire the EXISTING (unreferenced) document-reviewer prompts as the spec/plan critic pass: pointer lines in `skills/using-superpowers/references/pi-routing.md` + `pi-tools.md` — after writing a spec or plan, BEFORE execution, dispatch a reviewer subagent using `skills/brainstorming/spec-document-reviewer-prompt.md` (specs) / `skills/writing-plans/plan-document-reviewer-prompt.md` (plans). Zero SKILL.md edits → no rebaseline, no LOCAL-DIVERGENCE entry. Composes with host `pipeline-gate.ts` (parses `### Task N` + Run:/Expected:) — reviewer critiques the artifact, host gate validates markers; no parallel gate. Also: ADR-0008 note recording D4 rationale (verification-before-completion stays deleted; verify gate = host pipeline-gate). Basis: D2 amendment (supersedes ticket-08's sweep-if-unreferenced line for spec-document-reviewer-prompt.md).
