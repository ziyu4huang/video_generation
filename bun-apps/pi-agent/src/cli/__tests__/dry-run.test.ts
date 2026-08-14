/**
 * --dry-run globalization tests.
 *
 * `--dry-run` is a globally-parsed flag (dryRun field in ParsedArgs). It has
 * TWO halves, and the enforcement one is not the obvious one:
 *
 *   1. `dryRunExclude()` narrows the tool allowlist. Since pi-obsidian collapsed
 *      its 18 `obsidian_*` tools into one action-dispatched facade, this half
 *      excludes names that are no longer registered tools — it is a no-op on its
 *      own. Kept because it stays correct if the facade is ever unbundled.
 *   2. `applyDryRunEnv()` sets `OB_DRY_RUN=1`, which makes the facade REFUSE
 *      every write action at dispatch. This is what actually suppresses writes.
 *
 * `applyDryRun()` does both and is what every session builder calls. The tests
 * below pin half 1's set arithmetic AND half 2's refusal, because for a while
 * only half 1 existed and `--dry-run` printed "vault writes suppressed" while
 * suppressing nothing.
 */
import { test, expect, describe } from "bun:test";
import { parsePiArgs } from "../args.ts";
import { applyDryRun, dryRunExclude, WRITE_TOOLS } from "../sessions/shared.ts";
import {
	OBSIDIAN_WRITE_ACTIONS,
	dryRunRefusal,
} from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";

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

  test("WRITE_TOOLS is derived from the extension, not restated", () => {
    // The drift this prevents: WRITE_TOOLS naming a set of actions the obsidian
    // facade no longer agrees with, so a "write" slips through as read-only.
    expect([...WRITE_TOOLS].sort()).toEqual(
      OBSIDIAN_WRITE_ACTIONS.map((a) => `obsidian_${a}`).sort(),
    );
  });
});

describe("dryRunRefusal — the half that actually enforces --dry-run", () => {
  const ON = { OB_DRY_RUN: "1" } as NodeJS.ProcessEnv;
  const OFF = {} as NodeJS.ProcessEnv;

  test("every write action is refused under OB_DRY_RUN=1", () => {
    for (const action of OBSIDIAN_WRITE_ACTIONS) {
      expect(dryRunRefusal(action, ON)).toContain("[dry-run] refused");
    }
  });

  test("read actions still pass through under OB_DRY_RUN=1", () => {
    for (const action of ["list", "read", "search", "semantic_search", "query", "open", "status"]) {
      expect(dryRunRefusal(action, ON)).toBeNull();
    }
  });

  test("without the env var nothing is refused", () => {
    for (const action of OBSIDIAN_WRITE_ACTIONS) {
      expect(dryRunRefusal(action, OFF)).toBeNull();
    }
  });
});

describe("applyDryRun — both halves fire from one call", () => {
  // Read through a function so TS's control-flow analysis doesn't narrow the
  // env slot to `undefined` after the `delete` below — it does not model
  // applyDryRun() writing back to process.env.
  const readEnv = (k: string): string | undefined => process.env[k];

  test("arms OB_DRY_RUN and returns the excludes", () => {
    const saved = process.env.OB_DRY_RUN;
    try {
      delete process.env.OB_DRY_RUN;
      const ex = applyDryRun({ dryRun: true });
      expect(readEnv("OB_DRY_RUN")).toBe("1");
      expect(ex).toContain("obsidian_distill");
    } finally {
      // Bun ignores `process.env.X = undefined` differently from Node — delete
      // rather than assign, or the string "undefined" leaks into later tests.
      if (saved === undefined) delete process.env.OB_DRY_RUN;
      else process.env.OB_DRY_RUN = saved;
    }
  });

  test("without --dry-run the env stays untouched", () => {
    const saved = process.env.OB_DRY_RUN;
    try {
      delete process.env.OB_DRY_RUN;
      applyDryRun({ dryRun: false, excludeTools: ["flux2"] });
      expect(readEnv("OB_DRY_RUN")).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.OB_DRY_RUN;
      else process.env.OB_DRY_RUN = saved;
    }
  });
});
