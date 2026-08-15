# Task 2 Report — `buildPromptAssembly` (sha256 receipt, UPSP §5)

## What changed

Purely additive — **2 files, 92 insertions, 0 deletions** (commit `cbd0d44c`):

1. **`bun-apps/pi-agent-ext-hermes-memory/src/prompt-context.ts`** (+29 lines)
   - Added `import { createHash } from "node:crypto";` (new top import line; existing imports untouched).
   - Appended new sibling export `buildPromptAssembly(...)` verbatim from the brief.
   - `buildPromptContext` is **byte-unchanged** — confirmed by `git diff` showing only the import hunk (`@@ -1,3 +1,4 @@`) and an appended hunk (`@@ -41,3 +42,31 @@`); no context lines of `buildPromptContext`'s body were modified. No ripple to `index.ts:331` or `handlers/preview-context.ts` (they consume `buildPromptContext`, which did not move).

2. **`bun-apps/pi-agent-ext-hermes-memory/tests/prompt-context.test.ts`** (NEW, +63 lines)

### Implementation (verbatim per brief)

```ts
import { createHash } from "node:crypto";   // new top-level import

export function buildPromptAssembly(
  config: Pick<MemoryConfig, "memoryMode">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): { mdIds: string[]; hash: string } | null {
  if (config.memoryMode === "policy-only") return null;
  const main = store.getAssemblyManifest();
  const proj = projectStore
    ? projectStore.getProjectAssemblyManifest(projectName)
    : { block: "", mdIds: [] as string[] };
  const block = [main.block, proj.block].filter((b) => b.length > 0).join("\n\n");
  if (!block) return null;
  const mdIds = [...new Set([...main.mdIds, ...proj.mdIds])];
  const hash = createHash("sha256").update(block, "utf8").digest("hex");
  return { mdIds, hash };
}
```

- Join mirrors `buildPromptContext` exactly: `[main.block, proj.block].filter((b) => b.length > 0).join("\n\n")` then `if (!block) return null;` (vs. `buildPromptContext`'s `parts.push` + `parts.join("\n\n")`).
- Sync crypto (synchronous `createHash`), no async contagion for the future `session_start` wire-in.
- Policy text excluded — only memory + project blocks are hashed.

## Test + how the store was stubbed

Used a minimal `as unknown as MemoryStore` stub (no tmp-dir store needed). The stub implements **only** the two Task-1 manifest methods the builder consumes:

```ts
function stubStore(
  main: { block: string; mdIds: string[] },
  project?: { block: string; mdIds: string[] },
): MemoryStore {
  return {
    getAssemblyManifest: () => main,
    getProjectAssemblyManifest: (_name: string) => project ?? { block: "", mdIds: [] },
  } as unknown as MemoryStore;
}
```

Cases asserted:
1. **Populated** — `main={block:"M",mdIds:["a","b"]}`, `proj={block:"P",mdIds:["b","c"]}` → `mdIds.sort()` = `["a","b","c"]` (unioned + deduped) and `hash` = `sha256("M\n\nP")` (expected hash recomputed in-test with the same `createHash("sha256").update("M\n\nP","utf8").digest("hex")`).
2. **`policy-only`** → `null`.
3. **Empty store** (`block:""`) → `null`.
4. **(extra)** `null projectStore` → still hashes the main block alone.
5. **(extra)** smoke check that `buildPromptContext` is still exported & callable (unchanged sibling).

## Commands + pass/fail

```text
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/prompt-context.test.ts )
```
→ **5 pass, 0 fail, 7 expect() calls** (12 ms).

```text
( cd bun-apps/pi-agent-ext-hermes-memory && bun run check )   # tsc --noEmit
```
→ **exit 0** (confirms `buildPromptContext` still typechecks unchanged).

```text
git commit -m "feat(hermes): add buildPromptAssembly (sha256 receipt over assembled block, UPSP §5)"
```
→ commit **`cbd0d44c`** on `feat/hermes-session-assembly-log`, built atop Task 1 (`3daac579`).

## Deviations

- None material. Added two small extra tests beyond the brief's three (null-`projectStore` path, and the `buildPromptContext`-still-exported smoke) — both are pure additions, low-cost, and lock in the contract; the brief's three assertions are all present verbatim.
- Did **not** modify `buildPromptContext`'s signature, body, or the existing `MemoryPolicyConfig` `Pick` — `buildPromptAssembly` uses its own independent `Pick<MemoryConfig, "memoryMode">`.

## Self-review

- ✅ Only the two brief-named files touched (`src/prompt-context.ts`, `tests/prompt-context.test.ts`).
- ✅ `buildPromptContext` byte-unchanged (`git diff` = 2 hunks, 0 deletions; its body lines are unchanged context).
- ✅ Join logic mirrors `buildPromptContext` (`filter(length>0).join("\n\n")` + `if (!block) return null`).
- ✅ Sync `node:crypto` `createHash` (no `async`/`await`).
- ✅ `mdIds` unioned + deduped via `[...new Set(...)]`.
- ✅ `null` short-circuits: `policy-only` mode, and empty/zero-length joined block.
- ✅ `bun run check` exit 0 → no ripple to `index.ts:331` / `handlers/preview-context.ts`.
- ✅ Consumes Task-1 methods only: `store.getAssemblyManifest()` + `projectStore.getProjectAssemblyManifest(name)`.
