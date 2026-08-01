import { describe, test, expect, beforeAll } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryStore } from "../../src/store/memory-store";
import type { StableIdBackfillProvider } from "../../src/store/memory-store";
import type { MemoryConfig } from "../../src/types";

let MEMORY_DIR = "";

beforeAll(async () => {
  MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-backfill-test-"));
});

function makeStore(): MemoryStore {
  return new MemoryStore({
    memoryDir: MEMORY_DIR,
    memoryCharLimit: 10000,
    userCharLimit: 10000,
  } as MemoryConfig);
}

describe("backfillStableIds", () => {
  test("upgrades legacy comment entries to frontmatter + assigns uuid; idempotent re-run is a no-op", async () => {
    const store = makeStore();
    // seed two legacy entries directly into the private arrays
    (store as any).memoryEntries = [
      "alpha note <!-- created=2026-08-01, last=2026-08-01 -->",
      "beta note <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const seen = new Map<string, string>(); // content -> mdId assigned
    const provider: StableIdBackfillProvider = {
      getMdIdByContent: async (_t, content) => seen.get(content) ?? null,
      setMdIdByContent: async (_t, content, mdId) => { seen.set(content, mdId); return 1; },
    };
    store.setStableIdBackfillProvider(provider);

    const r1 = await store.backfillStableIds();
    expect(r1.upgraded).toBe(2);
    expect(r1.mdIdsMirrored).toBe(2);
    // both entries now frontmatter with distinct uuids
    const entries = (store as any).memoryEntries as string[];
    expect(entries.every((e) => e.startsWith("---\n"))).toBe(true);
    const ids = entries.map((e) => e.match(/^id: (.+)$/m)![1]);
    expect(new Set(ids).size).toBe(2);

    const r2 = await store.backfillStableIds(); // re-run: everything already frontmatter+has-id
    expect(r2.upgraded).toBe(0);
    expect(r2.mdIdsMirrored).toBe(0);
  });

  test("resume-safe: a mix of legacy + already-frontmatter only upgrades the legacy", async () => {
    const store = makeStore();
    (store as any).memoryEntries = [
      "---\nid: 11111111-2222-3333-4444-555555555555\ncreated: 2026-08-01\nlast: 2026-08-01\n---\ndone",
      "legacy <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const provider: StableIdBackfillProvider = {
      getMdIdByContent: async () => null,
      setMdIdByContent: async () => 1,
    };
    store.setStableIdBackfillProvider(provider);

    const r = await store.backfillStableIds();
    expect(r.upgraded).toBe(1);
  });

  test("resume-safe across the .md<->DB seam: reuses an existing DB md_id instead of double-assigning", async () => {
    const store = makeStore();
    (store as any).memoryEntries = [
      "orphan note <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const existing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const provider: StableIdBackfillProvider = {
      getMdIdByContent: async () => existing, // DB row already has an md_id
      setMdIdByContent: async () => 0,        // should NOT be called to overwrite
    };
    store.setStableIdBackfillProvider(provider);

    const r = await store.backfillStableIds();
    expect(r.upgraded).toBe(1);
    expect(r.mdIdsMirrored).toBe(0); // reused existing id -> no new mirror write
    const id = ((store as any).memoryEntries[0] as string).match(/^id: (.+)$/m)![1];
    expect(id).toBe(existing); // reused, not minted
  });

  test("no provider injected -> best-effort no-op (never throws)", async () => {
    const store = makeStore();
    (store as any).memoryEntries = [
      "note <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    // No setStableIdBackfillProvider call — should not throw; upgrades still happen.
    const r = await store.backfillStableIds();
    expect(r.upgraded).toBe(1);
    expect(r.mdIdsMirrored).toBe(0);
  });

  test("provider.setMdIdByContent throwing is swallowed (best-effort, never throws)", async () => {
    const store = makeStore();
    (store as any).memoryEntries = [
      "note <!-- created=2026-08-01, last=2026-08-01 -->",
    ];
    const provider: StableIdBackfillProvider = {
      getMdIdByContent: async () => null,
      setMdIdByContent: async () => { throw new Error("db down"); },
    };
    store.setStableIdBackfillProvider(provider);

    const r = await store.backfillStableIds();
    expect(r.upgraded).toBe(1);     // .md still upgraded
    expect(r.mdIdsMirrored).toBe(0); // mirror failed (swallowed)
  });
});
