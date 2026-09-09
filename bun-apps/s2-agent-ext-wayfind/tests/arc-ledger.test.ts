/**
 * Arc-ledger guard — the machine check behind `.planning/arc-ledger.json`.
 *
 * Layer 1 (THE canary, permanent): the committed synthetic fixture
 * `tests/fixtures/arc-ledger-duplicate/` claims self-arc #7 twice with two
 * non-grandfathered entries; the guard must REJECT that tree in every future
 * CI run. Weakening the uniqueness rule re-reddens here — a guard never seen
 * red is a guard never seen work (self-arc-19 t01's two-commit red-bar
 * ritual: this assertion ran RED before the rule was trusted green; the red
 * run is receipted in .planning/2026-09-10-self-arc-19/evidence/).
 *
 * Layer 2: the REAL repo tree must validate clean — the bootstrap ledger
 * encodes all pre-ledger series dirs (duplicate numbers grandfathered with
 * notes naming their collision partners), so uniqueness bites only FORWARD.
 *
 * Cross-check: numbers ACTIVE on origin/main claimed at a different path in
 * this tree fail (the dual-arc-18 parallel-session class). When origin/main
 * or its ledger is unreachable the check skips LOUDLY (stderr note) — never
 * silently. Tests inject `opts.mainLedger` instead of shelling out.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_REL_PATH, loadLedger, validateLedger } from "../src/arc-ledger.js";

const FIXTURE = join(import.meta.dir, "fixtures", "arc-ledger-duplicate");
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const tempRoots: string[] = [];
function makeRoot(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-arc-ledger-"));
  tempRoots.push(cwd);
  return cwd;
}
afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/** Seed a series effort dir (map.md frontmatter effort/status must agree with the ledger entry). */
function seedEffort(root: string, slug: string, status: string): void {
  const dir = join(root, ".planning", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "map.md"),
    `---\neffort: ${slug}\ncreated: ${slug.slice(0, 10)}\nlast: ${slug.slice(0, 10)}\nstatus: ${status}\n---\n\n## Destination\n\nfixture.\n`,
    "utf-8",
  );
}

function seedLedger(root: string, entries: unknown[], adopted = "2026-09-01"): void {
  mkdirSync(join(root, ".planning"), { recursive: true });
  writeFileSync(
    join(root, LEDGER_REL_PATH),
    `${JSON.stringify({ version: 1, adopted, entries }, null, "\t")}\n`,
    "utf-8",
  );
}

const entry = (number: number, slug: string, extra: Record<string, unknown> = {}) => ({
  series: "self-arc",
  number,
  path: `.planning/${slug}`,
  status: "active",
  claimedAt: slug.slice(0, 10),
  ...extra,
});

describe("the canary: duplicate-claim fixture is REJECTED (permanent)", () => {
  it("rejects two non-grandfathered entries claiming the same (series, number)", () => {
    const v = validateLedger(FIXTURE, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("duplicate-number") && p.includes("#7"))).toBe(true);
    expect(v.problems.some((p) => p.includes("2026-09-01-self-arc-7") && p.includes("2026-09-02-self-arc-7"))).toBe(
      true,
    );
  });

  it("accepts the same pair when the OLD claim is grandfathered (grandfathering, not erasure)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-01-self-arc-7", "done");
    seedEffort(root, "2026-09-02-self-arc-7", "active");
    seedLedger(root, [
      entry(7, "2026-09-01-self-arc-7", { status: "done", grandfathered: true, note: "pre-ledger" }),
      entry(7, "2026-09-02-self-arc-7"),
    ]);
    const v = validateLedger(root, { mainLedger: null });
    expect(v.problems.filter((p) => p.includes("duplicate-number"))).toEqual([]);
  });
});

describe("the real tree validates clean", () => {
  it("bootstrap ledger covers every series dir; grandfathered pairs pass", () => {
    const v = validateLedger(REPO_ROOT);
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
  });
});

describe("schema / completeness / agreement", () => {
  it("rejects a ledger dir with no entry (untracked claim)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-01-self-arc-7", "active");
    seedEffort(root, "2026-09-02-self-arc-9", "active"); // no entry below
    seedLedger(root, [entry(7, "2026-09-01-self-arc-7")]);
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("completeness") && p.includes("2026-09-02-self-arc-9"))).toBe(true);
  });

  it("rejects an entry whose dir is missing", () => {
    const root = makeRoot();
    seedLedger(root, [entry(7, "2026-09-01-self-arc-7")]);
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("missing dir"))).toBe(true);
  });

  it("rejects a path/number mismatch", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-01-self-arc-7", "active");
    seedLedger(root, [entry(9, "2026-09-01-self-arc-7")]);
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("does not end with -9"))).toBe(true);
  });

  it("rejects frontmatter disagreement (effort or raw status)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-01-self-arc-7", "active");
    seedLedger(root, [entry(7, "2026-09-01-self-arc-7", { status: "done" })]); // map says active
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("agreement") && p.includes('"active" ≠ ledger "done"'))).toBe(true);
  });

  it("rejects a malformed ledger (bad version / not JSON / missing file)", () => {
    const root = makeRoot();
    expect(validateLedger(root, { mainLedger: null }).ok).toBe(false);
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(join(root, LEDGER_REL_PATH), "{not json", "utf-8");
    expect(validateLedger(root, { mainLedger: null }).ok).toBe(false);
    writeFileSync(
      join(root, LEDGER_REL_PATH),
      JSON.stringify({ version: 2, adopted: "2026-09-01", entries: [entry(7, "2026-09-01-self-arc-7")] }),
      "utf-8",
    );
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("unsupported ledger version"))).toBe(true);
  });

  it("loadLedger round-trips entries", () => {
    const loaded = loadLedger(REPO_ROOT);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const n19 = loaded.ledger.entries.find((e) => e.number === 19);
      expect(n19?.status).toBe("active");
      expect(n19?.branch).toBe("self-arc-19-loop-integrity");
    }
  });
});

describe("grandfather constraints", () => {
  it("rejects grandfathered:true on a NEW claim (claimedAt > adopted)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-05-self-arc-7", "active");
    seedLedger(root, [entry(7, "2026-09-05-self-arc-7", { grandfathered: true })], "2026-09-01");
    const v = validateLedger(root, { mainLedger: null });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("grandfather") && p.includes("> adopted"))).toBe(true);
  });
});

describe("origin/main cross-check (the parallel-session class)", () => {
  it("fails when a number ACTIVE on main is claimed at a different path here", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-05-self-arc-9", "active");
    seedLedger(root, [entry(9, "2026-09-05-self-arc-9")]);
    const mainLedger = JSON.stringify({
      version: 1,
      adopted: "2026-09-01",
      entries: [entry(9, "2026-09-03-self-arc-9", { status: "active" })],
    });
    const v = validateLedger(root, { mainLedger });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("cross-check") && p.includes("#9"))).toBe(true);
  });

  it("passes when the tree claim IS main's path (same effort continuing)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-05-self-arc-9", "active");
    seedLedger(root, [entry(9, "2026-09-05-self-arc-9")]);
    const mainLedger = JSON.stringify({
      version: 1,
      adopted: "2026-09-01",
      entries: [entry(9, "2026-09-05-self-arc-9")],
    });
    const v = validateLedger(root, { mainLedger });
    expect(v.ok).toBe(true);
  });

  it("skips LOUDLY when origin/main's ledger is unreachable (default probe, no git repo)", () => {
    const root = makeRoot();
    seedEffort(root, "2026-09-05-self-arc-9", "active");
    seedLedger(root, [entry(9, "2026-09-05-self-arc-9")]);
    const errSpy = spyOn(console, "error");
    try {
      const v = validateLedger(root); // default: probe git — tmp root is not a repo
      expect(v.ok).toBe(true);
      expect(v.crossCheckSkipped).toBe(true);
    } finally {
      const notes = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      errSpy.mockRestore();
      expect(notes).toContain("cross-check skipped");
    }
  });
});
