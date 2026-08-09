## Question

Given [00 Process-pipeline interaction reality](00-process-pipeline-interaction-reality.md)'s
findings, decide how to handle process-tool gating so the SDD/parallel/executing
pipeline isn't hampered — a judgment call (acceptable friction vs always-on cost),
so this is grilling, not the agent's alone.

**Options the research will put on the table:**
- **Un-gate** — move `subagent` + `workflow` (+ `workflow_control`) into
  `CORE_TOOLS` (always active). Eliminates friction; cost is their schema tokens
  always-on (sized by ticket 00). The process pipeline is core to this repo.
- **Context-aware gate** — keep gated, but fire the workflow gate when
  SDD/plan/execute context is detected (e.g. a `.planning/<effort>/plan.md`
  exists, or a superpowers process skill is loaded). Surgical; preserves savings.
- **Accept + document** — keep gated; ensure the superpowers process skills
  instruct the agent to `enable_tool` first. Cheapest; preserves savings; relies
  on skill text discipline.

**Decision to record:** which option (or blend), the rationale, and the
acceptance test (e.g. `bun run qa --strict` stays green; a representative SDD
prompt reaches `subagent` without manual `enable_tool`).

**type:** grilling
**blocked by:** [00 Process-pipeline interaction reality](00-process-pipeline-interaction-reality.md)
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — decision: DEFER (no action); friction is zero + self-healing

Accepted the data-driven call. **No change** to process-tool gating — `subagent`/`workflow` stay gated behind the workflow gate.

**Rationale (from [00](00-process-pipeline-interaction-reality.md)):**
- Empirical friction ZERO: workflow gate fired naturally 4×, escape-hatched **0×** in 201 turns. `miss_candidate` over-counts (dormant ≠ needed).
- The escape hatch self-heals: `enable_tool` is in CORE_TOOLS (always present) + its description already says "if you need a capability you don't see, call this tool." So the latent fragility (skills assume `subagent` present) is mitigated without action — confirmed by the zero escape-hatch count.
- Un-gate was affordable (1,924 tok → 46%→35%) but unjustified for zero observed friction.

**Watch trigger:** if future `TOOL_GATE_LOG` telemetry shows workflow-gate `activate` (escape-hatch) events — agents hitting the dormant wall — re-open as a fresh effort (un-gate or context-aware gate then). Until then the escape hatch is the safety net.

The structural note (skills assume subagent present; upstream-pinned, can't edit SKILL.md) is documented in 00's resolution for future reference; no skill edit regardless.
