### Task 6: Wire the capture into `session_start` (best-effort, once)

**Files:**
- Modify: `src/index.ts` (`session_start` handler, `:261` — after the stable-id backfill try/catch at `:311-322`, near the `scheduleSessionBackfill(sessionRepo, …)` call at `:312`)
- Test: `tests/integration/session-assembly.test.ts` (NEW)

**Interfaces:**
- Consumes: `buildPromptAssembly` (Task 2), `sessionRepo` (`index.ts:170`), `config` / `store` / `projectStore` / `projectName` (all in scope at the handler), `ctx.sessionManager.getSessionId()` (pi `extensions.md:669`).
- Produces: one `recordAssembly` call per session start, wrapped in try/catch.

- [ ] **Step 1: Write the failing test** (`tests/integration/session-assembly.test.ts`, NEW — use the file's/`tests/helpers`'s pi-extension harness pattern if one exists; otherwise unit-test the capture logic by extracting it)

```ts
import { describe, test, expect, mock } from "bun:test";
// Reuse an existing pi-event harness from tests/helpers if present (search tests/integration/*.test.ts
// for how they construct the extension + emit session_start). If no harness, extract the capture
// into a testable function captureAssembly({getSessionId, buildPromptAssembly, recordAssembly}).

describe("session_start assembly capture", () => {
  test("records manifest once; swallows capture errors; policy-only writes nothing", async () => {
    const recordAssembly = mock(() => Promise.resolve());
    // ... construct the extension with a stub sessionRepo whose recordAssembly = recordAssembly;
    //     emit session_start with a ctx.sessionManager.getSessionId = () => "sess-x";
    //     store preloaded with ≥1 memory entry carrying an id.

    // emit session_start
    expect(recordAssembly).toHaveBeenCalledTimes(1);
    const [sid, mdIds, hash] = recordAssembly.mock.calls[0];
    expect(sid).toBe("sess-x");
    expect(mdIds.length).toBeGreaterThan(0);
    expect(typeof hash).toBe("string");
  });

  test("a throwing recordAssembly does not abort session_start", async () => {
    const recordAssembly = mock(() => Promise.reject(new Error("boom")));
    // ... emit session_start; assert the handler resolves (no throw) despite the failure.
  });
});
```

> If extracting a pure `captureAssembly` helper is cleaner than driving the full pi harness, do that and unit-test it; then add a thin integration smoke that just asserts the `session_start` handler calls it with `ctx.sessionManager.getSessionId()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/session-assembly.test.ts )`
Expected: FAIL — no capture wired / `recordAssembly` not called.

- [ ] **Step 3: Wire the capture** (`src/index.ts`, inside the `session_start` handler, after the backfill try/catch and the `scheduleSessionBackfill(...)` call)

```ts
    // Per-session prompt-provenance (UPSP §5): capture the assembled md_id set + block hash
    // ONCE per session. Best-effort — never abort startup (mirrors the backfillStableIds guard).
    try {
      const sm = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
      const sid = sm?.getSessionId?.();
      if (sid) {
        const assembly = buildPromptAssembly(config, store, projectStore, projectName);
        if (assembly) {
          await sessionRepo.recordAssembly(sid, assembly.mdIds, assembly.hash);
        }
      }
    } catch {
      /* best-effort provenance; never block startup */
    }
```

Add the import near the existing `buildPromptContext` import (`index.ts:63`): `import { buildPromptContext, buildPromptAssembly } from "./prompt-context.js";`

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/integration/session-assembly.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/integration/session-assembly.test.ts
git commit -m "feat(hermes): wire per-session prompt-provenance capture at session_start"
```

---

