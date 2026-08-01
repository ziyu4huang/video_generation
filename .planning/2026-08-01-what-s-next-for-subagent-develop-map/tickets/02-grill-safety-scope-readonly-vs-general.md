## Question

**What safety scope does the primitive target first** — the load-bearing fork everything else depends on?

- **(A) Read-only fan-out MVP** — parallel dispatch constrained to tasks that don't mutate the working tree (research, review, analysis). Safe by construction: no conflict, no isolation needed. Ships value fast (research fan-out is the immediate itch), defers the hard part.
- **(B) General parallel** — parallel dispatch including **mutating implementer tasks**, which demands git-worktree isolation per child (`createWorktree` already exists) plus conflict/merge handling. Bigger surface, higher value (parallel independent SDD tasks), materially riskier.

The choice fixes the destination's shape: (A) is a small, safe primitive; (B) is a real orchestration capability. It also decides whether the SDD "never parallel implementers" rule can soften, and whether a shared-state channel becomes relevant (see map's Not-yet-specified).

Resolve via `grilling` + `domain-modeling`: confirm the user's actual use-case pull (research fan-out now, or parallel build-out), then lock the scope. **HITL** — only the user can weigh the value/risk trade-off here.

type: grilling
blocked by: _(none — the foundational scope decision)_
claimed: wayfind-session 2026-08-01 (controller)

---

## Resolution

status: closed (grilled 2026-08-01)

**Decision: read-only fan-out MVP.** The primitive targets **non-mutating** tasks — research, review, analysis, retrieval. No working-tree writes, no commit convergence.

**Rationale (grilled):** the load-bearing fact is that worktree isolation today **discards** file changes on teardown (`removeWorktree` force-deletes the branch; `worktree.ts` docstring: "Results are NOT auto-merged"). So "general parallel" for mutating implementers isn't a flag-flip — it needs a re-convergence/merge layer that does not exist yet, which is precisely why SDD forbids parallel implementers. Bundling that here would swamp the spec. Read-only fan-out ships the **immediate itch** (research/review fan-out) safely on the **proven `parallel()`/`agent()` path** (per [01]), on a foundation the follow-up reuses — not throwaway.

**In scope:** a parallel/batch primitive constrained to non-mutating tasks.

**Out of scope (→ separate follow-up effort):** parallel **mutating** implementer tasks **and** the worktree re-convergence/merge layer that must be invented to support them. The SDD "never dispatch parallel implementers" rule **stands unchanged** until that lands.

**Implications for downstream tickets:**
- **[03] shape:** the primitive is read-only **by construction** — no worktree-isolation / mutating flag is exposed at this layer. *How* read-only is expressed/enforced (structural vs declared vs tool-allowlist) is [03]'s call, not settled here.
- **[04] still applies:** read-only fan-out still needs a concurrency cap + budget (rate-limit protection) — bounding is independent of mutability.
- **Fog cleared:** "shared-state channel for parallel mutating tasks" evaporates (no mutating); "deprecate the SDD never-parallel rule" evaporates (rule stands).
