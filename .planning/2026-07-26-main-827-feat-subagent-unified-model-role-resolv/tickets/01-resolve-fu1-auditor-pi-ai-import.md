## Question

Resolve FU-1: `pi-agent-ext-core-task/src/goal/auditor.ts:24` does `import type { Model } from "@earendil-works/pi-ai"`, but `@earendil-works/pi-ai` is **not** a dependency of `pi-agent-ext-core-task` (only `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are declared) → baseline tsc error. `Model<any>` is genuinely used (lines 51, 52, 64, 134, 143, 158), so the import is not dead — it cannot simply be deleted.

**Decision:** the package has an established convention of *not* adding a pi-ai dep (Bun isolated-linker). `overflow.ts` ("Inlined to avoid a Bun-isolated-linker dependency on pi-ai"), `goal.ts` ("no external dep needed"), and `todo/tool/types.ts` ("Inline StringEnum — stripped from pi-ai dependency") all inline/recreate the needed pi-ai types locally. `auditor.ts` is the lone holdout. Fix by following that precedent: inline a local `Model<any>` shape — minimal, just what `auditor.ts` actually reads off a `Model`.

**Sub-decision:** inline the type inside `auditor.ts`, or hoist it to a shared local types module given `goal.ts` / `overflow.ts` / `auditor.ts` all touch Model-ish shapes? Do **not** add `@earendil-works/pi-ai` to `pi-agent-ext-core-task`'s deps — that breaks the convention and reintroduces the linker coupling the package explicitly avoided.

Branch off `origin/main` from the `video_generation` (main) worktree, not this orphan-bound `core_task` worktree.

type: grilling
blocked by: (none)
claimed: wayfinder-2026-07-26
closed: 2026-07-26 (resolved)

## Resolution

**Fixed** in commit `84ed1980` on branch `fix/main-green-827-fu1` (off `origin/main`).

Decision: derive an opaque type from the real consumer rather than hand-write a shape or add the dep:

```ts
type AuditorModel = NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
```

`@earendil-works/pi-coding-agent` (already a dep) does **not** re-export `Model` (confirmed: `tsc` → "has no exported member 'Model'"). Deriving from `createAgentSession` — the only real consumer of the model value — guarantees structural compatibility with **no** `@earendil-works/pi-ai` dependency, honoring the `overflow.ts` convention. All 4 `Model<any>` sites replaced.

Verified: `bun run typecheck` clean; 227 goal tests pass (`bun test src/goal`).
