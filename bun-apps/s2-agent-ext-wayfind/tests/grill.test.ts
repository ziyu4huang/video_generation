import { describe, expect, it } from "bun:test";
import {
  appendSettledVocabulary,
  buildGrillPriming,
  buildPlanSeed,
  type GlossaryTerm,
  parseDecisions,
  parseGlossary,
} from "../src/grill.js";

describe("buildGrillPriming", () => {
  it("produces a with-docs priming that names both skills + the capture discipline", () => {
    const out = buildGrillPriming("auth redesign", true);
    expect(out).toContain("grill-me-with-docs");
    expect(out).toContain("auth redesign");
    expect(out).toContain("grilling");
    expect(out).toContain("domain-modeling");
    // capture discipline present only in the with-docs variant
    expect(out).toContain("CONTEXT.md");
    expect(out).toContain("ADR");
  });

  it("produces a plain grill priming (no docs) without the capture discipline", () => {
    const out = buildGrillPriming("pick a database", false);
    expect(out).toContain("grilling session");
    expect(out).toContain("pick a database");
    expect(out).toContain("ONE AT A TIME");
    expect(out).not.toContain("CONTEXT.md");
    expect(out).not.toContain("ADR");
  });

  it("falls back to a generic subject when no topic is given", () => {
    const out = buildGrillPriming(undefined, false);
    expect(out).toContain("current conversation");
  });
});

describe("buildPlanSeed", () => {
  it("returns null when there is nothing to seed", () => {
    expect(buildPlanSeed([], [])).toBeNull();
  });

  it("builds a full seed (one phase line per decision) when decisions are known", () => {
    const seed = buildPlanSeed(
      [
        { title: "Use Postgres", answer: "decided over SQLite for concurrency" },
        { title: "Event sourcing", answer: "yes, append-only orders" },
      ],
      [],
    );
    expect(seed).toBeTruthy();
    expect(seed).toContain("# Implementation Plan");
    expect(seed).toContain("Use Postgres");
    expect(seed).toContain("Event sourcing");
    expect(seed).not.toContain("**Status:**");
    // one Task block
    expect((seed?.match(/### Task/g) ?? []).length).toBe(1);
  });

  it("builds a skeleton seed from glossary + topic when decisions are not extractable", () => {
    const seed = buildPlanSeed([], [{ term: "Order", definition: "a request to purchase" }], "orders service");
    expect(seed).toBeTruthy();
    expect(seed).toContain("Settled vocabulary");
    expect(seed).toContain("**Order**: a request to purchase");
    expect(seed).toContain("orders service");
    expect(seed).toContain("synthesize the resolved decisions");
  });
});

describe("parseGlossary", () => {
  it("extracts **Term**: definition lines and skips headings + _Avoid_ lines", () => {
    const md = [
      "# Orders context",
      "",
      "## Language",
      "",
      "**Order**:",
      "A request to purchase.",
      "",
      "**Customer**: A person who places orders.",
      "_Avoid_: Client, buyer",
      "",
      "**Invoice**: A request for payment.",
    ].join("\n");
    const terms = parseGlossary(md);
    // bare "**Order**:" with no inline definition is skipped (def is on next line)
    const names = terms.map((t) => t.term);
    expect(names).toContain("Customer");
    expect(names).toContain("Invoice");
    expect(names).not.toContain("Order"); // no inline def
    expect(names).not.toContain("Avoid");
    expect(terms.find((t) => t.term === "Invoice")?.definition).toBe("A request for payment.");
  });

  it("returns [] for content with no bold-term lines", () => {
    expect(parseGlossary("# just a heading\n\nsome prose")).toEqual([]);
  });
});

describe("parseDecisions", () => {
  it("extracts - **title**: answer bullets from the ## Decisions section", () => {
    const md = [
      "# CONTEXT",
      "",
      "**GlossaryTerm**: a definition that lives outside any section",
      "",
      "## Decisions",
      "",
      "- **Use wayfinder format**: already ships a parser + lifecycle",
      "- **CONTEXT.md decisions section**: written inline as they resolve",
      "**NotBulleted**: should be ignored even inside the section",
      "",
      "## Notes",
      "",
      "some notes",
    ].join("\n");
    const decisions = parseDecisions(md);
    expect(decisions).toEqual([
      { title: "Use wayfinder format", answer: "already ships a parser + lifecycle" },
      { title: "CONTEXT.md decisions section", answer: "written inline as they resolve" },
    ]);
  });

  it("returns [] when there is no ## Decisions section", () => {
    const md = ["# CONTEXT", "", "**Term**: a glossary entry", "", "## Notes", "", "notes"].join("\n");
    expect(parseDecisions(md)).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseDecisions("")).toEqual([]);
  });
});

describe("appendSettledVocabulary", () => {
  it("is a no-op when glossary is empty", () => {
    const lines: string[] = ["x"];
    appendSettledVocabulary(lines, []);
    expect(lines).toEqual(["x"]);
  });

  it("pushes heading + each term (default heading)", () => {
    const lines: string[] = [];
    const g: GlossaryTerm[] = [
      { term: "Foo", definition: "a foo" },
      { term: "Bar", definition: "a bar" },
    ];
    appendSettledVocabulary(lines, g);
    expect(lines).toEqual(["## Settled vocabulary", "", "- **Foo**: a foo", "- **Bar**: a bar", ""]);
  });

  it("honours a custom heading (grill's (from CONTEXT.md) variant)", () => {
    const lines: string[] = [];
    appendSettledVocabulary(lines, [{ term: "X", definition: "y" }], "## Settled vocabulary (from CONTEXT.md)");
    expect(lines[0]).toBe("## Settled vocabulary (from CONTEXT.md)");
  });
});
