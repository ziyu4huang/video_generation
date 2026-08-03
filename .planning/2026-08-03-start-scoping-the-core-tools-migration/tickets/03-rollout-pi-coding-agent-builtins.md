## Question
Inject `gating:{ core: true }` onto the 4 pi-coding-agent built-ins (`read`, `write`, `edit`, `bash`) via the existing `getAllToolDefinitions` runtime hook in tool-gate's `getDiscovered` path (~`extensions/tool-gate.ts:401`), so `buildEffectiveGates` treats them as owner-declared core (marked `handled`, removed from `CORE_TOOLS` fallback eligibility). Path B (chosen at ticket 01): pi-coding-agent is immutable + `gating` is extension-only, so true owner-declaration isn't possible in-repo — injection is the in-repo equivalent. NOTE: this is *injected-core* (tool-gate supplies the field), not true owner-declaration; the cross-repo PR for true owner-declaration is deferred to FOLLOWUPS #5. After this, the 4 built-ins are handled, unblocking ticket 04 (delete CORE_TOOLS). Concrete: a small surgical edit to tool-gate.ts (~getDiscovered L401) that maps the 4 built-in names → injected `gating:{core:true}`; verify `bun run qa` + drift-guard + the schema-cost canary stay green.

type: task
blocked by: 01
status: open
