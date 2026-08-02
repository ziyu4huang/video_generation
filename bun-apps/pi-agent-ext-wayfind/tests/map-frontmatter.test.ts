/**
 * Layer-1 RED tests — front-matter manifest on map.md.
 *
 * Scope (the "A/B validation"): prove front-matter round-trips through
 * readMap/writeMap, stays backward-compatible with the ~377 legacy prose-only
 * efforts, and that validateEffortMap catches the original failure mode (a
 * hand-written map with non-canonical sections → empty Destination).
 *
 * Mirrors the ticket front-matter pattern already in map.ts:109.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EffortMeta,
  parseMapFrontmatter,
  readMap,
  serializeMapFrontmatter,
  validateEffortMap,
  type WayfindMap,
  writeMap,
} from "../src/map.js";

const META_FULL: EffortMeta = {
  effort: "2026-08-02-core-task-review",
  created: "2026-08-02",
  last: "2026-08-02",
  status: "active",
  owner: "ziyu4huang",
};

describe("parseMapFrontmatter", () => {
  it("extracts effort metadata from a leading front-matter block", () => {
    const md = [
      "---",
      "effort: 2026-08-02-core-task-review",
      "created: 2026-08-02",
      "last: 2026-08-02",
      "status: active",
      "owner: ziyu4huang",
      "---",
      "",
      "# Wayfinder map: 2026-08-02-core-task-review",
      "",
      "## Destination",
      "",
      "ship it",
    ].join("\n");
    const { meta, body } = parseMapFrontmatter(md);
    expect(meta).toEqual<EffortMeta>(META_FULL);
    expect(body.startsWith("# Wayfinder map")).toBe(true);
    // the metadata must NOT leak into the section body
    expect(body).not.toContain("owner:");
    expect(body).not.toContain("status: active");
  });

  it("returns null meta + the unchanged body when there is NO front-matter (backward-compat)", () => {
    const md = ["# Wayfinder map: legacy-effort", "", "## Destination", "", "old effort", ""].join("\n");
    const { meta, body } = parseMapFrontmatter(md);
    expect(meta).toBeNull();
    expect(body).toBe(md);
  });

  it("ignores an unknown status value (does not throw, leaves status unset)", () => {
    const md = ["---", "effort: x", "status: bogus", "---", "", "# Wayfinder map: x"].join("\n");
    const { meta } = parseMapFrontmatter(md);
    expect(meta?.effort).toBe("x");
    expect(meta?.status).toBeUndefined();
  });
});

describe("serializeMapFrontmatter", () => {
  it("emits a YAML block terminated by a blank line", () => {
    const out = serializeMapFrontmatter(META_FULL);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("---\n\n")).toBe(true);
    expect(out).toContain("effort: 2026-08-02-core-task-review");
    expect(out).toContain("status: active");
    expect(out).toContain("owner: ziyu4huang");
  });

  it("omits undefined optional fields (only `effort` is required)", () => {
    const out = serializeMapFrontmatter({ effort: "solo" });
    expect(out).toContain("effort: solo");
    expect(out).not.toContain("created:");
    expect(out).not.toContain("last:");
    expect(out).not.toContain("status:");
    expect(out).not.toContain("owner:");
  });

  it("round-trips: parseMapFrontmatter(serializeMapFrontmatter(meta) + body).meta === meta", () => {
    const reparsed = parseMapFrontmatter(`${serializeMapFrontmatter(META_FULL)}# Wayfinder map: x\n`).meta;
    expect(reparsed).toEqual(META_FULL);
  });
});

describe("readMap / writeMap: front-matter integration (fs round-trip)", () => {
  const fresh = () => mkdtempSync(join(tmpdir(), "wf-map-fm-"));

  it("writeMap emits front-matter when meta is present and readMap parses it back", () => {
    const cwd = fresh();
    const map: WayfindMap = {
      effort: META_FULL.effort,
      destination: "A prioritized findings doc → tickets.",
      notes: "method: parallel subagents",
      decisions: [],
      fog: ["open: implement-or-delete the yield"],
      outOfScope: ["a durability bridge"],
      tickets: [],
      meta: META_FULL,
    };
    writeMap(cwd, map);
    const onDisk = readFileSync(join(cwd, ".planning", META_FULL.effort, "map.md"), "utf-8");
    expect(onDisk.startsWith("---\n")).toBe(true); // front-matter is first
    const back = readMap(cwd, META_FULL.effort);
    expect(back).not.toBeNull();
    expect(back?.meta).toEqual(META_FULL);
    expect(back?.destination).toBe("A prioritized findings doc → tickets.");
    expect(back?.fog).toEqual(["open: implement-or-delete the yield"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writeMap omits front-matter when meta is absent (legacy-compatible output)", () => {
    const cwd = fresh();
    const map: WayfindMap = {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    };
    writeMap(cwd, map);
    const onDisk = readFileSync(join(cwd, ".planning", "legacy", "map.md"), "utf-8");
    expect(onDisk.startsWith("---\n")).toBe(false);
    expect(onDisk.startsWith("# Wayfinder map: legacy")).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("readMap on a legacy prose-only map (no front-matter) returns null meta + parsed sections", () => {
    const cwd = fresh();
    const dir = join(cwd, ".planning", "legacy", "tickets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(cwd, ".planning", "legacy", "map.md"),
      ["# Wayfinder map: legacy", "", "## Destination", "", "old effort", "", "## Notes", "", "n"].join("\n"),
      "utf-8",
    );
    const back = readMap(cwd, "legacy");
    expect(back).not.toBeNull();
    expect(back?.meta).toBeNull(); // backward-compat: no front-matter → null, not an error
    expect(back?.destination).toBe("old effort");
    expect(back?.notes).toBe("n");
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("validateEffortMap (conformance — catches the original hand-written failure)", () => {
  it("flags a map whose ## Destination is missing/empty (the original failure mode)", () => {
    // My earlier non-conforming map.md had ## Tickets / ## Dependency graph but NO ## Destination,
    // so readMap parsed destination="" silently. validateEffortMap must surface that.
    const bad: WayfindMap = {
      effort: "x",
      destination: "",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    };
    const v = validateEffortMap(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.toLowerCase().includes("destination"))).toBe(true);
  });

  it("flags a front-matter effort/status mismatch (meta.effort ≠ folder effort)", () => {
    const m: WayfindMap = {
      effort: "2026-08-02-real",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "2026-08-02-DIFFERENT", status: "active" },
    };
    const v = validateEffortMap(m, "2026-08-02-real");
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.toLowerCase().includes("effort"))).toBe(true);
  });

  it("passes a conforming map with matching front-matter", () => {
    const m: WayfindMap = {
      effort: "2026-08-02-core-task-review",
      destination: "ship it",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "2026-08-02-core-task-review", status: "active" },
    };
    expect(validateEffortMap(m, "2026-08-02-core-task-review").ok).toBe(true);
  });
});
