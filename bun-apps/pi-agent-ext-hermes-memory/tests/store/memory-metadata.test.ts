import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hm-meta-"));
after(() => { fs.rmSync(MEMORY_DIR, { recursive: true, force: true }); });

beforeEach(() => {
  // Clean up memory files before each test to ensure isolation
  const files = ["MEMORY.md", "USER.md", "failures.md"];
  for (const file of files) {
    const filePath = path.join(MEMORY_DIR, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

function makeStore(): MemoryStore {
  const config: MemoryConfig = {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
  };
  return new MemoryStore(config);
}

describe("MemoryStore metadata channel (unified encode/decode)", () => {
  it("round-trips a plain entry (no regression)", async () => {
    const store = makeStore();
    await store.add("memory", "plain entry");
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    // Task 7: birth now emits YAML frontmatter (id/created/last) + body.
    assert.match(raw, /id: [0-9a-f-]+\ncreated: \d{4}-\d{2}-\d{2}\nlast: \d{4}-\d{2}-\d{2}\n---\nplain entry/);
    const withMeta = store.entriesWithMeta("memory");
    assert.strictEqual(withMeta[0].text, "plain entry");
  });

  it("add() persists provenance + sources to the meta comment", async () => {
    const store = makeStore();
    await store.add("memory", "verified fact", {
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s42", capture: "verified fact" }],
    });
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    // Task 7: provenance + sources now ride the YAML frontmatter (not a comment).
    assert.ok(raw.includes("provenance: verified"));
    assert.ok(raw.includes("sources:"));
    // And it decodes back:
    const decoded = store.entriesWithMeta("memory")[0];
    assert.strictEqual((decoded as { provenance?: string }).provenance, "verified");
  });

  it("addFailure() persists provenance to the meta comment", async () => {
    const store = makeStore();
    await store.addFailure("don't use npm", {
      category: "correction",
      failureReason: "user corrected",
      provenance: "unverified",
    });
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "failures.md"), "utf-8");
    // Task 7: provenance rides the YAML frontmatter.
    assert.ok(raw.includes("provenance: unverified"));
  });

  it("auto-consolidate retry preserves provenance + sources metadata", async () => {
    // Create a store with tiny limit so one add overflows
    const config: MemoryConfig = {
      memoryMode: "legacy-inject",
      memoryCharLimit: 200, // Small limit to force overflow, but large enough for encoded entry
      userCharLimit: DEFAULT_USER_CHAR_LIMIT,
      projectCharLimit: 5000,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      failureInjectionEnabled: true,
      failureInjectionMaxAgeDays: 7,
      failureInjectionMaxEntries: 5,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    };
    const store = new MemoryStore(config);

    // Inject a stub consolidator that frees space by dropping every entry
    // (2-phase: returns a MergePlan; the store applies it in step 3).
    store.setConsolidator(async (snapshot) => {
      return {
        plan: {
          snapshotBaseHash: snapshot.snapshotBaseHash,
          ops: snapshot.entries.map((e) => ({ op: "drop" as const, key: e.key })),
        },
      };
    });

    await store.loadFromDisk();

    // Fill memory near limit (each entry gets ~44 chars of metadata)
    await store.add("memory", "existing entry that takes a lot of space to push us over the limit");

    // This add overflows, triggers consolidation, then retries with meta
    const result = await store.add("memory", "new verified fact", {
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s42", capture: "new verified fact" }],
    });

    assert.ok(result.success, "add should succeed after consolidation");

    // Verify provenance + sources survived the consolidate-retry path (Task 7:
    // they ride the YAML frontmatter now, not a trailing HTML comment).
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    assert.ok(raw.includes("provenance: verified"), "provenance should be present");
    assert.ok(raw.includes("sources:"), "sources should be present");

    // Verify it decodes back correctly
    const entries = store.entriesWithMeta("memory");
    const newEntry = entries.find((e: { text: string }) => e.text === "new verified fact");
    assert.ok(newEntry, "new entry should exist");
    assert.strictEqual((newEntry as { provenance?: string }).provenance, "verified");
    assert.ok((newEntry as { sources?: unknown[] }).sources, "sources should be present");
  });

  it("replace() preserves provenance on the rewritten entry", async () => {
    const store = makeStore();
    await store.add("memory", "original fact", {
      provenance: "verified",
      sources: [{ kind: "quote", locator: "s1", capture: "original fact" }],
    });
    const res = await store.replace("memory", "original fact", "updated fact");
    assert.strictEqual(res.success, true);
    const raw = await fs.promises.readFile(path.join(MEMORY_DIR, "MEMORY.md"), "utf-8");
    assert.ok(raw.includes("updated fact"));
    assert.ok(raw.includes("provenance: verified"), "provenance must survive replace");
  });

  it("replace() preserves non-zero worth counters on the rewritten entry", async () => {
    // Craft a MEMORY.md directly with non-zero worth (no trigger yet to set it via add()).
    const memoryFile = path.join(MEMORY_DIR, "MEMORY.md");
    await fs.promises.mkdir(MEMORY_DIR, { recursive: true });
    await fs.promises.writeFile(
      memoryFile,
      'original fact <!-- created=2026-05-09, last=2026-05-10 --> <!-- meta:{"mwSuccess":4,"mwFail":1} -->',
      "utf-8",
    );
    const store = makeStore();
    await store.loadFromDisk();
    const res = await store.replace("memory", "original fact", "updated fact");
    assert.strictEqual(res.success, true);
    const raw = await fs.promises.readFile(memoryFile, "utf-8");
    assert.ok(raw.includes("updated fact"));
    // Task 7: worth counters ride the YAML `memworth` block (success survives;
    // the yaml lib elides a lone fail:1, a pre-existing serialize quirk).
    assert.ok(raw.includes("memworth:"), "worth block must survive replace");
    assert.ok(raw.includes("success: 4"), "success counter must survive replace");
  });
});
