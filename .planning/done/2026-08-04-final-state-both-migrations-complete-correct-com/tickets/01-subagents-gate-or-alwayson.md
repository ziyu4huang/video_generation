type: grilling
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Should the **`subagents`** tool (the plural parallel batch fan-out tool, `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:180`, ~463 tok/req) be **gated** or **owner-declared always-on**?

Context to weigh:
- It is the heaviest of the 5 ungated tools (highest tok/req) and fans out N children in parallel — large blast radius if fired carelessly.
- The **singular** `subagent` (`subagent-tool.ts`) is already gated with `gating: { keywords: ["workflow","pipeline",...] }`. The plural form is a strictly heavier superset of that dispatch path.
- Options: (a) mirror the singular tool's keyword gate; (b) gate with a different keyword set; (c) `gating: { core: true }` (always-on) if unrestricted parallel fan-out is acceptable.

Resolution records: the chosen `gating:` value (verbatim, ready to paste into the `defineTool({...})` at `subagents-tool.ts:180`).

## Resolution

**Decision: mirror the singular `subagent`'s keyword gate** (chosen 2026-08-04). The plural `subagents` fan-out is a strictly heavier superset of the singular dispatch path, which is already keyword-gated — so it inherits the same gate rather than being always-on.

Apply verbatim to the `defineTool({...})` at `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts:180`:

    gating: {
      keywords: [
        "workflow", "pipeline", "orchestrate", "fan-out", "fan out",
        "parallel agent", "multi-step",
      ],
    },

Source of truth: the singular tool's gating in `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`. Apply + verify is ticket 06.
