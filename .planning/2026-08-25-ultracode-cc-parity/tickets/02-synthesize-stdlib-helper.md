# 02 — `synthesize()` stdlib helper (G4)

## Scope

Map tickets phase A; spec §3 (pattern catalog incl. `synthesize()`).

1. **`src/workflow-stdlib.ts`** — add `synthesize(task, results, opts?)`:
   - one fan-in agent (default `tier: "big"`) that receives the task + the
      compacted results and must return a small JSON-serializable verdict
      (default `opts.schema`: `{ ok: boolean, verdict: string, summary: string }`
      shape, CC's "compact {ok/verdict} plus the important outputs" contract),
   - filters `null` entries before dispatch (failed branches never reach the
      synthesizer silently — they are listed in the prompt as failed so the
      verdict can say so),
   - journaled like every other agent call (plain `agent()` underneath; no new
      runtime machinery).
2. **Guidance wiring** — `workflowHelpersDoc()` (workflow-tool.ts:90-92), the
   verbose synthesis bullet (:298), and `workflow_help({topic:"patterns"})`
   mention `synthesize()`; t01's addendum catalog bullet extended to include
   it (keep the bullet compact).
3. **Tests** (`tests/quality-stdlib.test.ts`) — null filtering, big-tier
   default, schema-validated return, failure-path (synthesizer itself returns
   null → helper surfaces null, consistent with the null contract).

## Acceptance criteria

- [x] `synthesize()` in the stdlib globals (workflow.ts global injection
      updated) with tests green — 6 tests incl. null-filtering +
      failure-report, synthesizer-failure → null, tier/label/maxChars
      forwarding, truncation notice
- [x] Guidance surfaces (helpers doc, verbose bullet, patterns topic, t01
      addendum) mention it
- [x] Canonical `bun run --cwd bun-apps/s2-agent-ext-ultracode test` green —
      final 1188 pass / 0 fail (re-run by reviewer pre-nit: 1186/0)
- [x] PR via devops chain (#2017, squash 961b8ff0, CLEAN); reviewer
      APPROVE_WITH_NITS with all findings applied pre-merge — finding 1
      (should-fix): `scriptInvokesAgent` pre-flight regex + HELPER_ONLY_SCRIPTS
      gained `synthesize` (and the pre-existing `completenessCheck` row);
      finding 2: truncation announces itself; finding 5: label/maxChars
      assertions added
