### Task 3: mirror UPDATE path (the core behavior change) + `store.updateCard`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `updateCard` to the `CardStore` interface + impl)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (rewrite `mirrorPlanningToStore` to the hash-compare INSERT/UPDATE/skip)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (edited/unchanged/new ticket cases)

**Interfaces:**
- Produces:
  - `CardStore.updateCard(card): Promise<void>` — `UPDATE memories SET content=?, frontmatter=?, last_referenced=? WHERE md_id=?` (Tier-1 md-wins refresh; bypasses dedup, which is pure identity).
  - `mirrorPlanningToStore` now computes `planningContentHash(card)`, reads the stored hash, and branches INSERT(new)/UPDATE(mismatch)/skip(match). Returns `{ planningMirrored, conflictMarkerEfforts }` (the `conflictMarkerEfforts` field is populated in T5; here it stays `[]`).

- [ ] **Step 1: Write the failing tests (append to `__tests__/walk-and-ingest.test.ts`)**

Add a new describe block (imports `walkAndIngest`, `createCardStore`, `mkdtempSync`, etc. are already in scope from the 08-impl planning test):
```ts
describe("walkAndIngest — planning mirror drift (09-impl T3)", () => {
  it("INSERTs a new ticket (no stored hash)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-ins-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-ins-mem-"));
    try {
      const effort = "drift-ins";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.planningMirrored >= 1);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /First\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("UPDATEs an edited ticket (hash mismatch) instead of skipping", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-upd-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-upd-mem-"));
    try {
      const effort = "drift-upd";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nOriginal.\n");
      await walkAndIngest(root, { memoryDir: mem });            // mirror once (INSERT + hash)
      // Edit the ticket content (git-canonical md changed).
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED body.\n");
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror → UPDATE
      assert.ok(r2.planningMirrored >= 1, "edited ticket must be re-mirrored (UPDATE), not skipped");
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /EDITED body\./);
      assert.doesNotMatch(c?.content ?? "", /Original\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips an UNCHANGED ticket (hash match — no write)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-skip-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-skip-mem-"));
    try {
      const effort = "drift-skip";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const body = "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nStable.\n";
      writeFileSync(ticketPath, body);
      await walkAndIngest(root, { memoryDir: mem });             // mirror once
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror unchanged
      assert.equal(r2.planningMirrored, 0, "unchanged ticket must be skipped (hash match)");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — the "edited ticket" case fails (08's append-only mirror skips the existing id, so content stays "Original"); the "skipped" case fails (08's mirror reports `planningMirrored >= 1` on every re-ingest because it has no hash-skip).

- [ ] **Step 3: Add `store.updateCard`**

In `src/store/card-store.ts`, extend the `CardStore` interface (after `upsertCard`):
```ts
  /** 09-impl: Tier-1 md-wins refresh — UPDATE an EXISTING card's content +
   *  frontmatter (NOT a new row). Bypasses dedup (pure identity cannot express
   *  "update"; the sync-layer hash-compare decides WHEN to call this). */
  updateCard(card: Card): Promise<void>;
```
Implement on `store` (same retry/recovery envelope as `upsertCard`; the UPDATE keys off `md_id = Card.id`):
```ts
    async updateCard(card: Card): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `UPDATE memories
                 SET content = ?, frontmatter = ?, last_referenced = ?
               WHERE md_id = ?`,
            )
            .run(card.content, JSON.stringify(card.frontmatter), today(), card.id);
        }),
      );
    },
```

- [ ] **Step 4: Rewrite `mirrorPlanningToStore` to the hash-compare branch**

In `src/walk-and-ingest.ts`, add the import at the top (alongside the existing `planningCardKindFromPath` import):
```ts
import { planningContentHash, getStoredHash, upsertHash } from "./store/planning-sync-state.js";
```
Add `conflictMarkerEfforts` to the `mirrorPlanningToStore` return type and to the `WalkAndIngestReceipt` interface (field added in T5 step; here the mirror just returns `[]`). Replace the body of `mirrorPlanningToStore` with:
```ts
/** Mirror step 8b (Phase-2 / 09-impl): self-correcting hash-compare mirror.
 *  For each planning source: deserialize → compute incoming content-hash
 *  (planningContentHash, reusing merge-plan.hashEntry) → read the stored hash →
 *  branch:
 *    - no existing card (getCard null) → upsertCard (INSERT; dedup keep) + write hash;
 *    - stored hash ≠ incoming → updateCard (UPDATE content/frontmatter) + refresh hash;
 *    - hash match → skip (no write; cheap).
 *  Dedup is consulted ONLY for the new-card identity check (INSERT branch); the
 *  UPDATE branch bypasses dedup (pure identity cannot express update — the
 *  DedupDecision union is keep/merge/skip, by design). Returns the # of cards
 *  mirrored (INSERT+UPDATE; skips not counted) + conflict-marker efforts (T5).
 *  Independent of the zk seam (planning is hermes-internal). The store reuses the
 *  SAME SQLite DB the memory/knowledge cards use; memoryDir defaults to the
 *  existing hermes memory DB dir. No-op when planningFiles is empty. */
async function mirrorPlanningToStore(
  planningFiles: string[],
  memoryDir?: string,
): Promise<{ planningMirrored: number; conflictMarkerEfforts: string[] }> {
  const conflictMarkerEfforts: string[] = []; // populated in T5
  if (planningFiles.length === 0) return { planningMirrored: 0, conflictMarkerEfforts };
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningMirrored = 0;
  try {
    for (const abs of planningFiles) {
      const kind = planningCardKindFromPath(abs);
      if (!kind) continue;
      let bytes = "";
      try {
        bytes = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const serializer = store.serializerFor(kind);
      const cards = serializer ? serializer.deserialize(bytes, { filePath: abs }) : [];
      for (const card of cards) {
        const incomingHash = planningContentHash(card);
        const existing = await store.getCard(card.id);
        const stored = await getStoredHash(store, card.id);
        if (existing === null || stored === null) {
          // New card (or first mirror after 08→09): INSERT through dedup, write hash.
          await store.upsertCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        } else if (stored.hash !== incomingHash) {
          // Drift (md edited): Tier-1 md-wins UPDATE + refresh hash.
          await store.updateCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        }
        // else: hash match → skip (no write).
      }
    }
  } finally {
    await store.close();
  }
  return { planningMirrored, conflictMarkerEfforts };
}
```
Update the call site in `walkAndIngest` (step 8b) to destructure the new return:
```ts
  // 8b. Planning DB-mirror (Phase-2 / 09-impl) — hash-compare INSERT/UPDATE/skip.
  const planMirror = await mirrorPlanningToStore(walk.files.planning, opts.memoryDir);
  const planningMirrored = planMirror.planningMirrored;
  const conflictMarkerEfforts = planMirror.conflictMarkerEfforts; // surfaced in T5's receipt
```
(Leave `conflictMarkerEfforts` a local for now; T5 adds it to the receipt. If the linter complains about an unused local in this task, reference it in a temporary `void conflictMarkerEfforts;` OR — preferred — add the receipt field already in this step's `WalkAndIngestReceipt` edit so it is consumed. Add `conflictMarkerEfforts: string[];` to the interface and `conflictMarkerEfforts,` to BOTH receipt returns now to avoid a dangling local.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: PASS (new drift tests + existing 08 planning walk test still green — INSERT path is unchanged behavior for a fresh card).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning mirror UPDATE path (hash-compare INSERT/UPDATE/skip) (09-impl T3)"
```

**DoD:** edited ticket → row UPDATED (not skipped); unchanged ticket → skip (`planningMirrored` 0 on re-mirror); new ticket → INSERT; 08's planning walk test still green; full suite green.

---

