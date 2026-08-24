# Map — 2026-08-22 ultracode rename

## Scope

Three-part effort on branch `feat/ultracode-rename`:

1. **Repo `.pi/` removal** (commit `ad74a08db`) — dangling devops-workflow
   symlink + orphan pre-plan-runtime-validation skill (recover: `git show
   4056f33`); `.gitignore` comment rewritten. Run-dir loading never required
   repo `.pi/` (manifest-driven, `s2-agent/run-dir/resolve.ts`).
2. **Package rename `s2-agent-ext-workflow` → `s2-agent-ext-ultracode`** —
   Claude Code "ultracode" branding alignment. Tool names, registry label
   `name: workflow`, `/workflows*` commands, gate family id unchanged
   (Claude Code's tool is also named Workflow; "ultracode" is its arming
   keyword). Entry file renamed `extensions/workflow.ts` → `extensions/ultracode.ts`
   because `static-extensions-gen.ts` hard-codes the `s2-agent-ext-<X>/extensions/<X>.ts`
   uniform-entry convention.
3. **`ultracode` keyword trigger** — `DEFAULT_KEYWORD_TRIGGER_WORDS =
   ["workflow", "ultracode"]` (config.ts); custom word still replaces the
   whole list. `/ultracode` command already existed (effort-command.ts).

## Files touched (categories)

- Identity: package.json (self + 3 dependents: s2-agent, movie-director,
  tool-gate), bun.lock (hand-aligned; bun doesn't refresh workspace sections).
- Registry chain: the registry YAML → regen:manifest → manifest.json →
  regen:static → static-extensions.ts (all derived).
- Entry-file imports: static-extensions.ts (regen), tool-gate
  migrated-extensions/tool-gate.test/qa/* (package-specifier subpath).
- CI: .github/workflows/ci.yml.disabled matrix, setup-env action.yml,
  test-determinism-spotcheck.sh, .github/*.md.
- Workflow-pack engine fields: 7 manifests (s2-agent/workflows/*,
  movie-director/workflows/*).
- History row: docs/agents/extension-naming.md (append-only table).
- Deliberately NOT rewritten: receipts/, */docs/adr/, */docs/upstream/
  (historical evidence documents).

## Verification matrix

- ultracode pkg `bun run test` (check + 1106 tests) ✅
- s2-agent cross-package `typecheck` ✅ (after `string` param annotations —
  `as const` tuple literal stopped default-param widening)
- tool-gate / movie-director / bun-apps/tests contracts / devops (ci-matrix) —
  see spec.md results
- devops deploy → s2-agent-sh Gate 3 `--ext-list` must still list `workflow`

## Traps hit

1. `regen:static` derives entry path from package suffix, ignoring registry
   `entry:` — entry file must follow `<X>.ts`.
2. Parameter defaults inferred from `as const` tuple members keep literal
   types → explicit `: string` annotations required.
3. bun 1.4.0 local (CI pins 1.3.14) — lock verified via no-diff after install.
