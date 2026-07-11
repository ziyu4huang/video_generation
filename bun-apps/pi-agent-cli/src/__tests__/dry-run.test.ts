/**
 * --dry-run globalization tests.
 *
 * `--dry-run` is a globally-parsed flag (dryRun field in ParsedArgs). The
 * mechanism: agent-driven write commands (zk-card, zk-extract, zk-ask,
 * url-to-vault, passthrough) get their write-capable obsidian tools EXCLUDED
 * via dryRunExclude() → createSharedSession(excludeTools). pdf-to-vault (direct
 * fs + orchestration) short-circuits at the top. zk-ingest honors it directly.
 *
 * These tests pin the deterministic contract: dry-run strips write tools but
 * leaves read tools; without dry-run the user's excludes pass through untouched.
 */
import { test, expect, describe } from "bun:test";
import { parsePiArgs } from "../args.ts";
import { dryRunExclude, WRITE_TOOLS } from "../sessions/shared.ts";

describe("parsePiArgs — global --dry-run", () => {
  test("--dry-run sets dryRun=true", () => {
    expect(parsePiArgs(["--dry-run"]).dryRun).toBe(true);
  });

  test("absent → dryRun undefined", () => {
    expect(parsePiArgs(["q"]).dryRun).toBeUndefined();
  });

  test("works as a global flag before a command", () => {
    expect(parsePiArgs(["--dry-run", "zk-card", "add", "x"]).dryRun).toBe(true);
  });
});

describe("dryRunExclude — deterministic write-tool suppression", () => {
  test("dry-run adds every write tool to excludes", () => {
    const ex = dryRunExclude({ dryRun: true }) ?? [];
    for (const w of WRITE_TOOLS) {
      expect(ex).toContain(w);
    }
  });

  test("dry-run preserves read-only tools list is NOT in excludes", () => {
    const ex = new Set(dryRunExclude({ dryRun: true }) ?? []);
    // read-only obsidian tools must remain available
    expect(ex.has("obsidian_read")).toBe(false);
    expect(ex.has("obsidian_search")).toBe(false);
    expect(ex.has("obsidian_query")).toBe(false);
    expect(ex.has("obsidian_list")).toBe(false);
  });

  test("no dry-run → user excludes pass through unchanged", () => {
    expect(dryRunExclude({ dryRun: false, excludeTools: ["flux2"] })).toEqual(["flux2"]);
  });

  test("no dry-run, no excludes → undefined (session default)", () => {
    expect(dryRunExclude({})).toBeUndefined();
  });

  test("dry-run + existing excludes → deduped union", () => {
    const ex = dryRunExclude({ dryRun: true, excludeTools: ["obsidian_create", "flux2"] }) ?? [];
    // no duplicate obsidian_create
    expect(ex.filter((t) => t === "obsidian_create")).toHaveLength(1);
    // user exclude preserved
    expect(ex).toContain("flux2");
  });
});
