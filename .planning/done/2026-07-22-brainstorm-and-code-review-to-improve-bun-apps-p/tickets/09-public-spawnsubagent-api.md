---
type: prototype
status: closed
claimed: work-session-2026-07-22
---

## Question

What is the **public** `spawnSubagent()` API surface for cross-extension programmatic use?

Today `spawnSubagent()` (in `src/spawn-subagent.ts`) is an internal shared wrapper over `WorkflowAgent.run`, already consumed by `zk_card` / `zk_ask`. The scope decision is to **stabilize + document** it as a public export of `pi-agent-ext-workflow` so peer extensions (`pi-agent-ext-wayfind`, `pi-agent-ext-superpowers`, obsidian/knowledge tools) can invoke subagents from code.

Decide:
- **Public exports** from `src/index.ts`: `spawnSubagent`, `SpawnSubagentOptions`, `SpawnSubagentResult`, `AgentUsage`, `AgentHistoryEntry` (and any the chosen capture depth from ticket 07 adds). What's in vs kept internal.
- **Stability contract:** which option/return fields are stable (semver-bound) vs experimental. The `prime?` forward-ref (sub-project ③ auto-primer) is currently a no-op — keep it out of the stable surface or mark experimental.
- **Docs:** a README/CONTEXT section + a JSDoc on the export naming the canonical use (peer extensions calling from code, not the LLM tool path). Note the relationship to the `subagent` tool (same runner) and the `workflow` tool's `agent()` (the in-script equivalent).
- **Consumers to update:** `zk_card`/`zk_ask` already call it — confirm they import from the public path; document the wayfind/superpowers programmatic path.

Keep `CONTEXT.md`'s `subagent (tool)` + `spawnSubagent` entries aligned.

## First takeable step

Add the exports + JSDoc, run `bun run build` to confirm the public surface compiles, and grep consumers (`zk_card`, `zk_ask`) to switch to the public import path.

## Resolution

Public API stabilized + verified end-to-end across a real peer-extension consumer.

**Public exports added to `src/index.ts`** (→ `dist/index.js` / `dist/index.d.ts` via the package `exports["."]`):
- **Stable:** `spawnSubagent`, `SpawnSubagentOptions`, `SpawnSubagentResult`, `AgentUsage` (+ `AgentHistoryEntry`, already exported). Semver-bound through the generated `.d.ts`.
- **Experimental:** `SpawnSubagentPrime` — exported only for type completeness; it backs the `prime?` option on `SpawnSubagentOptions`, which is a **no-op forward-reference to sub-project ③** (auto-primer). Marked experimental; not stable until ③ lands.

**Stability contract:** the four stable exports form the programmatic subagent surface; the `prime?` field is the sole experimental bit, documented in the index.ts block comment.

**Import path:** peer extensions import from the **package root** `@repo/pi-agent-ext-workflow` (resolves to `dist/index.js`), NOT the `./src/*` source escape hatch.

**Consumer migrated + verified:** `pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` switched from `@repo/pi-agent-ext-workflow/src/spawn-subagent.ts` → `@repo/pi-agent-ext-workflow` (the `zk_card`/`zk_ask` spawn seam). knowledge-card test suite: **377 pass / 0 fail** — proves the public path works end-to-end for a real consumer. (It was the ONLY repo consumer of the deep path; `superpowers.ts` references it in a doc string, not an import.)

**Docs:** `CONTEXT.md` gained a **`spawnSubagent()` (public API)** entry under Orchestration primitives, documenting the surface, the stability split, the package-root import, and the canonical peer-extension use; the `subagent (tool)` entry stays as the LLM-callable surface.

**Artifact:** `src/index.ts` (+exports + block comment), `dist/` (rebuilt), `pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (import path), `CONTEXT.md` (+entry). workflow `bun run build` clean, 1179 tests / 0 fail.

**Graduated / noted:** the `prime?`/③ auto-primer stays experimental fog (out of this effort's scope); ticket 11 (glue update) can now name the public import path for peer extensions.
