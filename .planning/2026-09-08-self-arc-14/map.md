---
effort: 2026-09-08-self-arc-14
created: 2026-09-08
last: 2026-09-08
status: done
---

# Wayfinder map: 2026-09-08-self-arc-14 — B3 migrate-in-parallel: the descoped CC pattern, done at the workflow layer

## Destination

The one CC-parity pattern arc-12 descoped — B3 "migrate many files in parallel,
each child writing in an ISOLATED copy" — lands as a committed executable
workflow sample plus LLM-free unit gates, because the capability arc-12's D3/D6
assumed missing already exists: `workflow-runtime.ts` `agent()` supports
per-call `isolation: "worktree"` (deterministic names → stable resume keys,
writes allowed, no batch read-only exclusion). The batch `subagents` tool's
shared-tree read-only constraint is DOCUMENTED as correct-by-design, and a live
glm-5.3 receipt proves a real two-file migrate.

## Context (measured 2026-09-08, read in-tree)

- **The capability mis-scan**: arc-12 D3/D6 descoped B3 reasoning "write-capable
  fan-out children are deliberately forbidden" — true of the BATCH tool
  (`subagents-tool.ts:65` `READ_ONLY_EXCLUDED` applied last, non-overridable;
  worktree-isolating agentTypes rejected at :442) but NOT of the workflow layer:
  `workflow-runtime.ts:344-351` honors `agentOptions.isolation ?? agentDef.isolation`,
  `createWorktree(baseCwd, "${runId}-${callIndex}-${label}")` (deterministic →
  stable resume keys, workflow-runtime.ts:98-101 annotates cache separation),
  child `cwd` = worktree, and NO read-only exclusion is applied. CC's B3 shape
  (parallel isolated writers + parent integration) composes with `parallel()`.
- **Worktree lifecycle**: created under `<repoRoot>/.pi/worktrees/<name>` on a
  branch (core-runtime `worktree.ts:37-57`); torn down per-call in `finally`
  (workflow-runtime.ts:474-476) → unit-gate assertions must happen INSIDE the
  recording fake runner (write + read-back + record `{cwd, content}`), not after.
- **Non-repo hazard**: `createWorktree` on a non-repo returns `isolated:false`
  with a reason → the child silently runs in the MAIN tree (workflow-runtime.ts:
  349-351 logs "isolation ignored"). A writable child that asked for isolation
  but runs un-isolated is the dangerous case; the unit gates pin the behavior
  (logged loudly) and the sample requires a repo base.
- **Suite precedent**: arc-12's Suite B samples are real scripts under
  `samples/cc-parity/` executed by the real WorkflowManager with an injected
  runner; `samples/run.ts` is the headless path; catalog doc at
  `bun-apps/s2-agent/docs/cc-parity-samples.md` maps sample ↔ CC doc section.

## Decisions

- D1 (2026-09-08): B3 is implemented at the WORKFLOW layer, not by relaxing the
  batch tool. The batch tool's read-only shared-tree constraint is correct for
  its contract (concurrent children in ONE tree); the workflow layer is where
  isolated writers already live. No production src change in this arc →
  schema-cost +0 by construction.
- D2 (2026-09-08): the unit gate writes REAL files: the recording fake runner
  performs the "migration" (write its own file into the cwd it receives, read
  back, record). This is not a mock of the pattern — the isolation, the parallel
  dispatch, the worktree lifecycle, and the parent-tree integrity are all real;
  only the LLM is fake.
- D3 (2026-09-08): children model = zai/glm-5.3 for any LIVE receipt (never
  flash — arc-12 D5 policy carries over). Unit gates stay LLM-free.
- D4 (2026-09-08): the batch tool stays read-only; the map records the design
  line (shared-tree ⇒ read-only; isolated tree ⇒ writable) so a future batch
  isolation opt-in is a conscious successor arc, not drift.

## Tickets

- [x] `tickets/01-sample-migrate-in-parallel.md` — the workflow script
      (`samples/cc-parity/migrate-in-parallel.js`): args.files N×
      `agent({isolation:"worktree"})` under `parallel()`, per-child write in its
      worktree, synthesizer aggregates; plus the unit gate
      (`tests/cc-parity-migrate.test.ts`, real WorkflowManager + recording
      writer runner in a committed git repo base): parent tree untouched, each
      child's write landed in ITS worktree, results in input order.
- [x] `tickets/02-isolation-semantics-gates.md` — safety/semantics unit gates:
      non-repo base → `isolated:false` → loud log + child runs in main tree
      (documented hazard); call-site isolation precedence over agentDef
      (:337-342 — and the no-sentinel opt-out gotcha); deterministic worktree
      naming → two sequential runs reuse stable keys.
- [x] `tickets/03-catalog-and-live-receipt.md` — catalog doc: B3 row un-descoped
      → this sample (batch limitation stays documented); ONE live receipt
      (real glm-5.3 ×2 children, tiny two-file migrate, headless run.ts) with
      source + deployed receipts per the self-arc-9 specimen.
- [x] `tickets/04-map-closeout.md` — map done + Shipped-as + reciprocal links
      (arc-12's B3 descope note updated to point here).

## Shipped

- **t01/t02 (#2217, merged 2026-09-08)**: `samples/cc-parity/migrate-in-parallel.js`
  + `tests/cc-parity-migrate.test.ts` (isolation, parent integrity, teardown,
  non-repo hazard) + catalog B3 un-descope.
- **t03 (2026-09-09)**: live receipt — real zai/glm-5.3 ×3 children (2 migrators
  + integrator), 2/2 files migrated in isolated worktrees, parent tree
  untouched, worktrees torn down; 54.7 s, 200,537 tokens. Artifacts:
  `output/self-arc-14-src-2026-09-09/{receipt.json,receipt-run.json,run-stderr.log}`
  + fixture repo `output/self-arc-14-live-base/`. Deployed receipt recorded N/A
  (library-level path bypasses the binary — honest note, see receipt.json).
- **t04 (this commit)**: map done; arc-12 map D6 note gains the reciprocal
  pointer.

## Fog of war

- Whether `createWorktree` refuses a base repo with ZERO commits (git worktree
  add needs a HEAD) — t01's test fixture commits once before running; if the
  refusal is loud, the sample's README says "base must have ≥1 commit".
- Whether the workflow `log()` lines surface in run.ts stderr for receipts
  (run.ts pipes onLog to stderr — yes per its header; receipt check uses that).
