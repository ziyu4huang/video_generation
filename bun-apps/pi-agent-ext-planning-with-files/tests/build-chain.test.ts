import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the stitched BUILD CHAIN handoffs (self-improve iter-8):
 * brainstorming ↔ grill-me-with-docs ↔ writing-plans. These are cross-reference
 * CONTENT edits, invisible to skills.test.ts (which guards frontmatter only).
 * Without this gate the chain can silently regress. See
 * .planning/build-chain-stitch/docs/adr/0001-cross-ext-chain-test.md.
 *
 * Cross-extension: reads BOTH pi-agent-ext-planning-with-files/skills AND
 * pi-agent-ext-wayfind/skills (assumes the monorepo sibling layout).
 */
const pwfSkills = join(import.meta.dir, "..", "skills");
const wayfindSkills = join(import.meta.dir, "..", "..", "pi-agent-ext-wayfind", "skills");

function body(relSkill: string, root: string): string {
  const content = readFileSync(join(root, relSkill, "SKILL.md"), "utf8");
  return content.replace(/^---[\s\S]*?---/, "");
}

const brainstorming = body("brainstorming", pwfSkills);
const grillDocs = body("grill-me-with-docs", wayfindSkills);
const writingPlans = body("writing-plans", pwfSkills);

describe("build chain handoffs (stitched chain must not silently regress)", () => {
  it("brainstorming sanctions grill-me-with-docs as an intermediate (false 'only' gate gone)", () => {
    expect(brainstorming).toContain("grill-me-with-docs");
    expect(brainstorming).not.toContain("Do not call any other skill");
  });

  it("grill-me-with-docs chain box prepends brainstorm and ends at close", () => {
    expect(grillDocs).toContain("brainstorm");
    expect(grillDocs).toContain("close");
  });

  it("writing-plans is the canonical home — documents the full chain", () => {
    expect(writingPlans).toContain("The build chain");
    expect(writingPlans).toContain("grill-me-with-docs");
    expect(writingPlans).toContain("canonical");
    expect(writingPlans).toContain("close");
  });
});
