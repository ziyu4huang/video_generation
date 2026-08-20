/**
 * Staleness audit — stamping, decoding, and the audit report.
 *
 * Determinism: disk tests use a per-file tmpdir (mkdtemp under os.tmpdir()),
 * never the real ~/.pi/agent/memory/. Pure-logic tests use a mock store.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "bun:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
} from "../../src/constants.js";
import { formatStalenessAudit, daysSinceEdited } from "../../src/staleness.js";
import type { MemoryConfig } from "../../src/types.js";

const TEST_MARKER = "[STALENESS-TEST]";
let MEMORY_DIR = "";
let memoryPath = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
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
    ...overrides,
  };
}

async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Pure-logic tests ───

describe("staleness: daysSinceEdited", () => {
  it("counts whole days between today and an ISO date", () => {
    assert.ok(daysSinceEdited(today()) === 0, "today → 0 days");
  });

  it("returns ∞ for an unparseable date (treated as ancient)", () => {
    assert.equal(daysSinceEdited("not-a-date"), Number.POSITIVE_INFINITY);
    assert.equal(daysSinceEdited(""), Number.POSITIVE_INFINITY);
  });

  it("orders old dates as larger", () => {
    assert.ok(daysSinceEdited("2020-01-01") > 1000);
    assert.ok(daysSinceEdited("2020-01-01") > daysSinceEdited(today()));
  });
});

describe("staleness: formatStalenessAudit (mock store)", () => {
  const old = "2020-01-01";
  const mockStore = (data: Record<string, Array<{ text: string; created: string; lastReferenced: string }>>) => ({
    entriesWithMeta: (t: string) => data[t] ?? [],
  });

  it("flags only entries older than the threshold, oldest first", () => {
    const store = mockStore({
      memory: [
        { text: "fresh entry edited today", created: today(), lastReferenced: today() },
        { text: "stale entry from long ago", created: old, lastReferenced: old },
      ],
      user: [],
      failure: [{ text: "ancient failure", created: old, lastReferenced: old }],
    });

    const report = formatStalenessAudit(store, 30, null);

    // Summary counts: memory 2/1, failure 1/1, total 3/2
    assert.match(report, /memory\s+2 \/ 1 stale/);
    assert.match(report, /failure\s+1 \/ 1 stale/);
    assert.match(report, /total\s+3 \/ 2 stale/);

    // Stale section lists the two old entries, NOT the fresh one
    assert.match(report, /stale entry from long ago/);
    assert.match(report, /ancient failure/);
    const freshLine = report.split("\n").find((l) => l.includes("fresh entry edited today"));
    assert.equal(freshLine, undefined, "fresh entry must not appear in the report");

    // Oldest-first: ancient failure (200d+) sorts above the 100d-ish one — both are
    // >1000d here so just assert ordering by array position of their previews
    const ancientIdx = report.indexOf("ancient failure");
    const staleIdx = report.indexOf("stale entry from long ago");
    assert.ok(ancientIdx > -1 && staleIdx > -1);
  });

  it("reports 'no stale entries' when everything is within threshold", () => {
    const store = mockStore({
      memory: [{ text: "recent", created: today(), lastReferenced: today() }],
      user: [],
      failure: [],
    });
    const report = formatStalenessAudit(store, 30, null);
    assert.match(report, /No stale entries/);
  });

  it("scopes the header to the project name when given", () => {
    const report = formatStalenessAudit(mockStore({ memory: [], user: [], failure: [] }), 30, "my-proj");
    assert.match(report, /project: my-proj/);
  });
});

// ─── Disk-based tests: stamping + decoding ───

describe("staleness: stamping & decoding (MemoryStore)", { concurrency: 1 }, () => {
  beforeAll(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-staleness-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
  });

  afterAll(async () => {
    try {
      await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("add() stamps the ground-truth .md with YAML frontmatter (id/created/last)", async () => {
    await fs.rm(memoryPath, { force: true });
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();

    await store.add("memory", `${TEST_MARKER} stamped on add`);
    // (no settle sleep needed — add() awaits saveToDisk via runExclusive)

    const raw = await readRaw(memoryPath);
    // Task 7: births now emit YAML frontmatter (id/created/last) + body, not a
    // trailing HTML comment. Assert the frontmatter shape + today's date.
    assert.ok(raw.startsWith("---\n"), `expected frontmatter fence in:\n${raw}`);
    assert.ok(raw.includes("created: "), `expected 'created:' in:\n${raw}`);
    assert.ok(raw.includes("last: "), `expected 'last:' in:\n${raw}`);
    assert.ok(raw.includes(`created: ${today()}`), `expected today's date ${today()} in:\n${raw}`);
  });

  it("entriesWithMeta decodes created/lastReferenced and falls back for legacy entries", async () => {
    // Mix: one legacy entry (no comment) + one stamped entry
    const legacy = `${TEST_MARKER} legacy entry without metadata`;
    const stampedDate = "2024-06-15";
    const stamped = `${TEST_MARKER} stamped entry <!-- created=${stampedDate}, last=${stampedDate} -->`;
    await writeRaw(memoryPath, [legacy, stamped].join(ENTRY_DELIMITER) + "\n");

    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();

    const meta = store.entriesWithMeta("memory");
    assert.equal(meta.length, 2);

    const legacyEntry = meta.find((e) => e.text.includes("legacy entry"));
    assert.ok(legacyEntry, "legacy entry decoded");
    // Legacy entries fall back to today for both fields
    assert.equal(legacyEntry!.created, today());
    assert.equal(legacyEntry!.lastReferenced, today());

    const stampedEntry = meta.find((e) => e.text.includes("stamped entry"));
    assert.ok(stampedEntry, "stamped entry decoded");
    assert.equal(stampedEntry!.created, stampedDate);
    assert.equal(stampedEntry!.lastReferenced, stampedDate);
    assert.ok(!stampedEntry!.text.includes("<!--"), "metadata stripped from text");
  });
});
