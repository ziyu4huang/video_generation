import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMap, writeMap } from "../src/map.js";
import { parseMapBody } from "../src/markdown.js";
import {
  computeFrontier,
  parseDecisionLine,
  parseTicketFile,
  serializeTicket,
  type Ticket,
  type WayfindMap,
} from "../src/model.js";

describe("parseMapBody", () => {
  it("splits a ##-delimited body into named sections", () => {
    const md = ["# Map", "", "## Destination", "", "reach the spec", "", "## Notes", "", "domain foo", ""].join("\n");
    const s = parseMapBody(md);
    expect(s.Destination).toBe("reach the spec");
    expect(s.Notes).toBe("domain foo");
  });
});

describe("parseMapBody: lenient section keys (suffix tolerance)", () => {
  it("keys a section by the text before a ( / em-dash / colon suffix", () => {
    const md = [
      "## Resolution (closed 2026-07-25 — BUILD)",
      "",
      "decided to build",
      "",
      "## Section — with a desc",
      "",
      "section body",
      "",
      "## Notes: a colon note",
      "",
      "notes body",
      "",
    ].join("\n");
    const s = parseMapBody(md);
    expect(s.Resolution).toBe("decided to build");
    expect(s.Section).toBe("section body");
    expect(s.Notes).toBe("notes body");
  });

  it("preserves the full key for plain (unsuffixed) headers — back-compat", () => {
    const md = [
      "## What to build",
      "",
      "wb",
      "",
      "## Decisions so far",
      "",
      "d",
      "",
      "## Not yet specified",
      "",
      "n",
    ].join("\n");
    const s = parseMapBody(md);
    expect(s["What to build"]).toBe("wb");
    expect(s["Decisions so far"]).toBe("d");
    expect(s["Not yet specified"]).toBe("n");
  });

  it("treats a parenthetical-suffixed Resolution as closed (the ceremony footgun)", () => {
    const content = [
      "## Question",
      "",
      "What to do?",
      "",
      "## Resolution (closed 2026-07-25 — BUILD)",
      "",
      "Decided: build it.",
    ].join("\n");
    const t = parseTicketFile(content, "01", "do-thing");
    expect(t.status).toBe("closed");
    expect(t.resolution).toBe("Decided: build it.");
  });
});

describe("parseDecisionLine", () => {
  it("parses - [title](link) — gist", () => {
    const d = parseDecisionLine("- [Pick storage](tickets/01-pick-storage.md) — Postgres over SQLite");
    expect(d).toEqual({
      title: "Pick storage",
      link: "tickets/01-pick-storage.md",
      gist: "Postgres over SQLite",
    });
  });
  it("returns null for non-decision lines", () => {
    expect(parseDecisionLine("<!-- none yet -->")).toBeNull();
    expect(parseDecisionLine("- just a bullet")).toBeNull();
  });
});

describe("parseTicketFile + serializeTicket round-trip", () => {
  const file = [
    "---",
    "type: grilling",
    "blocking: 01, 02",
    "status: open",
    "---",
    "",
    "# Pick storage",
    "",
    "## Question",
    "",
    "What database do we use?",
    "",
  ].join("\n");

  it("parses frontmatter + question", () => {
    const t = parseTicketFile(file, "03", "pick-storage");
    expect(t.id).toBe("03");
    expect(t.slug).toBe("pick-storage");
    expect(t.title).toBe("Pick storage");
    expect(t.type).toBe("grilling");
    expect(t.blocking).toEqual(["01", "02"]);
    expect(t.status).toBe("open");
    expect(t.question).toBe("What database do we use?");
  });

  it("a resolution block marks the ticket closed", () => {
    const closed = [
      "---",
      "status: open",
      "---",
      "",
      "# Pick storage",
      "",
      "## Question",
      "",
      "What db?",
      "",
      "## Resolution",
      "",
      "Postgres.",
    ].join("\n");
    const t = parseTicketFile(closed, "01", "pick-storage");
    expect(t.status).toBe("closed");
    expect(t.resolution).toBe("Postgres.");
  });

  it("serialize → parse round-trips the essential fields", () => {
    const t: Ticket = {
      id: "02",
      slug: "api-shape",
      title: "API shape",
      question: "REST or GraphQL?",
      type: "grilling",
      blocking: ["01"],
      status: "open",
    };
    const reparsed = parseTicketFile(serializeTicket(t), "02", "api-shape");
    expect(reparsed.title).toBe("API shape");
    expect(reparsed.type).toBe("grilling");
    expect(reparsed.blocking).toEqual(["01"]);
    expect(reparsed.question).toBe("REST or GraphQL?");
    expect(reparsed.status).toBe("open");
  });
});

describe("parseTicketFile: unified body schema (to-tickets fields folded in)", () => {
  const file = [
    "---",
    "type: task",
    "blocking: 01, 02",
    "status: open",
    "---",
    "",
    "# Wire the storage layer",
    "",
    "## Question",
    "",
    "Which DB driver?",
    "",
    "## What to build",
    "",
    "A vertical slice from schema migration to the /health read endpoint, demoable on its own.",
    "",
    "## Acceptance",
    "",
    "- [ ] migration runs green",
    "- [ ] GET /health returns 200",
    "- [x] README updated",
  ].join("\n");

  it("parses What to build + Acceptance body sections alongside frontmatter", () => {
    const t = parseTicketFile(file, "03", "wire-storage");
    expect(t.type).toBe("task");
    expect(t.blocking).toEqual(["01", "02"]);
    expect(t.status).toBe("open");
    expect(t.title).toBe("Wire the storage layer");
    expect(t.question).toBe("Which DB driver?");
    expect(t.whatToBuild).toBe(
      "A vertical slice from schema migration to the /health read endpoint, demoable on its own.",
    );
    expect(t.acceptance).toEqual(["migration runs green", "GET /health returns 200", "README updated"]);
  });

  it("whatToBuild/acceptance are undefined when the sections are absent (back-compat)", () => {
    const minimal = ["---", "type: grilling", "status: open", "---", "", "# Q", "", "## Question", "", "Why?"].join(
      "\n",
    );
    const t = parseTicketFile(minimal, "01", "q");
    expect(t.whatToBuild).toBeUndefined();
    expect(t.acceptance).toBeUndefined();
  });

  it("serialize → parse round-trips whatToBuild + acceptance", () => {
    const t: Ticket = {
      id: "04",
      slug: "slice",
      title: "Slice",
      question: "?",
      type: "task",
      blocking: [],
      status: "open",
      whatToBuild: "End-to-end behaviour X.",
      acceptance: ["criterion 1", "criterion 2"],
    };
    const reparsed = parseTicketFile(serializeTicket(t), "04", "slice");
    expect(reparsed.whatToBuild).toBe("End-to-end behaviour X.");
    expect(reparsed.acceptance).toEqual(["criterion 1", "criterion 2"]);
  });
});

// Failure memory #471 — `blocked by:` / `blocking:` format validation.
//
// The parser used to silently coerce ANY value into a `blocking[]` (stripping
// outer brackets, splitting on commas/spaces) — so a bracketed slug like
// `blocking: ["01-foo"]` or a bare `blocking: abc` parsed to `blocking: ["01-foo"]`
// / `["abc"]` and the malformed edge quietly vanished (computeFrontier never
// matches a closed id, so the dependency graph was silently broken). These
// tests pin the hardened behaviour: bare numbers (the good format, including
// the bracketed+quoted `blocking: ["01", "02"]` form) parse cleanly, while a
// non-numeric entry is surfaced as a thrown parse error — never silent.
describe("parseTicketFile: blocking format validation (failure memory #471)", () => {
  const ticket = (blockingLine: string): string =>
    ["---", "type: task", blockingLine, "status: open", "---", "", "# T", "", "## Question", "", "q?"].join("\n");

  it("accepts the bare-number form (blocking: 01, 02)", () => {
    const t = parseTicketFile(ticket("blocking: 01, 02"), "03", "t");
    expect(t.blocking).toEqual(["01", "02"]);
    expect(t.status).toBe("open");
  });

  it('accepts the bracketed+quoted bare-number form (blocking: ["01", "02"])', () => {
    const t = parseTicketFile(ticket('blocking: ["01", "02"]'), "03", "t");
    expect(t.blocking).toEqual(["01", "02"]);
    // quotes must be stripped, or the edge silently never matches a closed id
  });

  it('rejects a bracketed slug entry (blocking: ["01-foo"]) — surfaced, not silent', () => {
    expect(() => parseTicketFile(ticket('blocking: ["01-foo"]'), "03", "t")).toThrow(/blocking/i);
  });

  it("rejects a bare non-numeric value (blocking: abc) — surfaced, not silent", () => {
    expect(() => parseTicketFile(ticket("blocking: abc"), "03", "t")).toThrow(/blocking/i);
  });

  it("accepts the `blocked by:` / `blocked_by:` alias keys too", () => {
    expect(parseTicketFile(ticket("blocked_by: 01"), "03", "t").blocking).toEqual(["01"]);
    expect(parseTicketFile(ticket("blocked by: 01"), "03", "t").blocking).toEqual(["01"]);
  });
});

describe("computeFrontier", () => {
  const mk = (id: string, opts: Partial<Pick<Ticket, "blocking" | "status" | "claimed">> = {}): Ticket => ({
    id,
    slug: `t${id}`,
    title: `T${id}`,
    question: "?",
    type: "grilling",
    blocking: opts.blocking ?? [],
    status: opts.status ?? "open",
    claimed: opts.claimed,
  });

  it("returns open + unblocked + unclaimed tickets, ascending by id", () => {
    const tickets = [
      mk("01"),
      mk("02", { blocking: ["01"] }), // blocked by open 01 → not on frontier
      mk("03", { blocking: ["99"] }), // blocker doesn't exist but is not closed → blocked
      mk("04", { claimed: "agent-1" }), // claimed → not on frontier
      mk("05", { blocking: ["01"], status: "closed" }), // closed → off frontier
    ];
    const frontier = computeFrontier(tickets);
    expect(frontier.map((t) => t.id)).toEqual(["01"]);
  });

  it("unblocks dependents when their blockers close", () => {
    const tickets = [
      mk("01", { status: "closed" }),
      mk("02", { blocking: ["01"] }), // 01 now closed → unblocked
      mk("03", { blocking: ["02"] }), // 02 still open → blocked
    ];
    expect(computeFrontier(tickets).map((t) => t.id)).toEqual(["02"]);
  });

  it("returns empty when every open ticket is blocked or claimed", () => {
    const tickets = [mk("01", { claimed: "x" }), mk("02", { blocking: ["01"] })];
    expect(computeFrontier(tickets)).toEqual([]);
  });
});

describe("to-tickets skill template parses correctly (skill-prose ↔ parser regression)", () => {
  // The <local-ticket-template> in skills/to-tickets/SKILL.md MUST parse through
  // parseTicketFile with its declared type + blocking edges intact. Earlier the
  // template put the H1 BEFORE the frontmatter fence, so parseTicketFile (which
  // anchors frontmatter at ^---) silently dropped type→"grilling" + blocking→[]
  // for every ticket authored from the skill — the dependency graph vanished.
  const skillMd = readFileSync(new URL("../skills/to-tickets/SKILL.md", import.meta.url), "utf-8");
  const m = skillMd.match(/<local-ticket-template>\s*([\s\S]*?)<\/local-ticket-template>/);
  if (!m) throw new Error("no <local-ticket-template> block in skills/to-tickets/SKILL.md");
  const template = m[1].trim();

  it("the skill's verbatim template parses with its declared type + blocking edges", () => {
    const t = parseTicketFile(template, "01", "from-skill-template");
    expect(t.type).toBe("task");
    expect(t.blocking).toEqual(["02", "05"]);
    expect(t.status).toBe("open");
  });
});

describe("readMap / writeMap: empty-fog placeholder must not count as a real fog item", () => {
  // Ticket 02: when fog is empty, writeMap emits the `<!-- none -->` marker
  // so the section isn't blank for human readers. readMap must NOT count that
  // comment as a real fog bullet — every fresh effort would otherwise report
  // `fog 1` instead of `fog 0`. The identical bug also affects outOfScope
  // (same `<!-- none -->` placeholder, same read pattern), so it's covered too.
  const fresh = () => mkdtempSync(join(tmpdir(), "wf-map-fog-"));

  const base = (effort: string, fog: string[], outOfScope: string[]): WayfindMap => ({
    effort,
    destination: "ship it",
    notes: "",
    decisions: [],
    fog,
    outOfScope,
    tickets: [],
  });

  it("empty fog round-trips to count 0 (the <!-- none --> placeholder is ignored)", () => {
    const cwd = fresh();
    writeMap(cwd, base("empty-fog", [], []));
    // sanity: the placeholder really is on disk (proves we hit the bug path)
    const onDisk = readFileSync(join(cwd, ".planning", "empty-fog", "map.md"), "utf-8");
    expect(onDisk).toContain("<!-- none -->");
    const back = readMap(cwd, "empty-fog");
    expect(back).not.toBeNull();
    expect(back?.fog).toEqual([]); // not ["<!-- none -->"]
    expect(back?.fog.length).toBe(0);
    expect(back?.outOfScope).toEqual([]); // same placeholder, same fix
    expect(back?.outOfScope.length).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("a real fog bullet still counts as 1 (guard against over-stripping)", () => {
    const cwd = fresh();
    writeMap(cwd, base("real-fog", ["open: define the failure budget"], ["a durability bridge"]));
    const back = readMap(cwd, "real-fog");
    expect(back).not.toBeNull();
    expect(back?.fog).toEqual(["open: define the failure budget"]);
    expect(back?.fog.length).toBe(1);
    expect(back?.outOfScope).toEqual(["a durability bridge"]);
    expect(back?.outOfScope.length).toBe(1);
    rmSync(cwd, { recursive: true, force: true });
  });
});
