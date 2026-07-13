/**
 * retrieve.bench.test.ts — measures knowledge_query's underlying retrieve.ts
 * `retrieveRecords` on a temp vault with N seeded cards. Pure-CPU (no LLM,
 * no network). Reports p50/p95 and asserts a generous 50ms ceiling.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchLatency } from "../../../../perf-harness/src/index.ts";
import { retrieveRecords, type RetrieveOptions } from "../../../src/retrieve.ts";

let vault: string;
beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "kc-retrieve-bench-"));
  mkdirSync(join(vault, "Zettelkasten", "knowledge-graph"), { recursive: true });
  // Seed 20 cards with distinct tags
  for (let i = 0; i < 20; i++) {
    writeFileSync(
      join(vault, "Zettelkasten", "knowledge-graph", `card-${i}.md`),
      `---\nid: card-${i}\ntitle: "Card ${i}"\ntags: [tag-${i % 5}, bench]\n---\nBody ${i}.`,
    );
  }
});
afterAll(() => rmSync(vault, { recursive: true, force: true }));

describe("knowledge-card retrieve latency", () => {
  test("retrieveRecords(tags) p95 < 50ms", async () => {
    const opts: RetrieveOptions = { vaultPath: vault, tags: ["bench"] };
    const result = await benchLatency("retrieveRecords(tags=[bench])", () =>
      Promise.resolve(retrieveRecords(opts)),
    );
    console.log(`  retrieveRecords: p50=${result.p50.toFixed(3)}ms p95=${result.p95.toFixed(3)}ms`);
    expect(result.p95).toBeLessThan(50);
  });
});
