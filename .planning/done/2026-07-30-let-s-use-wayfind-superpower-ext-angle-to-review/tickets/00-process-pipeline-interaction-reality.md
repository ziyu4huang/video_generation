## Question

Does gating `subagent` + `workflow` (+ `workflow_control`) behind keyword matching
actually hurt the process pipeline in practice — SDD (`subagent-driven-development`),
`dispatching-parallel-agents`, `executing-plans` — which all depend on those tools?

**Why this is open.** These tools are in the `workflow` GATE (not CORE_TOOLS), so
they fire only when the *user prompt* contains `workflow`/`subagent`/`pipeline`/
`orchestrate`/`fan-out`/`parallel agent`/`multi-step`. Gate keywords are matched
against `event.prompt` (the user's turn), **not** injected skill text — so a
session where the user says "implement this feature" (and the agent elects SDD)
never fires the gate, leaving `subagent` dormant until the agent discovers +
calls `enable_tool`. Whether that friction is real + how often is unmeasured.

**Investigation (local — no web):**
1. Grep the superpowers SDD/dispatching/executing skills: do they instruct the
   agent to `enable_tool` first, or assume `subagent`/`workflow` are present?
2. If any `TOOL_GATE_LOG` captures exist (`TOOL_GATE_LOG_PATH` files / stderr
   runs), tally `miss_candidate` events whose `dormantGates` include the workflow
   gate — the empirical miss signal.
3. Check whether `subagent`/`workflow` are reachable another way (e.g. another
   extension or the harness auto-activates them) that would moot the gate.
4. Measure the schema-token cost of `subagent` + `workflow` + `workflow_control`
   (via the `measureToolTokens` heuristic or `bun run qa:savings`) to size the
   un-gate tradeoff.

**Output:** a verdict — is the friction real, and at what magnitude? — plus a
recommended resolution *direction* (un-gate / context-aware gate / accept +
document) to put to the grilling in
[01 Resolve process-tool gating](01-resolve-process-tool-gating.md).

**type:** research
**blocked by:** _(none — flagship frontier ticket)_
**claimed:** wayfind-session (2026-07-30) — ✅ CLOSED

## Resolution — verdict: empirical friction ZERO; latent fragility self-heals; un-gate affordable

**Findings (local research, 2026-07-30):**

1. **Skill assumption (structural).** Every process-pipeline skill — `subagent-driven-development`, `dispatching-parallel-agents`, `requesting-code-review`, `writing-plans`, `writing-skills` — **assumes `subagent`/`workflow` present; NONE mention `enable_tool`**. `executing-plans` even frames subagents as a baseline capability. So an agent that loads SDD without a keyword trigger *could* hit a dormant-tool wall.
2. **Reachability.** `subagent`/`workflow` extensions are STATIC-loaded (`static-extensions.ts`), but tool-gate still gates their TOOLS — `CORE_TOOLS` excludes them; `filterActive` keeps them dormant at `session_start`. Only paths active: gate fires OR `enable_tool`. No shortcut.
3. **Empirical friction: ZERO observed.** `~/.pi/tool-gate/telemetry.jsonl` (201 turn events): workflow gate **fired naturally 4×**, **escape-hatched 0×**. The 185 `miss_candidate` events over-count — sampled dormant-workflow prompts ("continue", discussion, commit, memory) didn't *need* subagent; `miss_candidate` flags any non-firing turn with ≥1 dormant gate, not unmet need. Caveat: sample = developer's own meta-sessions; under-represents SDD-heavy implementation sessions.
4. **Un-gate cost: affordable.** `bun run qa:savings`: workflow gate = **1,924 tok**; un-gating drops net savings 46.2%→~34.6%, still **>2× the 15% floor**. Side-finding for [05](05-context-md-and-readme-claim-correction.md): current real savings = **~7.7k/46%** (not README's ~8.5k, nor prior QA's stale 5.5k — tool set grew; cite `bun run qa:savings` directly).

**Self-healing note.** `enable_tool` sits in CORE_TOOLS (always present) + its description already says "if you need a capability you don't see, call this tool" — so the latent fragility is *already mitigated* without action. This explains the zero escape-hatch count.

**Recommended direction for [01](01-resolve-process-tool-gating.md):** **defer** (friction is zero + self-healing) — OR un-gate if the user weights robustness over the 1,924 tok/session. Documenting `enable_tool` in `src/superpowers.ts` is largely **redundant** with enable_tool's existing description. The skill SKILL.md files are upstream-pinned (`skills-fidelity.test.ts`), so guidance cannot land there regardless.
