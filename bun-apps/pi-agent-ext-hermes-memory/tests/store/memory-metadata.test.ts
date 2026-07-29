import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hm-meta-"));
after(() => { fs.rmSync(MEMORY_DIR, { recursive: true, force: true }); });

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
    assert.match(raw, /plain entry <!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->/);
    const withMeta = store.entriesWithMeta("memory");
    assert.strictEqual(withMeta[0].text, "plain entry");
  });
});
