type: task
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

`bun test` failure (side-effect of ticket 01): the `matchIntent "workflow intent"` unit test expects **4** gates to fire, but the plural `subagents` tool now also gates on `"workflow"` (mirrored from the singular tool, per ticket 01), so **5** fire. Update the test's expected gate count 4→5 (now includes the plural `subagents` gate). Locate via `grep -rn "workflow intent" bun-apps/pi-agent-ext-tool-gate/` (likely under `qa/` or a `matchIntent`/`*-probes*` test). Verify the specific test passes after the edit. Objective fix — no behavior change.

## Resolution

**Closed (2026-08-04).** Test file: `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.test.ts`, the `matchIntent (S1) > workflow intent → workflow` case.

Assertion edit (before → after):

- before: `...toEqual(["workflow", "workflow_help", "workflow_control", "subagent"])` (4 gates)
- after:  `...toEqual(["workflow", "workflow_help", "workflow_control", "subagent", "subagents"])` (5 gates — plural `subagents` now co-fires alongside singular `subagent`).

The over-comment was also corrected: `subagent` → `subagent/subagents` in the owner-declared list and `surfaces ALL 4` → `surfaces ALL 5`, noting the plural gate was mirrored from the singular in ticket 01. Both singular `subagent` and plural `subagents` legitimately gate on `"workflow"`, so this is an objective correction (no behavior change). Verified: `bun test -t "workflow intent"` → pass.
