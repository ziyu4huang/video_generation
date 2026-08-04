type: grilling
claimed: wayfind-session (interactive, 2026-08-04)
status: closed

## Question

Should **`memory_supersede`** (`bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-supersede-tool.ts:62`, ~347 tok/req) be **gated** or **always-on**?

Context:
- Hermes-memory destructive op — supersedes/replaces durable memory entries; irreversible blast radius on the memory store.
- Compare against the gating posture of sibling hermes-memory tools (`memory` write, `memory_search` read): do they gate, and should supersede match or be stricter?
- Options: keyword gate, or `core: true` if always-on is intended.

Resolution records: the chosen `gating:` value (verbatim, to paste at `memory-supersede-tool.ts:62`).

## Resolution

**Decision: keyword gate** (chosen 2026-08-04). Irreversible memory mutation shouldn't fire unrestricted.

Tool description (source): "Retire a stale/wrong memory by creating a linked replacement. The prior is marked superseded (hidden from search); the replacement carries lineage back to it. Use when a recalled memory is wrong and you have the correction. Pass the prior's DB id (from a memory_search result) + the corrected content."

Proposed gating (apply at ticket 06; adjust if a clearer set emerges):
```ts
gating: { keywords: ["memory", "supersede", "superseded", "retire", "replace", "replacement", "correction", "overwrite"] }
```
Target: `bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-supersede-tool.ts:62`.
