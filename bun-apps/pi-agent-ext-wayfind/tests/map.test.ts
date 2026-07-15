import { describe, expect, it } from "bun:test";
import {
  computeFrontier,
  parseDecisionLine,
  parseMapBody,
  parseTicketFile,
  serializeTicket,
  type Ticket,
} from "../src/map.js";

describe("parseMapBody", () => {
  it("splits a ##-delimited body into named sections", () => {
    const md = ["# Map", "", "## Destination", "", "reach the spec", "", "## Notes", "", "domain foo", ""].join("\n");
    const s = parseMapBody(md);
    expect(s.Destination).toBe("reach the spec");
    expect(s.Notes).toBe("domain foo");
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
