# t04 — Maintenance close-out: one PR, map done, successor next-goal

Status: open · Phase 3 · Needs: t01, t02, t03 · Blocks: —

## Goal

The arc lands as ONE implementation PR through the devops chain (docs ride it
— maintenance-mode convention), the map closes honestly, and the successor
next-goal keeps maintenance mode moving with the test-hygiene arc as queue
head.

## Steps

1. Pre-merge receipts assembled from t01–t03: gate triple green under real
   names; local_ci lane verified; both server-up/server-down test receipts;
   coverage signal-or-disposition; MEMORY_TOOL_DESCRIPTION byte-identical;
   scripts-dir-contract green.
2. Devops chain per `bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md`
   (never hand-rolled raw bash): prepare-feature-branch → local_ci scoped to
   changed packages → PR → squash-merge (`gh ship`), never `--auto` →
   verify-merge. Local green = good to merge; never wait for remote CI.
3. Redeploy + qualify sweep ONLY IF t02 flagged src/ changes (map D6);
   otherwise explicitly record "no src/ change → no redeploy".
4. If the merge tool nudges a version bump, run
   `version-bump-cli.ts --package s2-agent-ext-hermes-memory --patch`
   (0.7.23 → 0.7.24). Optional, tool-nudged only.
5. Close the map: every ticket [x] with Resolution; Shipped-as section
   enumerating each arc-17 auditor note → its disposition (a→t01 fixed,
   b→t02 fixed, c→t03 signal+deferral); frontmatter status → done.
6. Successor next-goal (strict v2, per session-closeout-sop /
   self-reflect-next-goal — written BEFORE reporting done): maintenance mode
   continues; the test-hygiene arc (file2md mock.module isolation,
   hyperframes HOME sandboxing, 19-packages check-script standardization,
   sv-analyzer skip-loudness) is the queue head — hermes's slice is now DONE
   here, so note its scope shrinks by exactly this arc. Then memory update
   per the close-out SOP.
7. `.planning/2026-09-09-self-arc-18/` committed and pushed to origin/main
   (planning artifacts are durable-shared, never left untracked); output/
   scratch never committed, never deleted.

## Acceptance

- PR merged (squash) via the devops chain; verify-merge clean.
- Map status done; every auditor note's disposition visible in Shipped-as.
- Successor next-goal file written and valid (validator green) BEFORE the
  session reports done; memory updated.
- No output/ scratch in the PR; planning artifacts ARE in it.
