# Backend-neutral `/memory-sync-markdown` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/memory-sync-markdown` command fully backend-neutral (no hardcoded "SQLite" in user-facing strings or the function name), surface the active backend label in its output, and prove it works identically on both the SQLite and SurrealDB backends via a shared, backend-agnostic sync contract.

**Architecture:** The sync write-path is already backend-neutral — it routes through `MemoryRepository.syncMemoryEntry()`, which both `SqliteMemoryRepository` and `SurrealMemoryRepository` implement. The only SQLite leakage is in (a) user-facing strings + the header comment, (b) the exported function name `syncMarkdownMemoriesToSqlite`, and (c) a handler test assertion that locks the old message in. The fix renames the function, makes the messages carry the active backend label (mirroring the existing `labelFor` dep pattern from `/memory-switch-backend`), and adds a shared `runMarkdownSyncContract` factory to `repository-contract.test.ts` — instantiated for SQLite (always runs) and SurrealDB (gated behind `localDescribe`, skips when no local server, exactly like the existing surreal contract).

**Tech Stack:** TypeScript + Bun (`bun test`, `bun run check` = `tsc --noEmit`); pi extension API (`ExtensionAPI`, `ExtensionCommandContext`); hermes-memory `MemoryRepository` seam.

## Global Constraints

- **Backend-neutral user-facing strings:** no literal `SQLite` or `SurrealDB` (any case) may appear in command output templates. The active backend is surfaced only via the `getLabel` dependency.
- **No CI service container:** SurrealDB coverage stays gated behind `isSurrealUp()` / `localDescribe` (runs on dev machines, skips in CI). Do NOT add a SurrealDB service to `.github/workflows/ci.yml`.
- **Match existing patterns:** the `getLabel` dep mirrors `SwitchBackendDeps.labelFor`; the shared contract mirrors `runMemoryRepositoryContract`.
- **All written artifacts in English** (code, comments, commits, this plan).
- **Out of scope (follow-up, NOT this plan):** repo-wide doc sweep of other SQLite-hardcoded strings (`memory-tool.ts` "SQLite row" notices, `learn-memory.ts` help text, README/PRD/CHANGELOG prose).
- **Run tests from the package dir** (never top-level `cd`): `( cd bun-apps/pi-agent-ext-hermes-memory && <cmd> )`.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/handlers/sync-markdown-memories.ts` | The command + sync function. Rename fn; neutralize messages; add `getLabel` dep. | Modify |
| `src/index.ts` | Wiring. Rename import + 2 call sites; pass `() => backendLabel` to registrar; fix adjacent comment. | Modify |
| `src/config.ts` | A comment referencing the old fn name. | Modify (comment only) |
| `tests/config.test.ts` | A comment referencing the old fn name. | Modify (comment only) |
| `tests/handlers/sync-markdown-memories.test.ts` | Handler test. Update import/calls; rewrite the message assertion; add neutrality guard test. | Modify |
| `tests/store/repository-contract.test.ts` | Add shared `runMarkdownSyncContract` factory + SQLite instantiation. | Modify |
| `tests/store/surreal/surreal-memory-repo-contract.test.ts` | Call the shared factory for SurrealDB inside the existing `if (up)` guard. | Modify |

---

## Task 1: Pure rename `syncMarkdownMemoriesToSqlite` → `syncMarkdownMemories`

**Why first / atomic:** renaming the exported symbol breaks every importer at compile time, so all call sites + the two comment references + the test's import/calls must move in one commit. Messages and behavior stay **identical** this task (existing assertions still pass); messaging changes in Task 2.

**Files:**
- Modify: `src/handlers/sync-markdown-memories.ts` (definition + the internal call inside the handler)
- Modify: `src/index.ts` (import line ~53; call sites ~161 & ~212; comment ~162)
- Modify: `src/config.ts` (comment ~109)
- Modify: `tests/config.test.ts` (comment ~433)
- Modify: `tests/handlers/sync-markdown-memories.test.ts` (import; calls ~173 & ~201)
- Test: `tests/handlers/sync-markdown-memories.test.ts`

**Interfaces:**
- Produces: `export async function syncMarkdownMemories(memoryRepo, globalDir, projectsMemoryDir?, agentRoot = AGENT_ROOT)` — identical signature, new name. Callers in `src/index.ts` and the test import the new name.

- [ ] **Step 1: Rename the definition + internal call in the handler**

In `src/handlers/sync-markdown-memories.ts`, rename the function declaration and its one internal call:

```ts
// definition (was: export async function syncMarkdownMemoriesToSqlite)
export async function syncMarkdownMemories(
  memoryRepo: MemoryRepository,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): Promise<BackfillCounters & { projectCount: number }> {
```

And inside `registerSyncMarkdownMemoriesCommand`'s handler:
```ts
const counters = await syncMarkdownMemories(memoryRepo, globalDir, projectsMemoryDir, agentRoot);
```

(Leave the messages, description, and header comment unchanged this task — Task 2 owns those.)

- [ ] **Step 2: Update `src/index.ts` import + 2 call sites + adjacent comment**

Import line (~53):
```ts
import { registerSyncMarkdownMemoriesCommand, syncMarkdownMemories } from "./handlers/sync-markdown-memories.js";
```

Startup-sync call site (~161) and its catch comment:
```ts
    try {
      await syncMarkdownMemories(memoryRepo, globalDir, config.projectsMemoryDir, agentRoot);
    } catch {
      // Best-effort only: failed markdown backfill should not block extension startup.
    }
```

Post-switch re-sync call site (~212):
```ts
      await syncMarkdownMemories(currentBundle.memoryRepo, globalDir, config.projectsMemoryDir, agentRoot);
```

- [ ] **Step 3: Update the two comment references**

`src/config.ts` (~109) — rename inside the comment:
```
 *  (syncMarkdownMemories). Skipped in the consolidation child, which
```

`tests/config.test.ts` (~433) — rename inside the comment:
```
  // a full extension session, so it re-ran the startup syncMarkdownMemories
```

- [ ] **Step 4: Update the handler test import + 2 calls**

`tests/handlers/sync-markdown-memories.test.ts`:
```ts
import {
  registerSyncMarkdownMemoriesCommand,
  syncMarkdownMemories,
} from '../../src/handlers/sync-markdown-memories.js';
```

Call sites (~173, ~201): `syncMarkdownMemoriesToSqlite(...)` → `syncMarkdownMemories(...)`. Do **not** touch the `includes('SQLite sync complete')` assertion yet (Task 2).

- [ ] **Step 5: Verify — tests green + typecheck green**

Run:
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/sync-markdown-memories.test.ts && bun run check )
```
Expected: all tests PASS; `tsc --noEmit` exits 0. Grep confirms no stale references:
```bash
grep -rn "syncMarkdownMemoriesToSqlite" bun-apps/pi-agent-ext-hermes-memory/src bun-apps/pi-agent-ext-hermes-memory/tests
```
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/sync-markdown-memories.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/config.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/config.test.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/sync-markdown-memories.test.ts
git commit -m "refactor(hermes-memory): rename syncMarkdownMemoriesToSqlite -> syncMarkdownMemories"
```

---

## Task 2: Backend-neutral messaging + `getLabel` dep + neutrality guard test

**TDD:** write the failing neutrality test first, watch it fail on the old "SQLite"-laden message, then neutralize.

**Files:**
- Modify: `src/handlers/sync-markdown-memories.ts` (header comment, description, all notify strings, add `getLabel` param)
- Modify: `src/index.ts` (registrar call ~320: pass `() => backendLabel`)
- Test: `tests/handlers/sync-markdown-memories.test.ts`

**Interfaces:**
- Consumes: `backendLabel` (`let string`, already maintained in `src/index.ts`, updated on `/memory-switch-backend`).
- Produces: `registerSyncMarkdownMemoriesCommand` gains a 6th param `getLabel: () => string = () => "memory store"`. The completion message renders `(backend: ${getLabel()})`.

- [ ] **Step 1: Write the failing neutrality guard test**

Append a new test case to `tests/handlers/sync-markdown-memories.test.ts` (inside the existing `describe`):

```ts
  it('command output is backend-neutral and surfaces the active backend label', async () => {
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      'neutrality probe <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const notifications: Array<{ message: string; severity: string }> = [];
    const ctx = {
      ui: {
        notify: (message: string, severity: string) => {
          notifications.push({ message, severity });
        },
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(
      mockPi, memoryRepo, globalDir, undefined, agentRoot,
      () => 'TestBackend · ns=x',
    );
    await handler({}, ctx);

    const all = notifications.map((n) => n.message).join('\n');
    assert.ok(all.includes('TestBackend · ns=x'), 'must surface the active backend label');
    assert.ok(!all.toLowerCase().includes('sqlite'), 'must not hardcode "sqlite" (any case)');
    assert.ok(!all.toLowerCase().includes('surrealdb'), 'must not hardcode "surrealdb" (any case)');
    assert.ok(all.includes('memory store sync complete'), 'must use the backend-neutral noun');
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/sync-markdown-memories.test.ts )
```
Expected: FAIL — old message contains `SQLite sync complete`; assertion `!all.toLowerCase().includes('sqlite')` trips; `TestBackend · ns=x` is absent.

- [ ] **Step 3: Neutralize the handler — header comment, description, messages, `getLabel` dep**

In `src/handlers/sync-markdown-memories.ts`, replace the header comment:

```ts
/**
 * Markdown memory sync command — /memory-sync-markdown imports existing
 * Markdown-backed memories into the active search store (SQLite by default,
 * SurrealDB when configured). The write path is backend-neutral: it goes
 * through MemoryRepository.syncMemoryEntry, so the same command works for
 * every backend. The active backend's label is surfaced in the completion
 * message via the getLabel dependency.
 */
```

Replace the `registerSyncMarkdownMemoriesCommand` signature + body messages:

```ts
export function registerSyncMarkdownMemoriesCommand(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository,
  globalDir: string,
  projectsMemoryDir: string | undefined,
  agentRoot = AGENT_ROOT,
  getLabel: () => string = () => "memory store",
): void {
  pi.registerCommand('memory-sync-markdown', {
    description: 'Backfill Markdown memories into the active search store',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔄 Scanning Markdown memory files for backfill into the active store…', 'info');

      try {
        const counters = await syncMarkdownMemories(memoryRepo, globalDir, projectsMemoryDir, agentRoot);
        const label = getLabel();

        let output = `\n✅ Markdown → memory store sync complete! (backend: ${label})\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Files scanned: ${counters.filesScanned}\n`;
        output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
        output += `├─ Imported: ${counters.imported}\n`;
        output += `└─ Skipped as duplicates: ${counters.skipped}\n`;

        if (counters.projectCount > 0) {
          output += `\n📁 Project memories scanned: ${counters.projectCount}\n`;
        }

        if (counters.warnings.length > 0) {
          output += `\n⚠️ Warnings (${counters.warnings.length}):\n`;
          for (const warning of counters.warnings.slice(0, 5)) {
            output += `├─ ${warning}\n`;
          }
          if (counters.warnings.length > 5) {
            output += `└─ ... and ${counters.warnings.length - 5} more\n`;
          }
        }

        output += `\n💡 Re-running this command is safe — existing rows are de-duplicated.`;
        ctx.ui.notify(output, 'info');
      } catch (err) {
        ctx.ui.notify(`❌ Markdown sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
```

- [ ] **Step 4: Wire the real label into `src/index.ts`**

Registrar call (~320) — pass the live label getter as the 6th arg:

```ts
  registerSyncMarkdownMemoriesCommand(pi, memoryRepo, globalDir, config.projectsMemoryDir, agentRoot, () => backendLabel);
```

(`backendLabel` is the existing `let` updated at startup and on every `/memory-switch-backend`, so the command always reads the current backend.)

- [ ] **Step 5: Update the old assertion in the handler test**

In the `backfill command is idempotent across repeated runs` test, replace:

```ts
    assert.ok(
      notifications.some((n) => n.message.includes('SQLite sync complete')),
      'command should report completion',
    );
```

with the backend-neutral form:

```ts
    assert.ok(
      notifications.some((n) => n.message.includes('memory store sync complete')),
      'command should report completion',
    );
```

(That test still calls `registerSyncMarkdownMemoriesCommand` with 5 args — the `getLabel` default `"memory store"` applies, so the completion line reads `(backend: memory store)` and the neutral noun assertion holds.)

- [ ] **Step 6: Verify — all handler tests green + typecheck green**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/handlers/sync-markdown-memories.test.ts && bun run check )
```
Expected: all tests PASS (including the new neutrality guard); `tsc --noEmit` exits 0.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/src/handlers/sync-markdown-memories.ts \
        bun-apps/pi-agent-ext-hermes-memory/src/index.ts \
        bun-apps/pi-agent-ext-hermes-memory/tests/handlers/sync-markdown-memories.test.ts
git commit -m "feat(hermes-memory): make /memory-sync-markdown backend-neutral + surface active backend label"
```

---

## Task 3: Shared backend-agnostic markdown-sync contract (SQLite)

**Why:** the handler test proves the command wiring but only against SQLite. A shared contract parametrized over `MemoryRepository` proves the sync *behavior* is identical across backends and is the structural guard against cross-backend drift. This task adds the factory + SQLite instantiation; Task 4 wires SurrealDB.

**Files:**
- Modify: `tests/store/repository-contract.test.ts` (add `runMarkdownSyncContract` factory near `runMemoryRepositoryContract`; add SQLite instantiation at the bottom)
- Test: `tests/store/repository-contract.test.ts`

**Interfaces:**
- Consumes: `syncMarkdownMemories` (Task 1 name) from `../../src/handlers/sync-markdown-memories.js`; `ENTRY_DELIMITER` from `../../src/constants.js`; `MemoryRepository` type.
- Produces: `export function runMarkdownSyncContract(name: string, make: () => Promise<{ repo: MemoryRepository; close: () => Promise<void> }>): void`.

- [ ] **Step 1: Add the imports the factory needs**

At the top of `tests/store/repository-contract.test.ts`, alongside the existing imports, add:

```ts
import { syncMarkdownMemories } from "../../src/handlers/sync-markdown-memories.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
```

- [ ] **Step 2: Add the `runMarkdownSyncContract` factory**

Place it just after the existing `runMemoryRepositoryContract` factory (before `runSessionRepositoryContract` is fine, or immediately after it — keep factories grouped):

```ts
// ---------------------------------------------------------------------------
// Markdown → store sync contract (backend-agnostic)
//
// Proves /memory-sync-markdown's sync function behaves identically on every
// MemoryRepository: entries import, become searchable, and de-duplicate on
// re-run. The markdown files are backend-agnostic; only the repo differs, so
// the factory takes the same make() shape as the repository contract.
// ---------------------------------------------------------------------------

export function runMarkdownSyncContract(
  name: string,
  make: () => Promise<{ repo: MemoryRepository; close: () => Promise<void> }>,
): void {
  describe(`${name} markdown→store sync contract`, () => {
    it("imports markdown entries and makes them searchable", async () => {
      const { repo, close } = await make();
      const root = mkdtempSync(join(tmpdir(), `hm-sync-${name.toLowerCase()}-`));
      const agentRoot = join(root, "agent");
      const globalDir = join(agentRoot, "memory");
      mkdirSync(globalDir, { recursive: true });
      try {
        writeFileSync(
          join(globalDir, "MEMORY.md"),
          [
            "contract memory one <!-- created=2026-05-08, last=2026-05-08 -->",
            "contract memory two <!-- created=2026-05-08, last=2026-05-09 -->",
          ].join(ENTRY_DELIMITER),
          "utf-8",
        );

        const first = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot);
        expect(first.imported).toBe(2);

        const hits = await repo.searchMemories("contract memory one", { target: "memory" });
        expect(hits.some((m) => m.content === "contract memory one")).toBe(true);
      } finally {
        await close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("is idempotent across repeated runs (no duplicate rows)", async () => {
      const { repo, close } = await make();
      const root = mkdtempSync(join(tmpdir(), `hm-sync-idem-${name.toLowerCase()}-`));
      const agentRoot = join(root, "agent");
      const globalDir = join(agentRoot, "memory");
      mkdirSync(globalDir, { recursive: true });
      try {
        writeFileSync(
          join(globalDir, "MEMORY.md"),
          "idempotent entry <!-- created=2026-05-08, last=2026-05-09 -->",
          "utf-8",
        );

        await syncMarkdownMemories(repo, globalDir, undefined, agentRoot);
        const second = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot);

        expect(second.imported).toBe(0);
        expect(second.skipped).toBe(1);
      } finally {
        await close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}
```

- [ ] **Step 3: Instantiate the contract for SQLite (bottom of file)**

At the bottom of `tests/store/repository-contract.test.ts`, next to the existing SQLite instantiations:

```ts
runMarkdownSyncContract("SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hm-contract-sync-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  return {
    repo: new SqliteMemoryRepository(backend),
    close: async () => {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
```

- [ ] **Step 4: Verify — the contract passes against SQLite**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/repository-contract.test.ts )
```
Expected: `SQLite markdown→store sync contract` — 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/tests/store/repository-contract.test.ts
git commit -m "test(hermes-memory): add backend-agnostic markdown-sync contract (SQLite)"
```

---

## Task 4: Wire the shared contract into the SurrealDB suite

**Why:** this is the "supports both backends" proof. It reuses the exact `localDescribe`/`isSurrealUp` gate the existing surreal contract uses, so it runs on dev machines (when a local SurrealDB server is up) and silently skips in CI — no service container, matching the repo's established convention.

**Files:**
- Modify: `tests/store/surreal/surreal-memory-repo-contract.test.ts` (extend the dynamic-import destructure; add one factory call inside `if (up)`)
- Test: `tests/store/surreal/surreal-memory-repo-contract.test.ts`

**Interfaces:**
- Consumes: `runMarkdownSyncContract` (Task 3) from `../repository-contract.test.js`; `SurrealBackend`, `SurrealMemoryRepository`, `uniqueNs` (already imported in this file).

- [ ] **Step 1: Extend the dynamic import to also pull the new factory**

In `tests/store/surreal/surreal-memory-repo-contract.test.ts`, change the destructure inside `if (up)`:

```ts
  const { runMemoryRepositoryContract, runMarkdownSyncContract } = await import("../repository-contract.test.js");
```

- [ ] **Step 2: Register the sync contract for SurrealDB**

Still inside the `if (up) { ... }` block, immediately after the existing `runMemoryRepositoryContract("SurrealDB", ...)` call, add:

```ts
  runMarkdownSyncContract("SurrealDB", async () => {
    const ns = uniqueNs();
    const backend = new SurrealBackend({ namespace: ns, database: ns });
    await backend.init();
    return {
      repo: new SurrealMemoryRepository(backend),
      close: async () => {
        try { await backend.client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch {}
        await backend.close();
      },
    };
  });
```

- [ ] **Step 3: Verify locally (or confirm graceful skip)**

If a local SurrealDB server is running on `http://127.0.0.1:8000`:
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-repo-contract.test.ts )
```
Expected: `SurrealDB markdown→store sync contract` — 2 tests PASS.

If no server is running, the whole block skips (the `if (up)` guard). Confirm the file still loads with no errors:
```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test tests/store/surreal/surreal-memory-repo-contract.test.ts )
```
Expected: 0 failures, suite skipped (no crash from the added dynamic import).

- [ ] **Step 4: Full package green check**

```bash
( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bun run check )
```
Expected: all tests PASS (surreal ones skip in CI / when no server); `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-hermes-memory/tests/store/surreal/surreal-memory-repo-contract.test.ts
git commit -m "test(hermes-memory): run markdown-sync contract against SurrealDB (localDescribe-gated)"
```

---

## Verification (whole-effort acceptance)

After all four tasks:

1. **Backend-neutral by construction** — no user-facing command string contains a hardcoded backend token:
   ```bash
   grep -rin "sqlite\|surrealdb" bun-apps/pi-agent-ext-hermes-memory/src/handlers/sync-markdown-memories.ts
   ```
   Expected: only matches in the header *comment* explaining the two backends — never in a `notify`/`description` string.

2. **Rename complete** — `grep -rn "syncMarkdownMemoriesToSqlite" bun-apps/pi-agent-ext-hermes-memory` → no matches.

3. **Both backends proven** — `SQLite markdown→store sync contract` passes always; `SurrealDB markdown→store sync contract` passes locally (server up), skips in CI.

4. **Inconsistency guard live** — the neutrality test in `tests/handlers/sync-markdown-memories.test.ts` fails loudly if anyone re-introduces a hardcoded backend token.

5. **Green gate** — `( cd bun-apps/pi-agent-ext-hermes-memory && bun test && bun run check )` exits 0.

## Notes / Skills for every session

- Domain: `bun-apps/pi-agent-ext-hermes-memory` (the hermes-memory extension). Backend seam: `src/store/repository.ts`. Backend factory: `src/store/backend-factory.ts`.
- Skills to consult: `superpowers:test-driven-development` (red→green per task), `superpowers:verification-before-completion` (run the exact verify commands before claiming done).
- Standing preference: reply in 繁體中文; all written artifacts (code/comments/commits/this plan) in English.
