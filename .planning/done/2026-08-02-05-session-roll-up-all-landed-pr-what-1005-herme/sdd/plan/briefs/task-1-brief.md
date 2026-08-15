### Task 1: Store assembly-manifest methods (pure, set↔hash consistent)

**Files:**
- Modify: `src/store/memory-store.ts` (add two methods near `formatForSystemPrompt` ~`:1260` and `formatProjectBlock` ~`:1290`)
- Test: `tests/store/memory-store.test.ts` (EDIT)

**Interfaces:**
- Consumes: `this.memoryEntries` / `this.userEntries` / `this.getActiveFailureEntries(maxAgeDays)` (`:663`), `this.decodeEntry(raw)` (returns `{ id, ... }`), `this.config.failureInjectionEnabled` / `failureInjectionMaxAgeDays` / `failureInjectionMaxEntries`, `DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS` / `DEFAULT_FAILURE_INJECTION_MAX_ENTRIES` (same constants `formatForSystemPrompt` uses at `:1271-1272`).
- Produces: `MemoryStore.getAssemblyManifest(): { block: string; mdIds: string[] }` and `MemoryStore.getProjectAssemblyManifest(projectName: string): { block: string; mdIds: string[] }`.

- [ ] **Step 1: Write the failing test** (append to `tests/store/memory-store.test.ts`)

```ts
import { describe, test, expect } from "bun:test";
// ... existing imports; reuse the file's existing MemoryStore construction helper / fixture.
// If the file has a `makeStore(entries)` helper, use it; otherwise build a tmp-dir store like
// the other tests in this file do (see how an existing test constructs MemoryStore).

describe("MemoryStore assembly manifest", () => {
  test("getAssemblyManifest block equals formatForSystemPrompt and ids match the rendered entries", async () => {
    const store = /* construct a MemoryStore loaded with 2 memory + 1 user + 1 active failure
                     entry, each carrying a frontmatter `id` (use serializeMetadataFrontmatter
                     or the file's existing frontmatter fixture helper) */;
    await store.loadFromDisk();

    const manifest = store.getAssemblyManifest();

    // (D2) block is EXACTLY what the agent is injected with:
    expect(manifest.block).toBe(store.formatForSystemPrompt());
    // ids are the unique md_ids of memory + user + post-filter active failures:
    const expected = new Set<string>([
      /* ids of the 2 memory + 1 user + 1 failure entries */
    ]);
    expect(new Set(manifest.mdIds)).toEqual(expected);
  });

  test("getProjectAssemblyManifest block equals formatProjectBlock and ids match project memory", async () => {
    const store = /* construct + loadFromDisk with project-memory entries carrying ids */;
    const name = "demo";
    const manifest = store.getProjectAssemblyManifest(name);
    expect(manifest.block).toBe(store.formatProjectBlock(name));
    expect(manifest.mdIds).toEqual(/* unique project-memory ids */);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: FAIL — `getAssemblyManifest is not a function` (compile error / type error).

- [ ] **Step 3: Implement the two methods** (in `src/store/memory-store.ts`, right after `formatProjectBlock`)

```ts
/**
 * Prompt-provenance manifest (UPSP §5): the rendered block (== formatForSystemPrompt())
 * PLUS the md_id set of EXACTLY the entries that block was built from — memory + user +
 * post-filter active failures. Same selection logic as formatForSystemPrompt so the logged
 * id set and any hash over `block` are consistent by construction. Failure filtering mirrors
 * formatForSystemPrompt's call-site config (active-only, maxAge, maxEntries).
 */
getAssemblyManifest(): { block: string; mdIds: string[] } {
  const block = this.formatForSystemPrompt();
  const ids: string[] = [];
  const pushIds = (entries: string[]) => {
    for (const raw of entries) {
      const id = this.decodeEntry(raw).id;
      if (id) ids.push(id);
    }
  };
  pushIds(this.memoryEntries);
  pushIds(this.userEntries);
  if (this.config.failureInjectionEnabled !== false) {
    const maxAgeDays = this.config.failureInjectionMaxAgeDays ?? DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS;
    const maxFailures = this.config.failureInjectionMaxEntries ?? DEFAULT_FAILURE_INJECTION_MAX_ENTRIES;
    pushIds(this.getActiveFailureEntries(maxAgeDays).slice(0, maxFailures));
  }
  return { block, mdIds: [...new Set(ids)] };
}

/**
 * Project-memory assembly manifest: the rendered project block (== formatProjectBlock())
 * PLUS the md_id set of the project-memory entries it renders. Mirrors formatProjectBlock's
 * selection (memoryEntries of the project store instance).
 */
getProjectAssemblyManifest(projectName: string): { block: string; mdIds: string[] } {
  const block = this.formatProjectBlock(projectName);
  const ids: string[] = [];
  for (const raw of this.memoryEntries) {
    const id = this.decodeEntry(raw).id;
    if (id) ids.push(id);
  }
  return { block, mdIds: [...new Set(ids)] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/memory-store.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/store/memory-store.test.ts
git commit -m "feat(hermes): add MemoryStore assembly-manifest methods (prompt-provenance, UPSP §5)"
```

---

