## Question

Should a spawned subagent be **primed with relevant memory** at dispatch time — i.e. should `spawnSubagent` (or a memory-aware wrapper) inject `memory_search` results into the child's `prime`, so the isolated child isn't blind to durable context?

This is the core **②-direction** decision and carries a **design tension** that must be resolved explicitly:

- **The isolated-context contract.** Subagents exist to give a *fresh, isolated* context — no parent history, no contamination, cheap, reproducible. Memory-priming intentionally breaks that isolation. Is that desired, or does it violate the contract the subagent subsystem was designed around? (The subagent ext README frames `spawnSubagent` as "isolated single-subagent dispatch" — priming is a value-add some callers want and others must never get.)
- **Opt-in vs default.** If priming is wanted, it must be **opt-in per dispatch** (a `prime`/`injectMemory` option), never silent — a research subagent should *not* inherit the parent's memory; a "draft me a doc using what we know" subagent should.
- **What gets injected** — a `memory_search(query)` over user/project memory, scoped to the task prompt? Or a curated context slice? How much (token budget)?
- **Where the seam lives** — a memory-aware wrapper in the memory ext that wraps `spawnSubagent`, vs a hook in the subagent ext. (Ownership fog; see map Not-yet-specified.)
- **Backend neutrality** — priming must query via the backend-neutral store, not a hardcoded backend.

Resolve the contract question first (is breaking isolation ever wanted?), then the mechanism. If the answer is "never break isolation," close this and cascade to 05.

type: grilling
claimed: controller (2026-07-25)

## Resolution (closed 2026-07-25 — grilling Q1=A: not worth a second prime source)

**Decision: CLOSE. Manual priming already works; the auto-prime mechanism is owned by sub-project ③ (obsidian); hermes-memory should plug INTO it as a source when ③ lands, not build a parallel one now.**

### Why close
- **Manual priming already works, zero new code.** A caller runs `memory_search` → injects the results into the subagent's `task`/`instructions`. The capability ("subagent gets hermes-memory context") is fully achievable today; auto-prime is only a *convenience*.
- **The auto-prime mechanism is already designed-in — but owned by ③, and obsidian-scoped.** `SpawnSubagentPrime { query, topK, folder }` (`spawn-subagent.ts:25`) is a **no-op forward-reference** (`:14` "`prime?` is a no-op forward-reference to sub-project ③ (auto-primer)"; `:173` "`prime` is intentionally NOT used here (③ owns the auto-primer)"). Its `folder` param is vault-folder scoping (zk_ask/obsidian style); hermes-memory's `memory_search` params are `{query, project, target, category}` — **no `folder`**, shape mismatch. ③ is the sibling "other-exts-bridge-with-subagent" effort's domain.
- **A second hermes-memory auto-prime would duplicate/compete with ③.** The right integration is for hermes-memory to be a prime **SOURCE** inside the (future) prime mechanism, not a parallel prime path.

### The "isolated-context tension" was a non-question
Priming is **opt-in by design** (a `prime?` param; callers who omit it get pure isolation). The ticket's framing ("does breaking isolation break the contract?") dissolved on inspection — the contract author already decided priming is opt-in. The real question was "is a second auto-prime source worth building" → no.

### Hand-off
None — no build. **Deferred dependency:** when sub-project ③ (obsidian auto-primer) lands, evaluate adding hermes-memory as a prime **source** (generalize `SpawnSubagentPrime` to multi-source: obsidian vault + hermes user/project memory), owned by the prime mechanism — not a parallel hermes-memory prime.
