# Ticket 04 — subagent startup context (git status + sibling roster)

Status: done (2026-08-23) · Phase 2 (after 02 — reuses its transcript composer plumbing)

## Scope

Give every spawned child CC's startup-context block. The CLAUDE.md hierarchy is
ALREADY inherited (pi `DefaultResourceLoader` walks ancestors per spawn cwd);
this ticket adds the missing pieces: a git-status snapshot of the spawn cwd and
the sibling roster (named live agents + in-flight one-shot children). Per map
D5: measured-gap fill, composed as a PREFIX block before env-hints and
abort-safety footers; batch children share ONE git snapshot and get a
size-capped block.

## Approach

1. **Measure first**: a test that spawns a child with a fake transport and
   asserts what its system prompt contains today (repo CLAUDE.md content
   appears when spawned at repo root). Pins the resource-loader claim before
   building on it.
2. New `bun-apps/s2-agent-ext-subagent/src/startup-context.ts`:
   `buildStartupContextBlock({ spawnCwd, roster, gitStatus, capChars })` —
   pure composer. Lives beside `src/git-scope.ts` (presentation in
   ext-subagent; roster data injected from core-runtime's
   `LiveAgentRegistry`).
3. Git snapshot: reuse/extend `git-scope.ts` helpers (porcelain status +
   branch + one recent log line); computed at batch level in
   `subagents-tool.ts` so a 10-task batch pays once.
4. Roster: `LiveAgentRegistry` + in-flight registry — names, status, one-line
   role from the run label; capped at ~12 rows.
5. Composition order in `src/subagent-tool-run.ts` becomes
   `[fork transcript (02)] → [agentDef.prompt] → [startup-context] →
   [env-hints] → [abort-safety]`. New schema param
   `context: "full" | "minimal" | "none"` (default full) so batch/read-only
   children can dial down.
6. CC divergence: CC's Explore SKIPS CLAUDE.md; ours loads it via the
   resource-loader unconditionally. Decide in-ticket whether to suppress for
   the `explore` built-in via a per-call `resourceLoader` override in
   `WorkflowAgentOptions.session`; only do it if measurement shows benefit,
   else record as accepted divergence (spec.md §3).

## Files

- New: `bun-apps/s2-agent-ext-subagent/src/startup-context.ts`
- `bun-apps/s2-agent-ext-subagent/src/git-scope.ts`, `src/subagent-tool-run.ts`,
  `src/subagents-tool.ts`, `src/subagent-tool-schema.ts`
- spec.md §2 startup-context row — same PR

## Risks

- Prompt-size growth across batches — cap aggressively; shared snapshot.
- Footer-order regressions — pin the composition order in tests.

## Verification

- New `tests/startup-context.test.ts` (ordering, caps, minimal mode); extend
  the tool-run tests with an end-to-end composition-order pin; the system-prompt
  inheritance measurement test from step 1.
- Full gates s2-agent-ext-subagent (+ core-runtime/ultracode if touched).

## Close-out (2026-08-23)

- Measurement (Approach step 1) PASSED and is now a standing pin: a real
  `spawnSubagent` child over the pi faux provider sees BOTH its spawn-cwd
  CLAUDE.md AND the ancestor's in its system prompt — the resource-loader
  inheritance claim (map S3) is measured, not assumed. A pi upgrade that drops
  it fails this test instead of silently double-carrying repo context.
- Shipped: `src/startup-context.ts` (pure composer + `buildSiblingRoster`),
  `GitSnapshotOps`/`realGitSnapshotOps` in `git-scope.ts` (separate interface —
  widening `GitScopeOps` would have broken dozens of injected test fakes),
  `context` param on BOTH tool schemas, composition
  `[startup-context] → task → [env-hints] → [abort-safety]` pinned in
  `subagent-tool-run.test.ts`. Batch shares ONE snapshot per call (asserted:
  1 snapshot for a 3-task batch, identical prefix on every child).
- Approach step 6 (explore skipping CLAUDE.md): stays the accepted divergence
  recorded in spec §3 by ticket 03 — the measurement above shows the
  inheritance is real but gives no bloat signal to act on.
- Gates: ext-subagent 691 pass / 0 fail (canonical `CI=true bun run test`,
  includes biome check); core-runtime 452 pass (untouched, run per handoff
  instruction). Three microtask-counting tests moved to a queue flush — the
  capture's `Promise.all` deepened the pre-spawn window.
