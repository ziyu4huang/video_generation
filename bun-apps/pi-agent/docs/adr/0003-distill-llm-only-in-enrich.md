**ID:** `ADR-pi-agent-0003` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# Distill keeps the LLM to one in-context stage (Enrich); Gate and Converge are deterministic

The distill pipeline has three stages, but only Enrich — the middle rewrite step —
uses an LLM, and it uses it the ONLY way anything in this CLI may: through the
driving agent's pi-agent session (the same SDK/model path every command resolves
via sessions/shared.ts). The extension itself imports no LLM client, reads no
API key, and makes no direct provider call — its only pi-coding-agent import is
the `ExtensionAPI` *type*. Gate and Converge are pure deterministic functions.
Concretely, the distill tool exposes three actions — `status`, `gate`,
`converge` — and NO `enrich` action: the agent calls `gate`, receives the
Survivors, rewrites them itself as a normal reasoning turn, then calls
`converge` with the enriched notes.

Two reasons. First, reproducibility: putting an LLM in Gate would make "what
survives" nondeterministic (two runs diverge), and putting one in Converge
would make wiki-links and MOC placement drift between runs. Second, the single
model path means there is ONE place credentials, model routing, and verbosity
are resolved — no extension ever needs its own API key or a second provider
client, which is what keeps the CLI hermetic.

Why in-context rather than spawning a subagent for Enrich? The Survivors are
already in the driving agent's context (they are the `gate` tool result), so a
subagent would re-prompt data that never needed to move; and the extension
cannot spawn one anyway (no SDK runtime, only the `ExtensionAPI` type).
Subagents — child-process (`runSubagent`, re-invoking the whole binary) or
in-process (`spawnSubagent`) — are reserved for genuinely isolated, open-ended
jobs (`obsidian_distill`, `obsidian_garden`, `zk_*` audits); Enrich is bounded
and local. The cost: enrichment quality is bounded by the driving agent's model
and prompt, not tunable inside the extension — accepted because the
deterministic bookends are what make the graph trustworthy.
