# 01 — Deploy alignment: exclusion refreshed + package structure deploy-ready

**Status: closed (2026-08-23)**

## Task

Confirmed and refreshed the s2-agent-sh deploy exclusion for `file2md` +
`devops`, and aligned file2md's package shape to what a shipped extension looks
like.

## Work done

- `bun-apps/s2-agent/src/registry-config.ts` — file2md entry gains `skills: true`
  and a refreshed `excludeReason` (v1: "mupdf native/wasm + hard LM Studio"; v2:
  "vendored OCR assets + optional local vision layer — kept out of the portable
  core by scope policy (deploy-ready structure)"). devops entry untouched
  (`repo-internal tooling`).
- `bun-apps/s2-agent/docs/deploy.md` §Limits — file2md rationale rewritten to the
  v2 reality (bun-only, excluded by size/scope policy; `ADR-file2md-0001` ref).
- Deploy-report test still pins `file2md` + `s2-agent-ext-devops` in
  `excludedExtensions()` with non-empty reasons (verified green).

## No-ops measured (performed, not assumed)

The exclusion already worked in the shipped artifact:
`~/proj/dist/s2-agent-sh/current/ext/` lists 17 of 26; the report's
"Extensions — excluded" table names file2md + devops; registry identical to the
deploy worktree's (`git diff` empty). No real deploy was run — the deploy
worktree belongs to another session (`cc-parity-task-ext` WIP).

## Gate

`bun run --cwd bun-apps/s2-agent regen:manifest` + `s2-agent-ext-devops`
deploy-report test (9 pass).
