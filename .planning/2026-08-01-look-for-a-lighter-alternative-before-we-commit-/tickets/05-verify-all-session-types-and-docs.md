---
type: task
claimed:
blocked by: [04]
---
## Question

**Final end-to-end verification** of the chosen mechanism across every session
type, plus measured speedup vs the `ctx.reload()` baseline, plus docs updates —
so the change is safe to commit.

### Steps

1. Run the per-type A/B procedures from ticket 03 against the implemented winner
   from ticket 04: main interactive, extension subagent, workflow agent,
   core-task / TUI, obsidian / zk child. Record pass/fail per type.
2. Measure: command post-write latency (winner) vs `ctx.reload()` baseline. Attach
   the numbers (confirm the promised speedup is real).
3. Update docs to match the mechanism:
   - `bun-apps/pi-agent-ext-response-language/README.md` + command description;
   - the `force-response-language.ts` patch header comment (trigger story);
   - `bun-apps/pi-agent/src/patches/index.ts` PATCH_TABLE comment if the
     mechanism changed.
4. Run the test gates: `cd bun-apps/pi-agent-ext-response-language && bun test` and
   `cd bun-apps/pi-agent && bun test src/patches/`. Add/adjust tests for the new
     mechanism (TDD — tests first).

### Resolve

Green tests + green cross-session A/B + measured speedup + docs accurate. Only then
is the lighter alternative safe to commit (this unblocks the pending commit + PR).

### Deliverable

Verification evidence (per-type pass table + latency numbers), updated tests, and
updated docs — ready to fold into the commit.
