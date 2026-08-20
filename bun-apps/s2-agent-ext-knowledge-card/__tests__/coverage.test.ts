/**
 * Coverage engine faithful-gate tests.
 *
 * coverageReport() is a dry-run per-family id-diff: it reuses the REAL ingest
 * adapters' output (KnowledgeRecord[]) for the expected set E, and readCardMeta
 * (the same vault-read ingestRecords uses) for the vault set V. These tests pin
 * the three coverage outcomes (matched / missing / sourceOrphaned) and the
 * per-family isolation that prevents the pi-memory:↔hermes: cross-namespace
 * false-positive.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestRecords,
  coverageReport,
} from "../src/ingest.ts";
import type { KnowledgeRecord, CoverageSourceSpec } from "../src/types.ts";

function rec(over: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    id: "test:x",
    type: "gotcha",
    title: "T",
    detail: "Some detail about the gotcha.",
    tags: ["coverage"],
    dimension: "correctness",
    confidence: 0.8,
    status: "active",
    superseded_by: null,
    ...over,
  };
}

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "kc-cov-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("coverageReport — faithful per-family id-diff", () => {
  test("after a full ingest, nothing is missing or orphaned", async () => {
    const records = [rec({ id: "wf:a" }), rec({ id: "wf:b" })];
    await ingestRecords(records, {
      vaultPath: vault,
      source: "workflow-jsonl",
      sourceLabel: "workflow-jsonl:test",
    });
    const cov = await coverageReport({
      vaultPath: vault,
      sources: [{ family: "workflow-jsonl", records }],
    });
    expect(cov.missing).toEqual([]);
    expect(cov.sourceOrphaned).toEqual([]);
    expect(cov.matched).toBe(2);
    expect(cov.expected).toBe(2);
    expect(cov.vault).toBe(2);
    expect(cov.byFamily["workflow-jsonl"].matched).toBe(2);
  });

  test("a card whose source record was removed shows as sourceOrphaned", async () => {
    // Both wf:a and wf:b converged...
    await ingestRecords([rec({ id: "wf:a" }), rec({ id: "wf:b" })], {
      vaultPath: vault,
      source: "workflow-jsonl",
      sourceLabel: "workflow-jsonl:test",
    });
    // ...but the source now only has wf:a (wf:b's source record disappeared).
    const cov = await coverageReport({
      vaultPath: vault,
      sources: [{ family: "workflow-jsonl", records: [rec({ id: "wf:a" })] }],
    });
    expect(cov.sourceOrphaned).toContain("wf:b");
    expect(cov.missing).toEqual([]);
  });

  test("a source record that never converged shows as missing", async () => {
    // Empty vault, one expected record → it is missing.
    const cov = await coverageReport({
      vaultPath: vault,
      sources: [{ family: "workflow-jsonl", records: [rec({ id: "wf:gone" })] }],
    });
    expect(cov.missing).toEqual(["wf:gone"]);
    expect(cov.byFamily["workflow-jsonl"].missing).toEqual(["wf:gone"]);
    expect(cov.sourceOrphaned).toEqual([]);
  });

  test("per-family isolation: a hermes card is NOT flagged when only workflow-jsonl is checked", async () => {
    // A hermes card exists in the vault...
    await ingestRecords([rec({ id: "hermes:foo" })], {
      vaultPath: vault,
      source: "hermes",
      sourceLabel: "hermes:test",
    });
    // ...but we only check the workflow-jsonl family. The hermes card must NOT
    // be a cross-family false-positive (the pi-memory:↔hermes: namespace split
    // means id-diff is only meaningful WITHIN a family).
    const cov = await coverageReport({
      vaultPath: vault,
      sources: [{ family: "workflow-jsonl", records: [rec({ id: "wf:bar" })] }],
    });
    expect(cov.missing).toEqual(["wf:bar"]);
    expect(cov.sourceOrphaned).toEqual([]); // hermes:foo is in a different family — not orphaned w.r.t. workflow-jsonl
    expect(Object.keys(cov.byFamily)).toEqual(["workflow-jsonl"]);
  });

  test("multiple families are reported independently in byFamily", async () => {
    await ingestRecords([rec({ id: "wf:a" })], {
      vaultPath: vault,
      source: "workflow-jsonl",
      sourceLabel: "workflow-jsonl:test",
    });
    const cov = await coverageReport({
      vaultPath: vault,
      sources: [
        { family: "workflow-jsonl", records: [rec({ id: "wf:a" }), rec({ id: "wf:missing" })] },
        { family: "hermes", records: [rec({ id: "hermes:gone" })] },
      ],
    });
    expect(cov.byFamily["workflow-jsonl"].missing).toEqual(["wf:missing"]);
    expect(cov.byFamily["hermes"].missing).toEqual(["hermes:gone"]);
    expect(cov.missing).toEqual(["wf:missing", "hermes:gone"]);
    expect(cov.expected).toBe(3);
  });
});
