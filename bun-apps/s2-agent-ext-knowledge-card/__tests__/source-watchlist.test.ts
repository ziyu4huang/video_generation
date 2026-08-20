/**
 * Source watch-list loader tests.
 *
 * The watch-list is what makes coverage actionable against silent failure: one
 * command checks every configured source family without the operator having to
 * remember the inputs (the original 83%-unconverged failure mode). Three layers:
 * explicit override > .pi/kcard-coverage.json > conventional defaults.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWatchlist, DEFAULT_WATCHLIST, resolveSpecsToRecords, type SourceSpec } from "../src/source-watchlist.ts";

describe("loadWatchlist", () => {
  test("no config file → conventional defaults (zero-config for standard layouts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    try {
      const got = loadWatchlist(dir);
      expect(got).toEqual(DEFAULT_WATCHLIST);
      // defaults cover the three real source families
      const families = got.map((s) => s.family).sort();
      expect(families).toEqual(["auto-memory", "hermes", "workflow-jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads .pi/kcard-coverage.json and tilde-expands dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(
      join(dir, ".pi", "kcard-coverage.json"),
      JSON.stringify({ sources: [{ family: "hermes", dir: "~/pi-mem" }] }),
    );
    try {
      const got = loadWatchlist(dir);
      expect(got).toHaveLength(1);
      expect(got[0].family).toBe("hermes");
      expect(got[0].dir).toMatch(/pi-mem$/); // ~ expanded to the home dir
      expect(got[0].dir).not.toContain("~");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit override replaces the watch-list entirely", () => {
    const override: SourceSpec[] = [
      { family: "workflow-jsonl", dir: "custom-output" },
      { family: "generic", files: ["a.md", "b.md"] },
    ];
    // override wins even when a config file exists
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "kcard-coverage.json"), JSON.stringify({ sources: [] }));
    try {
      expect(loadWatchlist(dir, override)).toEqual(override);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed config falls through to defaults (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "kcard-coverage.json"), "{ not valid json");
    try {
      expect(loadWatchlist(dir)).toEqual(DEFAULT_WATCHLIST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("config with empty sources array falls through to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-"));
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "kcard-coverage.json"), JSON.stringify({ sources: [] }));
    try {
      expect(loadWatchlist(dir)).toEqual(DEFAULT_WATCHLIST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSpecsToRecords", () => {
  test("a workflow-jsonl DIR is swept with the right extension (.knowledge.jsonl, not .md)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rs-"));
    const srcDir = mkdtempSync(join(tmpdir(), "rs-src-"));
    writeFileSync(
      join(srcDir, "s.knowledge.jsonl"),
      JSON.stringify({ id: "wf:a", type: "gotcha", title: "A", detail: "d", tags: ["x"] }) + "\n" +
        JSON.stringify({ id: "wf:b", type: "gotcha", title: "B", detail: "d", tags: ["x"] }) + "\n",
    );
    try {
      const resolved = await resolveSpecsToRecords([{ family: "workflow-jsonl", dir: srcDir }], cwd);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].family).toBe("workflow-jsonl");
      expect(resolved[0].records.map((r) => r.id).sort()).toEqual(["wf:a", "wf:b"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  test("a missing dir is skipped, never thrown", async () => {
    const resolved = await resolveSpecsToRecords(
      [{ family: "hermes", dir: "/nonexistent/path/xyz" }],
      "/tmp",
    );
    expect(resolved).toEqual([]);
  });
});
