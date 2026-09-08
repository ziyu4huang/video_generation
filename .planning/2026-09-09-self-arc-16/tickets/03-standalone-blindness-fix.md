# Ticket 03 — standalone blindness fix: commands + zero-tool tolerance (T3)

Status: open · fires on t02's F2 evidence · only deploy-needing ticket

## Work
`bun-apps/s2-agent/src/sh/standalone.ts`: collector also records command
names; additive `StandaloneExt.commands()`; `LoadExtOptions.allowEmptySurface`
opt-in (default stays fail-loud — contract preserved). Unit tests in s2-agent.
Redeploy (deploy CLI; verify-deploy-e2e auto-runs). Re-run t02's wayfind leg
against the NEW tree → `commands-surface` (grill, wayfind by name) flips
gap→PASS; superpowers loads with `allowEmptySurface` (empty surface recorded
as evidence; runtime behavior stays a gap). Version bump (s2-agent touched).

## Done when
Post-redeploy receipts record the new version; `commands-surface` PASS;
`loadExt-allow-empty` PASS; s2-agent suite green; schema-cost probe +0.
Post-merge redeploy + final receipt re-run before close (arc-12 t05 rule).
