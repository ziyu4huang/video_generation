### Task 4: delete reconciliation (hard-delete on md absence) + `store.deleteCard`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `deleteCard` to the `CardStore` interface + impl)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (add `reconcilePlanningDeletions`; call it from `walkAndIngest` after the mirror)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (delete-sweep test)

**Interfaces:**
- Produces:
  - `CardStore.deleteCard(id): Promise<void>` — `DELETE FROM memories WHERE md_id = ?`.
  - `reconcilePlanningDeletions(presentPlanningFiles, memoryDir?)` — given the set of planning md files PRESENT on disk, find DB planning-cards (kind `planning-effort` + `planning-ticket`) whose source md is absent → hard-delete the `memories` row + its `card_md_hash` row. Returns the # deleted (for the receipt / notify).

- [ ] **Step 1: Write the failing test (append to `__tests__/walk-and-ingest.test.ts`)**

```ts
describe("walkAndIngest — planning delete reconciliation (09-impl T4)", () => {
  it("hard-deletes planning rows whose source md vanished (md-wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "precon-"));
    const mem = mkdtempSync(join(tmpdir(), "precon-mem-"));
    try {
      const effort = "recon-del";
      const t01 = join(root, ".planning", effort, "tickets", "01-keep.md");
      const t02 = join(root, ".planning", effort, "tickets", "02-gone.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(t01, "---\ntype: task\nstatus: closed\n---\n# 01 — keep\n\n## Resolution\nKeep.\n");
      writeFileSync(t02, "---\ntype: task\nstatus: closed\n---\n# 02 — gone\n\n## Resolution\nGone.\n");
      await walkAndIngest(root, { memoryDir: mem });             // mirror both tickets
      // Source md for ticket 02 is removed (git rm / file deleted).
      require("node:fs").unlinkSync(t02);
      await walkAndIngest(root, { memoryDir: mem });             // re-walk → sweep deletes 02
      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      await store.close();
      const ids = tickets.map((c) => c.id).sort();
      assert.deepEqual(ids, [`planning-ticket:${effort}:01`]);
      assert.ok(!ids.includes(`planning-ticket:${effort}:02`), "vanished ticket row must be hard-deleted");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```
> NOTE: replace the inline `require("node:fs")` with the file's existing `unlinkSync` import if present; otherwise add `unlinkSync` to the existing `node:fs` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — ticket 02's row persists (08's mirror never deletes; no sweep exists).

- [ ] **Step 3: Add `store.deleteCard`**

In `src/store/card-store.ts`, extend the `CardStore` interface (after `updateCard`):
```ts
  /** 09-impl: hard-delete a card row by Card.id (md-wins reconciliation — the
   *  source md vanished). Also paired with deleteCardMdHash by the sweep. */
  deleteCard(id: string): Promise<void>;
```
Implement on `store`:
```ts
    async deleteCard(id: string): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM memories WHERE md_id = ?").run(id);
        }),
      );
    },
```

- [ ] **Step 4: Add `reconcilePlanningDeletions` + call it from `walkAndIngest`**

In `src/walk-and-ingest.ts`, add imports (alongside the T3 sync-state import):
```ts
import { deleteHash } from "./store/planning-sync-state.js";
import { parsePlanningPath, planningEffortId, planningTicketId } from "./store/planning-id.js";
```
Add the helper (next to `mirrorPlanningToStore`):
```ts
/** Mirror step 8c (Phase-2 / 09-impl): md-wins delete reconciliation. Given the
 *  set of planning md files PRESENT on disk, find DB planning-cards whose source
 *  md is absent → hard-delete the memories row + its card_md_hash row (Tier-1 md
 *  wins; the DB mirror must not keep rows for deleted md). Tombstoning is
 *  out-of-scope (09 hard-deletes). Returns the # of rows deleted. No-op when no
 *  planning-cards are stored. */
async function reconcilePlanningDeletions(
  presentPlanningFiles: string[],
  memoryDir?: string,
): Promise<{ planningDeleted: number }> {
  const presentIds = new Set<string>();
  for (const abs of presentPlanningFiles) {
    const info = parsePlanningPath(abs);
    if (!info) continue;
    presentIds.add(info.kind === "planning-effort" ? planningEffortId(info.effort) : planningTicketId(info.effort, info.ticketNo!));
  }
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningDeleted = 0;
  try {
    for (const kind of ["planning-effort", "planning-ticket"] as const) {
      const rows = await store.getCardsByKind(kind);
      for (const card of rows) {
        if (!presentIds.has(card.id)) {
          await store.deleteCard(card.id);
          await deleteHash(store, card.id);
          planningDeleted++;
        }
      }
    }
  } finally {
    await store.close();
  }
  return { planningDeleted };
}
```
Call it from `walkAndIngest` AFTER the planning mirror (step 8b):
```ts
  // 8c. Planning delete reconciliation (Phase-2 / 09-impl) — md-wins sweep.
  await reconcilePlanningDeletions(walk.files.planning, opts.memoryDir);
```
(The # deleted is available for a future receipt field; 09-impl keeps the receipt minimal — `planningMirrored` + `conflictMarkerEfforts` — and does NOT add a `planningDeleted` field unless a later task needs it. If desired for diagnostics, add `planningDeleted: number` to the receipt in the same shape as `planningMirrored`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: PASS (new delete test + T3 drift tests + 08 walk test).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning delete reconciliation — md-wins hard-delete sweep (09-impl T4)"
```

**DoD:** removing a ticket md → its planning-ticket row + its `card_md_hash` row gone on next walk; other planning rows intact; full suite green.

---

