type: grilling (synthesis) → task (on no-go)
claimed: pi-session-2026-07-25
status: closed (2026-07-25)
blocked by: [01-hook-observability-feasibility] (closed), [02-verdict-threshold] (closed)

## Question

The **destination ticket**: synthesize [01] (is hook observability feasible
without an SDK change?) and [02] (is the gap severe enough to matter?) into the
**go/no-go verdict** on whether power-tool's inspect-* surface is sufficient for
pi-agent extension development.

## The two outcomes

- **GO ("sufficient — stop").** The inspect-* surface (incl. auditor subagent +
  schema-cost) covers activities 3–8 to the [02] bar; hook observability is
  either infeasible without an upstream SDK change, or is below the threshold.
  Resolution = a short "complete, stop" note documenting hook observability as
  the accepted known limitation (with the `console.log` workaround), filed in
  power-tool's CONTEXT.md / README. No new tool built.
- **NO-GO ("needs more").** Hook observability is HIGH-impact AND feasible per
  [01]. Resolution = graduate the fog into a fresh effort: write the
  `inspect_hooks` spec (under its own `.planning/<effort>/spec.md`, like the
  2026-07-25 coverage spec) and hand to writing-plans. The graduation is the
  deliverable; **this map ends at the verdict, not the build.**

## Resolution shape

The verdict line (GO / NO-GO) + one-paragraph rationale grounded in [01] + [02],
+ either (GO) the accepted-limitation write-up pointer, or (NO-GO) the link to
the graduated `inspect_hooks` spec. After this ticket closes the map is complete
— run the wayfinder closing ceremony (harvest Not-yet-specified, surface false
premises / footguns, pick the next goal).

## Resolution (2026-07-25)

**VERDICT: NO-GO — the inspect-* surface is NOT yet sufficient for extension
development.**

The locked decision rule fires mechanically:

- [02] classified hook observability **HIGH** impact — set *cold*, before reading
  [01]'s answer.
- [01] confirmed the gap is **closeable without an upstream SDK change** — read
  the aggregate `runner.extensions[].handlers` via the `sdk-patch.ts`
  `createContext` polyfill (expose a `getHooks()` on ctx).
- Rule: **HIGH + feasible-no-SDK-change → NO-GO.**

→ The single uncovered HIGH-impact gap (activity 5 — hook observability) is both
severe AND closeable without an external dependency, so it must be closed.
Graduate `inspect_hooks`.

**Graduation (the deliverable):** a fresh effort is created at
`../2026-07-25-inspect-hooks-hook-observability/spec.md` — a seed spec carrying
the SDK-architecture findings, the proven approach, and the open design
questions, ready to hand to writing-plans after a short brainstorm pass on those
questions. The design fog (output shape, event subset, phase split) lives THERE,
not here — this map ends at the verdict.

**Map status: complete.** All three tickets closed; the destination (the
go/no-go verdict) is reached as NO-GO. Closing ceremony run — see
`output/next-goal-20260725_044408.md`.
