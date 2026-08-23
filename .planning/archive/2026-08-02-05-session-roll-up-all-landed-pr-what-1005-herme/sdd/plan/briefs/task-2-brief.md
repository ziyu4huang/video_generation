### Task 2: `buildPromptAssembly` builder (pure, SHA-256 receipt)

**Files:**
- Modify: `src/prompt-context.ts` (add `buildPromptAssembly` alongside `buildPromptContext`)
- Test: `tests/prompt-context.test.ts` (NEW)

**Interfaces:**
- Consumes: `store.getAssemblyManifest()` + `projectStore.getProjectAssemblyManifest(name)` (Task 1); `config.memoryMode`.
- Produces: `buildPromptAssembly(config, store, projectStore, projectName): { mdIds: string[]; hash: string } | null`. `buildPromptContext` is NOT modified.

- [ ] **Step 1: Write the failing test** (`tests/prompt-context.test.ts`, NEW)

```ts
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { buildPromptAssembly, buildPromptContext } from "../src/prompt-context.js";
// import a minimal MemoryStore stub or a real tmp-dir MemoryStore (see tests/store helpers).
// If stubbing, implement getAssemblyManifest/getProjectAssemblyManifest returning fixed blocks+ids.

describe("buildPromptAssembly", () => {
  test("populated store → unions ids + sha256 of joined memoryBlock+projectBlock", async () => {
    const store = /* MemoryStore whose getAssemblyManifest() = { block: "M", mdIds: ["a","b"] } */;
    const projectStore = /* getProjectAssemblyManifest("p") = { block: "P", mdIds: ["b","c"] } */;
    const config = { memoryMode: "default" } as any;

    const got = buildPromptAssembly(config, store, projectStore, "p")!;

    expect(got.mdIds.sort()).toEqual(["a", "b", "c"]);            // unioned + deduped
    const expectedHash = createHash("sha256").update("M\n\nP", "utf8").digest("hex");
    expect(got.hash).toBe(expectedHash);
  });

  test("policy-only mode → null", () => {
    const got = buildPromptAssembly({ memoryMode: "policy-only" } as any, store, null, "p");
    expect(got).toBeNull();
  });

  test("empty store (no block) → null", () => {
    const store = /* getAssemblyManifest() = { block: "", mdIds: [] } */;
    expect(buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/prompt-context.test.ts )`
Expected: FAIL — `buildPromptAssembly is not a function`.

- [ ] **Step 3: Implement** (in `src/prompt-context.ts`)

```ts
import { createHash } from "node:crypto";
// keep existing imports; DO NOT change buildPromptContext.

/**
 * Prompt-provenance receipt (UPSP §5 request_body_sha256 analogue). Returns the unioned
 * md_id set across all injected blocks + a SHA-256 of the joined memory+project block —
 * mirroring buildPromptContext's assembly so the logged set and hash describe the exact
 * text the agent is injected with (policy text excluded; it is constant config, not memory).
 * Returns null for policy-only mode or an empty assembly (nothing to prove).
 *
 * Sync: node:crypto's createHash is synchronous, avoiding async contagion at the session_start
 * wire-in. `buildPromptContext` is unchanged (no ripple to index.ts:331 / preview-context.ts).
 */
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

> Note: `MemoryConfig` and `MemoryStore` are already imported in `prompt-context.ts` (used by `buildPromptContext`). If `MemoryConfig` is imported as a type-only import, ensure `memoryMode` is present on the existing `Pick` — widen this function's `Pick<"memoryMode">` independently so `buildPromptContext`'s signature is untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/prompt-context.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/prompt-context.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/prompt-context.test.ts
git commit -m "feat(hermes): add buildPromptAssembly (sha256 receipt over assembled block, UPSP §5)"
```

---

