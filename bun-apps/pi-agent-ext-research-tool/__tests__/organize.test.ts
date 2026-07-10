import { test, expect } from "bun:test";
import { guessTags, injectFrontmatter } from "../lib/organize.ts";

test("guessTags: exact-match MOC", () => {
	const info = guessTags("MOC-LLM-Zettelkasten.md");
	expect(info?.tags).toContain("type/moc");
	expect(info?.tags).toContain("domain/llm");
});

test("guessTags: weekly-news buckets", () => {
	expect(guessTags("weekly-news/bilibili-llm-2026-07-11.md")?.tags).toContain("source/bilibili");
	expect(guessTags("weekly-news/youtube-llm-2026-07-11.md")?.tags).toContain("source/youtube");
	expect(guessTags("weekly-news/pi-packages-2026-07-11.md")?.tags).toContain("source/pi-dev");
	expect(guessTags("weekly-news/github-weekly-2026-07-11.md")?.tags).toContain("domain/github");
});

test("guessTags: content/ pi-* study", () => {
	expect(guessTags("content/pi-ecosystem-packages-study.md")?.tags).toContain("domain/pi");
});

test("guessTags: unknown path → null (orphan)", () => {
	expect(guessTags("random/foo.md")).toBeNull();
});

test("injectFrontmatter: adds frontmatter to bare note", () => {
	const out = injectFrontmatter("# Title\nbody", ["type/note", "domain/llm"], [], "2026-07-09");
	expect(out.startsWith("---")).toBe(true);
	expect(out).toContain("created: 2026-07-09");
	expect(out).toContain("- type/note");
	expect(out).toContain("# Title");
});

test("injectFrontmatter: merges into existing frontmatter without duplicating tags", () => {
	const existing = "---\ntitle: My Note\n---\nbody";
	const out = injectFrontmatter(existing, ["type/weekly"], ["alias1"], "2026-07-09");
	expect(out).toContain("title: My Note"); // preserved
	expect(out).toContain("- type/weekly"); // added
	expect(out).toContain("- alias1"); // added
	expect(out).toContain("created: 2026-07-09"); // added
});

test("injectFrontmatter: skips adding tags if already present", () => {
	const existing = "---\ntags:\n  - type/weekly\n---\nbody";
	const out = injectFrontmatter(existing, ["type/weekly"], [], "2026-07-09");
	// tags block should not be duplicated
	expect(out.match(/tags:/g)).toHaveLength(1);
});
