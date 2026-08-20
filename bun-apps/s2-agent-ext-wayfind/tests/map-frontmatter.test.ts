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
import { readEffortMeta } from "../src/lifecycle.js";
import { appendDecision, closeTicket, readMap, touchEffortManifest, writeMap, writeTicket } from "../src/map.js";
import {
  type EffortMeta,
  type MapDecision,
  parseMapFrontmatter,
  serializeMapFrontmatter,
  today,
  validateEffortMap,
  type WayfindMap,
} from "../src/model.js";

const META_FULL: EffortMeta = {
  effort: "2026-08-02-core-task-review",
  created: "2026-08-02",
  last: "2026-08-02",
  status: "active",
  owner: "ziyu4huang",
};

const fresh = () => mkdtempSync(join(tmpdir(), "wf-map-fm-"));

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
    expect(back?.meta).toEqual<EffortMeta>({ ...META_FULL, last: today() });
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

  it("writeMap stamps last: (today) inline when meta is present", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "x",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "x", created: "2020-01-01", status: "active" }, // no last: supplied
    });
    const onDisk = readFileSync(join(cwd, ".planning", "x", "map.md"), "utf-8");
    expect(onDisk).toContain(`last: ${today()}`);
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

describe("readEffortMeta", () => {
  it("reads only the manifest (no ticket scan)", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "x",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "x", status: "active" },
    });
    expect(readEffortMeta(cwd, "x")).toEqual<EffortMeta>({
      effort: "x",
      last: today(),
      status: "active",
    });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null for a legacy (no front-matter) map", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    expect(readEffortMeta(cwd, "legacy")).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns null when there is no map", () => {
    const cwd = fresh();
    expect(readEffortMeta(cwd, "ghost")).toBeNull();
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("touchEffortManifest", () => {
  const todayStr = today;

  it("bumps last: on a manifest map and leaves the body verbatim", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "x",
      destination: "BODY LINE ONE",
      notes: "n",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
      meta: { effort: "x", created: "2020-01-01", status: "active" },
    });
    const path = join(cwd, ".planning", "x", "map.md");
    const before = readFileSync(path, "utf-8");
    const bodyBefore = before.split("---\n").pop();
    touchEffortManifest(cwd, "x");
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(`last: ${todayStr()}`);
    expect(after.split("---\n").pop()).toBe(bodyBefore); // body byte-for-byte unchanged
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op on a legacy (no front-matter) map", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    const path = join(cwd, ".planning", "legacy", "map.md");
    const before = readFileSync(path, "utf-8");
    touchEffortManifest(cwd, "legacy");
    expect(readFileSync(path, "utf-8")).toBe(before);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op when there is no map", () => {
    const cwd = fresh();
    expect(() => touchEffortManifest(cwd, "ghost")).not.toThrow();
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── wiring: ticket/decision mutations bump the manifest (layer 3, finding #1) ──
describe("touchEffortManifest — wired into writeTicket / closeTicket / appendDecision", () => {
  const todayStr = today;
  const STALE = "2020-01-01";

  /** Write a manifest map.md directly with a STALE `last:` date — bypasses
   *  writeMap (which stamps last: today) so a touch is observable: stale → today. */
  function writeManifestMapStale(cwd: string, effort: string): string {
    const dir = join(cwd, ".planning", effort);
    mkdirSync(join(dir, "tickets"), { recursive: true });
    const md = [
      "---",
      `effort: ${effort}`,
      "created: 2020-01-01",
      `last: ${STALE}`,
      "status: active",
      "---",
      "",
      `# Wayfinder map: ${effort}`,
      "",
      "## Destination",
      "",
      "ship it",
      "",
      "## Notes",
      "",
      "n",
      "",
      "## Decisions so far",
      "",
      "<!-- none yet -->",
      "",
      "## Not yet specified",
      "",
      "<!-- none -->",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n");
    writeFileSync(join(dir, "map.md"), md, "utf-8");
    return md;
  }

  it("writeTicket advances the manifest last: to today (body byte-unchanged)", () => {
    const cwd = fresh();
    writeManifestMapStale(cwd, "demo");
    const mapPath = join(cwd, ".planning", "demo", "map.md");
    const bodyBefore = readFileSync(mapPath, "utf-8").split("---\n").pop();
    expect(readEffortMeta(cwd, "demo")?.last).toBe(STALE); // pre-condition: stale

    writeTicket(cwd, "demo", {
      id: "01",
      slug: "pick",
      title: "Pick",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });

    expect(readEffortMeta(cwd, "demo")?.last).toBe(todayStr()); // advanced to today
    expect(readFileSync(mapPath, "utf-8").split("---\n").pop()).toBe(bodyBefore); // body untouched
    rmSync(cwd, { recursive: true, force: true });
  });

  it("closeTicket (delegates to writeTicket) advances the manifest last:", () => {
    const cwd = fresh();
    writeManifestMapStale(cwd, "demo");
    closeTicket(
      cwd,
      "demo",
      {
        id: "01",
        slug: "pick",
        title: "Pick",
        question: "q",
        type: "task",
        blocking: [],
        status: "open",
      },
      "resolved",
    );
    expect(readEffortMeta(cwd, "demo")?.last).toBe(todayStr());
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appendDecision advances the manifest last: to today (decision still appended)", () => {
    const cwd = fresh();
    writeManifestMapStale(cwd, "demo");
    const decision: MapDecision = { title: "Picked X", gist: "use X", link: "tickets/01-pick.md" };
    appendDecision(cwd, "demo", decision);
    expect(readEffortMeta(cwd, "demo")?.last).toBe(todayStr()); // advanced to today
    const onDisk = readFileSync(join(cwd, ".planning", "demo", "map.md"), "utf-8");
    expect(onDisk).toContain("- [Picked X](tickets/01-pick.md) — use X"); // decision still appended
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writeTicket on a LEGACY effort (no meta) adds no front-matter", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    const mapPath = join(cwd, ".planning", "legacy", "map.md");
    const before = readFileSync(mapPath, "utf-8");
    writeTicket(cwd, "legacy", {
      id: "01",
      slug: "pick",
      title: "Pick",
      question: "q",
      type: "task",
      blocking: [],
      status: "open",
    });
    expect(readEffortMeta(cwd, "legacy")).toBeNull(); // still no front-matter
    expect(readFileSync(mapPath, "utf-8")).toBe(before); // map.md byte-unchanged
    rmSync(cwd, { recursive: true, force: true });
  });

  it("appendDecision on a LEGACY effort (no meta) leaves no front-matter", () => {
    const cwd = fresh();
    writeMap(cwd, {
      effort: "legacy",
      destination: "d",
      notes: "",
      decisions: [],
      fog: [],
      outOfScope: [],
      tickets: [],
    });
    appendDecision(cwd, "legacy", { title: "Picked X", gist: "use X", link: "tickets/01-pick.md" });
    expect(readEffortMeta(cwd, "legacy")).toBeNull(); // still no front-matter
    rmSync(cwd, { recursive: true, force: true });
  });
});
