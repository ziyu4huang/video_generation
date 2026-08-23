import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertHandoffShape, newestNextGoalFiles, writeSessionHandoff } from "../src/handoff.js";
import { readMap, writeMap, writeTicket } from "../src/map.js";

let cwd = "";
afterEach(() => {
  if (cwd) {
    rmSync(cwd, { recursive: true, force: true });
    cwd = "";
  }
});

function makeCwd(): string {
  cwd = mkdtempSync(join(tmpdir(), "wayfind-handoff-"));
  return cwd;
}

type SeedTicket = {
  id: string;
  slug: string;
  status?: "open" | "closed";
  claimed?: string;
  blocking?: string[];
};

function seedEffort(root: string, tickets: SeedTicket[]): void {
  writeMap(root, {
    effort: "orders",
    destination: "ship the orders service",
    notes: "",
    decisions: [],
    fog: ["maybe a retry budget", "<!-- comment bullet, ignored -->"],
    outOfScope: [],
    tickets: [],
  });
  for (const t of tickets) {
    writeTicket(root, "orders", {
      id: t.id,
      slug: t.slug,
      title: `Ticket ${t.id}`,
      question: `${t.slug}?`,
      type: "task",
      blocking: t.blocking ?? [],
      ...(t.claimed ? { claimed: t.claimed } : {}),
      status: t.status ?? "open",
    });
  }
}

const NOW = new Date("2026-08-23T14:15:00");

describe("writeSessionHandoff", () => {
  it("refuses when no tickets are open (that is /wayfind done's job)", () => {
    const root = makeCwd();
    seedEffort(root, [{ id: "01", slug: "storage", status: "closed" }]);
    const r = writeSessionHandoff(
      root,
      "orders",
      readMap(root, "orders") as NonNullable<ReturnType<typeof readMap>>,
      NOW,
    );
    expect(r).toHaveProperty("refused");
    expect((r as { refused: string }).refused).toContain("/wayfind done");
  });

  it("writes a strict-v2 dash-stamped file carrying every open ticket and repoints LATEST", () => {
    const root = makeCwd();
    seedEffort(root, [
      { id: "01", slug: "storage", status: "closed" },
      { id: "02", slug: "retries" },
      { id: "03", slug: "billing", claimed: "sess-9", blocking: ["02"] },
    ]);
    // Pre-existing predecessor → supersedes must resolve to its absolute path.
    mkdirSync(join(root, "output"));
    writeFileSync(join(root, "output", "next-goal-20260822-090000.md"), "# old\n");
    symlinkSync("next-goal-20260822-090000.md", join(root, "output", "LATEST-next-goal.md"));

    const r = writeSessionHandoff(
      root,
      "orders",
      readMap(root, "orders") as NonNullable<ReturnType<typeof readMap>>,
      NOW,
    );
    if (!("path" in r)) throw new Error("expected a written handoff");
    expect(r.path).toBe("output/next-goal-20260823-141500.md");
    expect(r.openTickets).toEqual(["02", "03"]);
    expect(r.frontier).toEqual(["02"]); // 03 is blocked by 02
    expect(r.supersedes).toBe(join("output", "next-goal-20260822-090000.md"));

    const text = readFileSync(join(root, r.path), "utf-8");
    // frontmatter: exact keys, absolute self-path, created matches stamp, supersedes absolute
    expect(text).toMatch(
      /^---\nfile: .*\/output\/next-goal-20260823-141500\.md\ncreated: 2026-08-23 14:15:00\nsupersedes: .+\n---\n/,
    );
    // five exact headings in order
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      "Verified this session",
      "Honest gaps",
      "Immediate steps",
      "Done when",
      "Ranked next goals",
    ]);
    // open tickets carried into gaps + done-when; frontier named in steps
    expect(text).toContain("**02 Ticket 02**");
    expect(text).toContain("**03 Ticket 03** (task, claimed: sess-9)");
    expect(text).toContain('- [ ] ticket 02 "Ticket 02" closed');
    expect(text).toContain("- [ ] ticket 03");
    expect(text).toContain("(02)");
    // LATEST repointed at the new file (relative target)
    expect(readlinkSync(join(root, "output", "LATEST-next-goal.md"))).toBe("next-goal-20260823-141500.md");
    // passes our own shape gate
    expect(() => assertHandoffShape(text)).not.toThrow();
  });

  it("uses supersedes: none when no predecessor exists, and pads ranked list to 3 from fog", () => {
    const root = makeCwd();
    seedEffort(root, [{ id: "01", slug: "only" }]);
    const r = writeSessionHandoff(
      root,
      "orders",
      readMap(root, "orders") as NonNullable<ReturnType<typeof readMap>>,
      NOW,
    );
    if (!("path" in r)) throw new Error("expected a written handoff");
    const text = readFileSync(join(root, r.path), "utf-8");
    expect(text).toContain("supersedes: none\n");
    const rankedSection = text.split(/^## Ranked next goals$/m)[1] ?? "";
    const ranked = (rankedSection.match(/^\d+\. /gm) ?? []).length;
    expect(ranked).toBeGreaterThanOrEqual(3);
    expect(ranked).toBeLessThanOrEqual(5);
    expect(existsSync(join(root, "output", "LATEST-next-goal.md"))).toBe(true);
  });
});

describe("assertHandoffShape", () => {
  const good =
    "\n## Verified this session\n\nx\n\n## Honest gaps\n\n- a\n\n## Immediate steps\n\n1. a\n\n## Done when\n\n- [ ] a\n\n## Ranked next goals\n\n1. a\n2. b\n3. c\n";

  function doc(body: string): string {
    return [
      "---",
      "file: /x/output/next-goal-20260823-141500.md",
      "created: 2026-08-23 14:15:00",
      "supersedes: none",
      "---",
      "",
      "# Next goal — t",
      body,
    ].join("\n");
  }

  it("accepts a conforming document", () => {
    expect(() => assertHandoffShape(doc(good))).not.toThrow();
  });

  it("rejects wrong headings, missing checkboxes, and bad ranked counts", () => {
    expect(() => assertHandoffShape(doc(good.replace("## Honest gaps", "## Gaps")))).toThrow(/headings/);
    expect(() => assertHandoffShape(doc(good.replace("- [ ] a", "- [x] a")))).toThrow(/unchecked/);
    expect(() => assertHandoffShape(doc(good.replace("3. c", "")))).toThrow(/3-5/);
    expect(() => assertHandoffShape(doc(good).replace("supersedes: none\n", ""))).toThrow(/frontmatter/);
  });
});

describe("newestNextGoalFiles", () => {
  it("interleaves dash and underscore stamps chronologically", () => {
    const root = makeCwd();
    mkdirSync(join(root, "output"));
    for (const n of [
      "next-goal-20260821_100000.md",
      "next-goal-20260823-140000.md",
      "next-goal-20260822_235959.md",
      "not-a-goal.md",
    ]) {
      writeFileSync(join(root, "output", n), "x");
    }
    expect(newestNextGoalFiles(root)).toEqual([
      "next-goal-20260823-140000.md",
      "next-goal-20260822_235959.md",
      "next-goal-20260821_100000.md",
    ]);
    expect(existsSync(join(root, "output", "not-a-goal.md"))).toBe(true);
  });
});
