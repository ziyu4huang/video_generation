# bun-apps/pi-agent Review — 2026-08-15

Incremental review of `bun-apps/pi-agent` since the previous package-audit
close-out (#1315, `ef451a88`). Reviewed range `ef451a88..c0732d18` — effectively
PR #1354 (stale-dist self-heal + 0.84.2 lockstep bump) plus the mechanical ADR-ID
commit #1330 (clean, no issues). Independent reviewer subagent
(superpowers:requesting-code-review); findings verified against source before
fixing.

## Findings → dispositions

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | Important | `ensure-workspace-dist.ts` exported mode-dependent `patchApplied=false` → `readPatchOutcome` fires the "enabled but did NOT bind" warning on EVERY bundle/binary launch and violates the e2e "every patch ✓ applied" contract (`ensure-extension-deps` precedent exports nothing precisely to avoid this) | FIXED: export removed; heal loop extracted into `healStaleWorkspaceDists(bunAppsDir, spawn)` with injectable `BuildSpawn` seam |
| 2 | Important | `tests/workspace-dist-fresh.test.ts` header claimed the gate fires "BEFORE the matrix trips" — false: local_ci runs the per-package matrix first, and pi-agent's suite self-heals via the patch import | FIXED: comment now states actual ordering (last-line confirmation inside local_ci; standalone value via `bun run test:dist`) |
| 3 | Important | The heal wrapper loop (discovery + spawn + all error paths) had zero automated coverage | FIXED: 8 new tests via the `__test.healStaleWorkspaceDists` seam with stubbed spawn (stale→heal, fresh→noop, missing dist, exit≠0, exit-0-still-stale, spawn-throw, skip rules, multi-package) |
| 4 | Minor | exit-0-but-still-stale path reported "rebuild FAILED (status 0)" | FIXED: distinct "exited 0 but STILL stale" message |
| 5 | Minor | concurrent-boot double build (two sessions healing same checkout) | NOT FIXED — multi-worktree setups (this repo's norm) unaffected; interleaved identical writes are benign; noted for the record |
| 6 | Minor | `distEntryMain` only recognizes `main` + `exports["."].import` object form | NOT FIXED — all four current dist-entry packages use the recognized shape; future-proofing |
| 7 | Minor | detection is own-src-vs-own-dist mtime only; branch switch rewrites src mtimes → first boot may pay up to 4 sequential builds | ACCEPTED — bounded, arguably correct; header wording could clarify "sibling's exported surface" scope |
| 8 | Minor | ~20-line discovery-loop duplication between patch and gate | NOT FIXED — folded into #1's refactor opportunity later; drift risk is low while both consume the same pure helpers |

## Verification

- `bun test` (pi-agent, full suite): 871 pass / 0 fail
- `bun run --cwd bun-apps/pi-agent typecheck` (cross-package tsc): exit 0
- `bun run test:dist` gate: pass
- `PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts` (built bundle):
  5 pass — the #1 contract is green end-to-end
