# Spec — 2026-08-22 ultracode rename

## Requirements

1. Remove repo-local `.pi/` (user: "not needed") without breaking run-dir
   loading. Constraint: `~/.pi/` home state dir untouched (upstream by design).
2. Align `s2-agent-ext-workflow` naming with Claude Code's "ultracode"
   branding at the depth the user chose: directory rename + `ultracode`
   trigger keyword; tool name `run_workflow` / registry label `workflow` /
   `/workflows*` commands stay (Claude Code's tool is also named Workflow —
   "ultracode" is only the arming keyword).
3. `s2-agent-ext-devops` must still deploy to `s2-agent-sh/` — deploy list is
   a projection of `the registry YAML`, so the registry edit must keep
   the workflow entry shippable (deploy.order 70) and Gate 3's `--ext-list`
   must still load `workflow`.

## Trigger-word design

- `DEFAULT_KEYWORD_TRIGGER_WORDS = ["workflow", "ultracode"]` (as const),
  `DEFAULT_KEYWORD_TRIGGER_WORD` = first of list (settings default unchanged).
- `effectiveTriggerWords(word)`: a still-default word means no user override →
  ALL defaults arm; a custom word replaces the whole list.
- Plural special-case (`workflows`) applies to `workflow` only.
- TS trap: parameter defaults inferred from `as const` tuple members keep the
  literal type — explicit `triggerWord: string =` annotations required.

## Results

| Gate | Result |
|---|---|
| ultracode pkg `bun run test` (biome + 1106 tests) | ✅ |
| s2-agent cross-package `typecheck` | ✅ |
| tool-gate `bun test` (434) | ✅ |
| movie-director `bun test` (909) | ✅ |
| bun-apps/tests contracts (125) | ✅ |
| devops `bun test` (633, incl. ci-matrix) | ✅ |
| bun.lock no-diff after `bun install` | ✅ |
| devops deploy → s2-agent-sh (Gate 3 --ext-list) | ✅ final: 0.1.0+g1f73488, 16 exts loaded, `ultracode` present, ext/ultracode/ in tree (interim 0.1.0+g142a4d3 verified with old short name before the registry-name follow-up) |
| bun-apps/tests contracts (after name change) | ✅ 124/124 |
| bun run test:adr | ✅ 19/19 |

## Registry short-name follow-up (same branch, commit 1f7348852)

Initial plan kept registry `name: workflow`; the dep-guard push hook caught
that scanners derive the package dir as `s2-agent-ext-<name>` (tests/lib/
registry-base-set.ts, isolation contract entry path, static-extensions-gen),
so the short name moved to `ultracode` too — name ↔ package ↔ entry now all
agree. Follow-on identities: ADR-workflow-NNNN → ADR-ultracode-NNNN,
BUN_PI_WORKFLOW → BUN_PI_ULTRACODE, deploy tree ext/workflow → ext/ultracode.
Kept unchanged regardless: tool names (run_workflow…), /workflows* commands,
tool-gate family id `workflow` (independent of registry naming).
