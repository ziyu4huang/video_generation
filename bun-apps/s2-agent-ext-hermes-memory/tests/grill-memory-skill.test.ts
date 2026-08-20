// tests/grill-memory-skill.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(import.meta.dir, "../skills/grill-memory/SKILL.md");
const raw = readFileSync(SKILL_PATH, "utf-8");
const fm = raw.match(/^---\n([\s\S]*?)\n---/);
const frontmatter = fm ? fm[1] : "";
const body = fm ? raw.slice(fm[0].length) : raw;

test("has YAML frontmatter with name + description", () => {
  expect(frontmatter).toContain("name: grill-memory");
  expect(frontmatter).toContain("description:");
});

test("description starts with 'Use when' (trigger-only, not a workflow summary)", () => {
  expect(frontmatter.match(/description:\s*(.*)/)?.[1]?.trimStart()).toMatch(/^Use when/);
});

test("READ protocol instructs memory_search against the user target (grill traits = user-traits)", () => {
  expect(body).toContain("memory_search");
  expect(body).toContain('target: "user"');
});

test("WRITE protocol instructs calling grill_decision per resolved decision", () => {
  expect(body).toContain("grill_decision");
});

test("preserves the one-recommendation-per-question discipline", () => {
  expect(body.toLowerCase()).toContain("one recommendation");
});
