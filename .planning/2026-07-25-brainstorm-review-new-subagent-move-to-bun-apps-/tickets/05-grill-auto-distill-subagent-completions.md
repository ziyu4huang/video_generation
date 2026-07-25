## Question

Should a **completed subagent's findings be auto-distilled into memory** — i.e. a subagent learning-loop that captures a subagent's output/learnings as memory entries, mirroring what the main session's background-review + learning-loop does for the parent?

Resolve **after** 04 settles the isolation contract (if 04 rules priming out entirely, this likely closes too; if 04 allows opt-in memory interaction, this is the write-side companion).

Decide:

- **In scope?** Is auto-capturing subagent output valuable, or is it noise (subagent outputs are often throwaway / already returned to the parent, which has its own learning loop)? The parent already sees the subagent's returned result — does the parent's review loop not already cover this?
- **Opt-in** — like 04, capture must be opt-in per dispatch (a `captureMemory`/`distill` option), never silent.
- **What gets captured** — the subagent's final output? Structured findings? Only on success? Dedup vs the parent's loop (avoid double-capture of the same fact).
- **The distillation mechanism** — reuse the existing background-review distill path, or a subagent-specific one?
- **Ownership** — same fog as 03/04: memory ext consuming subagent completion events vs subagent ext emitting them.

type: grilling
claimed: controller (2026-07-25)
blocked by: 04-grill-memory-prime-for-spawned-subagents  <!-- 04 closed (not "priming ruled out" — manual works + owned by ③); 05 is the independent WRITE side, worked on its own -->

## Resolution

_Closed 2026-07-25 — grilling Q1=A: BUILD._

**Decision: BUILD. Extend the memory learning loop to also review subagent tool_results — scoped to the `subagent` tool, NOT all tool results.** Unlike 03/04 (covered by existing mechanisms), 05 has a REAL gap.

### The gap (evidence)
`getMessageText` (`types.ts:194-210`) extracts only `block.type === "text"` content blocks and **caps at 500 chars**. A subagent's output returns to the parent as a `user`-role message with a **`tool_result`** content block → filtered out → `collectMessageParts` (`message-parts.ts`) skips it → **background-review's learning loop NEVER sees subagent outputs → they're never auto-captured to memory.** The parent agent sees the output (in its context) and *can* save manually, but auto-capture (the whole point of the learning loop) misses it.

### Recommended mechanism (for the plan — decision is "build"; this is the design steer)
- **Dedicated capture path for subagent tool_results**, NOT broadening the shared `getMessageText`/`collectMessageParts` (which `session-flush` + `correction-detector` also use — broadening risks injecting grep/file-content noise into those paths).
- Identify subagent results by **tool name** (`subagent`, possibly `subagent_runs`) on the preceding `tool_use` — no cross-ext seam needed (the name is in the tool_call).
- **Relax the 500-char cap** for subagent outputs (they're long, high-signal).
- Feed captured subagent outputs into the review prompt; the existing distill logic decides what's notable.

### Constraints
- Backend-neutral (writes via `MemoryRepository`).
- Always-on vs configurable: lean always-on (mirrors the existing review loop), but the plan should confirm.

### Hand-off
`writing-plans` (one plan, ~3-4 tasks: identify subagent tool_results → capture + relax cap → feed to review → verify). **Acceptance:** a `subagent` dispatch → its output reviewed by the learning loop → captured to memory when notable; no regression to `session-flush`/`correction-detector`; `getMessageText` shared path unchanged.
