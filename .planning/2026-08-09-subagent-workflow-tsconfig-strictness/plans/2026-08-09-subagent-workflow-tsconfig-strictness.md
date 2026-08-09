# Plan: subagent/workflow tsconfig strictness + LinkWeighting export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Single cohesive task (type-only).

**Goal:** Turn on `noUncheckedIndexedAccess` in the subagent + workflow extension tsconfigs, narrow every flagged site, and fix the knowledge-card `LinkWeighting` re-export — so 7 packages typecheck green, with zero runtime behavior change.

**Architecture:** Type-only narrowing. The "test" is `tsc --noEmit` red->green plus existing suites staying green (behavior preserved).

**Tech Stack:** TypeScript, Bun, `bun:test`.

## Global Constraints

- **TYPE-ONLY:** no runtime behavior change. Prefer narrowing guards (`if`/optional-chaining/early-return) that preserve existing semantics. Use `!` ONLY where there is a provable invariant, with a one-line `// invariant: ...` comment. Any site where undefined-handling must change semantics MUST be called out in the report.
- **TUI correctness:** `tool-action-label.ts` + `subagent-tool.ts` drive the subagent trace (the pairing fix from PR #1161). Render output must be byte-identical for defined inputs — narrowing must not drop a rendered line.
- No new dependencies. No reformatting beyond the touched lines.
- The flag must land IN `tsconfig.json` (not a CLI-only override) so consumers inherit it.
- workflow's errors include subagent's (it compiles subagent src); fixing subagent's sites clears most of workflow's. workflow-own sites are independent.

## Acceptance

- `bun run typecheck` GREEN for: pi-agent-ext-subagent, pi-agent-ext-workflow, pi-agent-ext-knowledge-card, pi-agent-ext-movie-director, pi-agent-ext-obsidian, pi-agent-cli, pi-agent.
- `bun test` GREEN for: pi-agent-ext-subagent, pi-agent-ext-workflow, pi-agent-ext-knowledge-card.

## File Structure

- `bun-apps/pi-agent-ext-subagent/tsconfig.json` (MODIFY) — add `noUncheckedIndexedAccess`.
- `bun-apps/pi-agent-ext-workflow/tsconfig.json` (MODIFY) — add `noUncheckedIndexedAccess`.
- `bun-apps/pi-agent-ext-subagent/src/{subagent-tool,subagents-tool,tool-action-label,watchdog/repo-diff}.ts` + `tool-action-label.test.ts` (MODIFY) — narrow ~27 src + 2 test sites.
- `bun-apps/pi-agent-ext-workflow/src/{task-panel,web-tools,workflow-editor,workflow-tool,workflow-ui}.ts` (MODIFY) — narrow ~14 sites.
- `bun-apps/pi-agent-ext-knowledge-card/src/{loop|retrieve}.ts` (MODIFY) — resolve `LinkWeighting` import.

## Task 1 — Enable flag, narrow all flagged sites, fix LinkWeighting

See `sdd/2026-08-09-subagent-workflow-tsconfig-strictness/briefs/task-1-brief.md` for the exact error map and step-by-step. Reproduce live errors with the per-package `bun run typecheck` after enabling the flag; narrow each; verify the 7 packages green + 3 suites green; commit.
