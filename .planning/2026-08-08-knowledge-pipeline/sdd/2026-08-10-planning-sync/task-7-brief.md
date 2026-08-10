### Task 7: on-demand refresh (explicit — NOT every-read-rehash)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` (add `refreshPlanningCard(store, cardId, fsRoot)` + `refreshIfStale`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` (refresh tests)

**Interfaces:**
- Produces:
  - `refreshPlanningCard(store, cardId, fsRoot): Promise<{ action: "inserted" | "updated" | "unchanged" }>` — re-reads the source md for `cardId`, re-deserializes, re-hashes, re-mirrors via the SAME hash-compare branch as the mirror.
  - `refreshIfStale(store, cardId, fsRoot): Promise<boolean>` — true iff a refresh actually re-mirrored (drift detected).
- Documents (in the module doc): regular `getCard`/`getCardsByKind` return the DB row AS-IS (fast; no re-hash). Freshness is the backfill's job (T6) + explicit refresh (this task) — NEVER every-read-rehash.

> **Source-path derivation (pinned design choice — flag for the execution session):** `card_md_hash` keys by `card_id` only (no `source_path` column — the DDL is pinned in T1). `refreshPlanningCard` therefore re-derives the source md path from the id:
>   - `planning-effort:<effort>` → `<fsRoot>/.planning/<effort>/map.md`;
>   - `planning-ticket:<effort>:<no>` → glob `<fsRoot>/.planning/<effort>/tickets/<no>-*.md` (the id carries effort+no, NOT the slug — the slug is recovered by glob).
> If this proves awkward, a later task MAY add a `source_path` column to `card_md_hash` (additive); 09-impl keeps the pinned DDL and derives the path.

- [ ] **Step 1: Write the failing tests (append to `planning-sync-state.test.ts`)**

```ts
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
// (refreshPlanningCard + refreshIfStale already imported alongside the others)

describe("refreshPlanningCard (09-impl T7)", () => {
  const root = mkdtempSync(join(tmpdir(), "prefresh-"));
  const mem = mkdtempSync(join(tmpdir(), "prefresh-mem-"));
  const effort = "refresh-eff";
  const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
  const id = `planning-ticket:${effort}:01`;

  it("inserts when no stored card exists", async () => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "inserted");
    } finally {
      await store.close();
    }
  });

  it("updates when the source md changed (drift)", async () => {
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "updated");
      const c = await store.getCard(id);
      assert.match(c?.content ?? "", /EDITED\./);
    } finally {
      await store.close();
    }
  });

  it("is unchanged (no write) when the source md is the same", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "unchanged");
      assert.equal(await refreshIfStale(store, id, root), false);
    } finally {
      await store.close();
    }
  });

  it("returns {action:'absent'} when the source md vanished (caller may delete)", async () => {
    rmSync(ticketPath);
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal((r as { action: string }).action, "absent");
    } finally {
      await store.close();
    }
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: FAIL — `refreshPlanningCard` / `refreshIfStale` not exported.

- [ ] **Step 3: Implement refresh**

Append to `src/store/planning-sync-state.ts` (imports: `readFileSync`, `readdirSync` from `node:fs`; `join` from `node:path`; `parsePlanningPath`/`planningEffortId`/`planningTicketId` from `./planning-id.js`; `getStoredHash`/`upsertHash` already local):
```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlanningPath } from "./planning-id.js";

export type RefreshAction = "inserted" | "updated" | "unchanged" | "absent";

/** Resolve the source md path for a planning Card.id under fsRoot.
 *  effort → <fsRoot>/.planning/<effort>/map.md;
 *  ticket → glob <fsRoot>/.planning/<effort>/tickets/<no>-*.md (slug recovered). */
function sourcePathForId(cardId: string, fsRoot: string): string | null {
  // effort
  if (cardId.startsWith("planning-effort:")) {
    const effort = cardId.slice("planning-effort:".length);
    return join(fsRoot, ".planning", effort, "map.md");
  }
  // ticket
  if (cardId.startsWith("planning-ticket:")) {
    const rest = cardId.slice("planning-ticket:".length); // <effort>:<no>
    const sep = rest.lastIndexOf(":");
    if (sep < 0) return null;
    const effort = rest.slice(0, sep);
    const no = rest.slice(sep + 1);
    const dir = join(fsRoot, ".planning", effort, "tickets");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const match = names.find((n) => n.startsWith(`${no}-`) && n.endsWith(".md"));
    return match ? join(dir, match) : null;
  }
  return null;
}

/** On-demand refresh of ONE planning card: re-read its source md, re-deserialize,
 *  re-hash, and re-mirror via the SAME hash-compare branch as the mirror (T3):
 *  no stored card → INSERT+hash; mismatch → UPDATE+hash; match → unchanged. If
 *  the source md is absent, returns {action:'absent'} so the caller can decide
 *  to delete (the T4 sweep hard-deletes). Explicit — call this when freshness
 *  is needed; regular getCard/getCardsByKind do NOT re-hash (they return the DB
 *  row as-is; freshness is the T6 backfill's job + this). */
export async function refreshPlanningCard(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<{ action: RefreshAction }> {
  const src = sourcePathForId(cardId, fsRoot);
  if (!src) return { action: "absent" };
  let bytes: string;
  try {
    bytes = readFileSync(src, "utf8");
  } catch {
    return { action: "absent" };
  }
  // Derive the kind from the id prefix (the serializer registry is keyed by kind).
  const kind = cardId.startsWith("planning-effort:")
    ? "planning-effort"
    : cardId.startsWith("planning-ticket:")
      ? "planning-ticket"
      : null;
  if (!kind) return { action: "absent" };
  const serializer = store.serializerFor(kind);
  if (!serializer) return { action: "absent" };
  const cards = serializer.deserialize(bytes, { filePath: src });
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { action: "absent" };

  const incomingHash = planningContentHash(card);
  const existing = await store.getCard(cardId);
  const stored = await getStoredHash(store, cardId);
  if (existing === null || stored === null) {
    await store.upsertCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "inserted" };
  }
  if (stored.hash !== incomingHash) {
    await store.updateCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "updated" };
  }
  return { action: "unchanged" };
}

/** True iff a refresh actually re-mirrored (drift detected). Thin wrapper. */
export async function refreshIfStale(store: CardStore, cardId: string, fsRoot: string): Promise<boolean> {
  const r = await refreshPlanningCard(store, cardId, fsRoot);
  return r.action === "inserted" || r.action === "updated";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: PASS.

- [ ] **Step 5: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): on-demand planning refresh (explicit, not every-read-rehash) (09-impl T7)"
```

**DoD:** `refreshPlanningCard` re-hashes + re-mirrors a stale card (inserted/updated/unchanged/absent); `refreshIfStale` returns the drift boolean; regular reads are documented as non-rehashing; full suite green.

---

## Notes for the implementer

- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Master invariant (memory/user/failure/knowledge must not regress):** T1 is an ADDITIVE new table (`card_md_hash`) + an idempotent `ensureCardMdHashTable` (CREATE TABLE IF NOT EXISTS — NOT a `memories` rebuild, so the C3 column-drift trap cannot fire; the `memories` schema is byte-identical after 09). T2/T3/T4 ADD methods to the `CardStore` façade (a separate object from `MemoryStore` — memory cards keep their section-md path unchanged). T3 REWRITES `mirrorPlanningToStore` (08-impl's append-once mirror) to hash-compare UPDATE/skip — the behavior change is intentional and localized to the planning mirror; 08's FILES (`planning-id`/`planning-parse`/`planning-serializer`/`planning-dedup`) are NOT semantically regressed (dedup stays pure identity — the `DedupDecision.action` union has no `"update"` by design). T5 is an ADDITIVE pure helper in git-ops.ts (the `GitOps` interface + `realGitOps` are UNCHANGED). T6 is an ADDITIVE handler + a non-blocking `session_start` wiring. T7 is ADDITIVE to `planning-sync-state.ts`. If any non-planning test breaks at a task boundary, **STOP and fix**.
- **09↔10 boundary:** 09 owns mirror drift (hash-compare INSERT/UPDATE/skip) + delete reconciliation + conflict-marker flag (effort-level, human review, in the receipt) + on-demand refresh + background backfill. 10 owns `stale:`/`conflict:` queries + graduation gate + dep-validation. **09 MUST NOT build a `stale:`/`conflict:` query or a graduation gate.** The `card_md_hash` table's `kind` discriminator (default `'mirror'`) is 10's foundation: design so 10 adds `kind='validated'` rows WITHOUT a migration (the column + index already exist from T1).
- **`card_md_hash` is ADDITIVE (no `memories` rebuild) — the C3 reassurance.** Unlike the T5 target-CHECK migrations (which rebuild `memories` and carry a 21-column list), T1's `ensureCardMdHashTable` is a plain `CREATE TABLE IF NOT EXISTS` on a NEW table — there is no data to carry, no column list to drift, no transaction. This is why hash state lives in its own table (NOT a `memories` column).
- **Hash width + key (pinned):** `planningContentHash(card) = hashEntry(canonicalCardBytes(card))` where `hashEntry` (from `merge-plan.ts`) is sha256 → **16 hex chars**. Keyed by `card.id` (the `card_md_hash.card_id` PK = `Card.id` = `memories.md_id`). Canonical bytes = `JSON.stringify({ kind, content, frontmatter: sortKeysDeep(frontmatter) })` — stable JSON with recursively-sorted keys so frontmatter key ORDER can't cause a spurious drift, while any content/frontmatter-VALUE change does.
- **`isMidMerge` vs conflict-marker scan (T5 design choice — pinned):** `git-ops.isMidMerge(gitDir)` is REPO-STATE (sentinel files in `.git/`, repo-wide). The grill asks for a PER-EFFORT flag, so T5 adds `hasMergeConflictMarkers(content)` — a pure FILE-CONTENT scan for `<<<<<<<`/`=======`/`>>>>>>>` — in git-ops.ts (the merge-marker home, beside `MID_MERGE_SENTINELS`). `isMidMerge`/`GitOps`/`realGitOps` are UNCHANGED; `hasMergeConflictMarkers` is an additive pure export.
- **Refresh source-path derivation (T7 design choice — flagged for the execution session):** `card_md_hash` has no `source_path` column (DDL pinned in T1), so `refreshPlanningCard` re-derives the source md path from the id (effort → `map.md`; ticket → glob `tickets/<no>-*.md` since the id carries no slug). If this proves awkward, a LATER task MAY add an additive `source_path` column; 09 keeps the pinned DDL.
- **Typecheck command:** this package's typecheck script is `check` (`tsc --noEmit`) — use `bun run check` (NOT `bun run typecheck`, which does not exist in this package). The `bun test` command runs the full `node:test` suite.
- **No wayfind import.** 09 reuses only hermes-internal primitives (`merge-plan.hashEntry`, `session-backfill` shape, `git-ops` markers, 08's planning-id/serializer/dedup). The `.planning` md format remains the contract.
