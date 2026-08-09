/**
 * Effort-query Phase 1 — `list` action: `enumerateEfforts` + `listEfforts`.
 *
 * Real-fs harness (mkdtempSync sandbox — no mocks), matching the harness style
 * in tests/effort-tool.test.ts. Fixtures are written as raw on-disk markdown
 * in the EXACT format readMap / readEffortMeta / parseTicketFile expect
 * (front-matter with `effort:` so the manifest parses; `## Destination` /
 * `## Not yet specified` / `## Out of scope` sections; NN-slug.md tickets with
 * `type` / `status` / `claimed` / `blocking` front-matter).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateEfforts, listEfforts } from "../src/effort-query.js";

const fresh = () => mkdtempSync(join(tmpdir(), "wf-effort-query-"));
const planning = (cwd: string) => join(cwd, ".planning");

/** Seed a raw `map.md` under `.planning/<effort>/` (scaffolds the dir + tickets/). */
function seedMap(cwd: string, effort: string, body: string): void {
  const dir = join(planning(cwd), effort);
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(join(dir, "map.md"), body, "utf-8");
}

/** Seed a raw `NN-slug.md` ticket under `.planning/<effort>/tickets/`. */
function seedTicket(cwd: string, effort: string, file: string, body: string): void {
  const dir = join(planning(cwd), effort, "tickets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body, "utf-8");
}

/** Build the canonical two-effort sandbox: effA (3 tickets) + effB (1 ticket). */
function seedTwoEfforts(cwd: string): void {
  seedMap(
    cwd,
    "effA",
    [
      "---",
      "effort: effA",
      "status: active",
      "last: 2026-08-01",
      "---",
      "",
      "# Wayfinder map: effA",
      "",
      "## Destination",
      "",
      "effA goal line",
      "",
      "## Notes",
      "",
      "notes for effA",
      "",
      "## Decisions so far",
      "",
      "<!-- none yet -->",
      "",
      "## Not yet specified",
      "",
      "- fog one",
      "- fog two",
      "",
      "## Out of scope",
      "",
      "<!-- none -->",
      "",
    ].join("\n"),
  );
  // 01 — open, unclaimed, no blocker  (frontier)
  seedTicket(
    cwd,
    "effA",
    "01-first-decision.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# 01 — First decision",
      "",
      "## Question",
      "",
      "What storage do we pick first?",
      "",
    ].join("\n"),
  );
  // 02 — closed (resolution forces status closed)
  seedTicket(
    cwd,
    "effA",
    "02-storage-pick.md",
    [
      "---",
      "type: task",
      "status: closed",
      "---",
      "",
      "# 02 — Storage pick",
      "",
      "## Question",
      "",
      "Which storage?",
      "",
      "## Resolution",
      "",
      "We chose sqlite for now.",
      "",
    ].join("\n"),
  );
  // 03 — open, claimed, blocking 01  (NOT on frontier: claimed + has blocker)
  seedTicket(
    cwd,
    "effA",
    "03-wire-up.md",
    [
      "---",
      "type: task",
      "status: open",
      "claimed: alice",
      "blocking: 01",
      "---",
      "",
      "# 03 — Wire up",
      "",
      "## Question",
      "",
      "How do we wire the layers?",
      "",
    ].join("\n"),
  );

  seedMap(
    cwd,
    "effB",
    [
      "---",
      "effort: effB",
      "status: paused",
      "last: 2026-08-02",
      "---",
      "",
      "# Wayfinder map: effB",
      "",
      "## Destination",
      "",
      "effB goal",
      "",
      "## Notes",
      "",
      "notes effB",
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
    ].join("\n"),
  );
  // 01 — open, unclaimed, no blocker
  seedTicket(
    cwd,
    "effB",
    "01-effb-first.md",
    [
      "---",
      "type: task",
      "status: open",
      "---",
      "",
      "# 01 — EffB first",
      "",
      "## Question",
      "",
      "EffB first question?",
      "",
    ].join("\n"),
  );
}

// ─── enumerateEfforts ────────────────────────────────────────────────────────

describe("enumerateEfforts", () => {
  it("lists effort dirs sorted ascending; ignores dotfile dirs and regular files", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);
    // dotfile dir + a regular file inside .planning — both must be ignored
    mkdirSync(join(planning(cwd), ".hidden"), { recursive: true });
    writeFileSync(join(planning(cwd), "README.md"), "ignore me", "utf-8");

    expect(enumerateEfforts(cwd)).toEqual(["effA", "effB"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns [] when .planning does not exist (throw-free)", () => {
    const cwd = fresh();
    expect(enumerateEfforts(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns [] when .planning exists but is empty (throw-free)", () => {
    const cwd = fresh();
    mkdirSync(planning(cwd), { recursive: true });
    expect(enumerateEfforts(cwd)).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

// ─── listEfforts ─────────────────────────────────────────────────────────────

describe("listEfforts", () => {
  it("returns ok:true with slug-sorted per-effort summaries", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.efforts.length).toBe(2);
    expect(r.efforts.map((e) => e.slug)).toEqual(["effA", "effB"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("aggregates effA ticket counts + frontier + fog + status from the manifest", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    const effA = r.efforts.find((e) => e.slug === "effA");
    expect(effA).toBeDefined();

    // open: 01 + 03 ; closed: 02 ; claimed: 03 (open + claimed)
    expect(effA?.ticketCounts).toEqual({ open: 2, closed: 1, claimed: 1 });
    // frontier = open && !claimed && no blockers -> only 01
    expect(effA?.frontierSize).toBe(1);
    // seeded map has two fog bullets
    expect(effA?.fog).toBe(2);
    // status comes from the manifest front-matter
    expect(effA?.status).toBe("active");
    // destination round-trips from the map body
    expect(effA?.destination).toBe("effA goal line");
    // lastModified comes from the manifest `last:` field
    expect(effA?.lastModified).toBe("2026-08-01");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads effB status from the manifest (paused) and reports its counts", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);

    const r = listEfforts(cwd);
    const effB = r.efforts.find((e) => e.slug === "effB");
    expect(effB).toBeDefined();
    expect(effB?.status).toBe("paused");
    expect(effB?.ticketCounts).toEqual({ open: 1, closed: 0, claimed: 0 });
    expect(effB?.frontierSize).toBe(1);
    expect(effB?.fog).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns ok:true, efforts:[] on an empty .planning (throw-free)", () => {
    const cwd = fresh();
    // no .planning dir at all
    let r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.efforts).toEqual([]);

    // empty .planning dir present
    mkdirSync(planning(cwd), { recursive: true });
    r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    expect(r.efforts).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("skips a bad effort without failing the whole list (throw-free, one bad dir)", () => {
    const cwd = fresh();
    seedTwoEfforts(cwd);
    // A dir that is NOT a valid effort (no map.md, no front-matter) — readMap
    // returns null so it yields an empty summary, but must not throw and must
    // not drop the well-formed efforts.
    mkdirSync(join(planning(cwd), "effC", "tickets"), { recursive: true });

    const r = listEfforts(cwd);
    expect(r.ok).toBe(true);
    const slugs = r.efforts.map((e) => e.slug);
    expect(slugs).toContain("effA");
    expect(slugs).toContain("effB");
    expect(slugs).toContain("effC");
    const effC = r.efforts.find((e) => e.slug === "effC");
    expect(effC?.ticketCounts).toEqual({ open: 0, closed: 0, claimed: 0 });
    expect(effC?.frontierSize).toBe(0);
    expect(effC?.status).toBe("active"); // default when no manifest
    expect(effC?.destination).toBe("");
    rmSync(cwd, { recursive: true, force: true });
  });
});
