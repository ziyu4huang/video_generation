import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseArxivId,
	parseFeed,
	formatPaper,
	renderPaperSummary,
	safeId,
	safeFilePart,
	uniquePath,
	saveMarkdown,
	type Paper,
} from "../lib/arxiv.ts";

/* ----------------------------------------------------------------
 * parseArxivId
 * ---------------------------------------------------------------- */

test("parseArxivId: modern ID passes through", () => {
	expect(parseArxivId("2401.12345")).toBe("2401.12345");
	expect(parseArxivId("2401.12345v2")).toBe("2401.12345v2");
});

test("parseArxivId: old-style ID passes through", () => {
	expect(parseArxivId("hep-th/9901001")).toBe("hep-th/9901001");
});

test("parseArxivId: strips abs/pdf/html URLs on known hosts", () => {
	expect(parseArxivId("https://arxiv.org/abs/2401.12345")).toBe("2401.12345");
	expect(parseArxivId("https://arxiv.org/pdf/2401.12345v3")).toBe("2401.12345v3");
	expect(parseArxivId("https://arxiv.org/html/2401.12345")).toBe("2401.12345");
	expect(parseArxivId("https://ar5iv.org/abs/2401.12345")).toBe("2401.12345");
	expect(parseArxivId("https://arxiv2md.org/abs/2401.12345")).toBe("2401.12345");
});

test("parseArxivId: strips trailing .pdf", () => {
	expect(parseArxivId("https://arxiv.org/pdf/2401.12345.pdf")).toBe("2401.12345");
});

test("parseArxivId: trims whitespace and strips leading @", () => {
	expect(parseArxivId("  2401.12345  ")).toBe("2401.12345");
	expect(parseArxivId("@2401.12345")).toBe("2401.12345");
});

test("parseArxivId: throws on empty / invalid input", () => {
	expect(() => parseArxivId("")).toThrow("Empty arXiv ID");
	expect(() => parseArxivId("   ")).toThrow("Empty arXiv ID");
	expect(() => parseArxivId("not-an-id")).toThrow("Invalid arXiv ID");
	expect(() => parseArxivId("12345")).toThrow("Invalid arXiv ID");
});

/* ----------------------------------------------------------------
 * parseFeed
 * ---------------------------------------------------------------- */

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Paper  One  Title</title>
    <summary>An abstract about agents.</summary>
    <published>2024-01-10T00:00:00Z</published>
    <updated>2024-01-12T00:00:00Z</updated>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <link href="http://arxiv.org/pdf/2401.12345v1" type="application/pdf" />
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html" />
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG" />
    <category term="cs.LG" />
    <category term="cs.AI" />
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">10 pages</arxiv:comment>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.67890v1</id>
    <title>Solo Paper</title>
    <summary>Another abstract.</summary>
    <published>2024-02-01T00:00:00Z</published>
    <updated>2024-02-01T00:00:00Z</updated>
    <author><name>Carol</name></author>
    <link href="http://arxiv.org/pdf/2402.67890v1" type="application/pdf" />
    <link href="http://arxiv.org/abs/2402.67890v1" rel="alternate" type="text/html" />
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" />
    <category term="cs.CL" />
  </entry>
</feed>`;

test("parseFeed: reads totalResults count", () => {
	const { totalResults } = parseFeed(SAMPLE_FEED);
	expect(totalResults).toBe(2);
});

test("parseFeed: parses entry fields (id normalized, authors, categories, links)", () => {
	const { papers } = parseFeed(SAMPLE_FEED);
	expect(papers).toHaveLength(2);

	const first = papers[0]!;
	expect(first.id).toBe("2401.12345v1");
	expect(first.authors).toEqual(["Alice", "Bob"]);
	expect(first.primaryCategory).toBe("cs.LG");
	expect(first.categories).toEqual(["cs.LG", "cs.AI"]);
	expect(first.pdfUrl).toBe("http://arxiv.org/pdf/2401.12345v1");
	expect(first.absUrl).toBe("http://arxiv.org/abs/2401.12345v1");
	expect(first.comment).toBe("10 pages");
	expect(first.journalRef).toBeUndefined();
});

test("parseFeed: collapses whitespace in title + abstract", () => {
	const { papers } = parseFeed(SAMPLE_FEED);
	expect(papers[0]!.title).toBe("Paper One Title");
	expect(papers[1]!.abstract).toBe("Another abstract.");
});

test("parseFeed: single-author entry flattens to one-element array", () => {
	const { papers } = parseFeed(SAMPLE_FEED);
	expect(papers[1]!.authors).toEqual(["Carol"]);
});

test("parseFeed: throws on non-feed XML", () => {
	expect(() => parseFeed("{}")).toThrow("Invalid arXiv API response");
	expect(() => parseFeed("<notafeed></notafeed>")).toThrow("Invalid arXiv API response");
});

/* ----------------------------------------------------------------
 * formatPaper / renderPaperSummary
 * ---------------------------------------------------------------- */

const paper: Paper = {
	id: "2401.12345",
	title: "A Title",
	authors: ["Alice", "Bob"],
	abstract: "Abs.",
	published: "2024-01-10T00:00:00Z",
	updated: "2024-01-12T00:00:00Z",
	categories: ["cs.LG"],
	primaryCategory: "cs.LG",
	pdfUrl: "https://arxiv.org/pdf/2401.12345",
	absUrl: "https://arxiv.org/abs/2401.12345",
};

test("formatPaper: includes indexed prefix + key fields", () => {
	const out = formatPaper(paper, 0);
	expect(out.startsWith("[1] A Title")).toBe(true);
	expect(out).toContain("ID: 2401.12345");
	expect(out).toContain("Authors: Alice, Bob");
	expect(out).toContain("PDF: https://arxiv.org/pdf/2401.12345");
	expect(out).toContain("Abstract: Abs.");
});

test("formatPaper: no index omits the prefix", () => {
	expect(formatPaper(paper).startsWith("A Title")).toBe(true);
});

test("renderPaperSummary: title + id + date + authors", () => {
	expect(renderPaperSummary(paper)).toBe("A Title\n2401.12345 · 2024-01-10\nAlice, Bob");
});

/* ----------------------------------------------------------------
 * safeId / safeFilePart
 * ---------------------------------------------------------------- */

test("safeId: replaces non-fs-safe chars", () => {
	expect(safeId("2401.12345v1")).toBe("2401.12345v1");
	expect(safeId("hep-th/9901001")).toBe("hep-th_9901001");
});

test("safeFilePart: strips accents + punctuation, collapses spaces, caps length", () => {
	expect(safeFilePart("Héllo, World!", "fb")).toBe("Hello World");
	expect(safeFilePart("   ", "fallback")).toBe("fallback");
	const long = safeFilePart("x".repeat(200), "fb");
	expect(long.length).toBe(100);
});

/* ----------------------------------------------------------------
 * uniquePath / saveMarkdown (filesystem)
 * ---------------------------------------------------------------- */

test("uniquePath: returns path when target absent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "arxiv-test-"));
	const target = join(dir, "free.md");
	try {
		expect(await uniquePath(target)).toBe(target);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("uniquePath: appends -2 when target exists", async () => {
	const dir = await mkdtemp(join(tmpdir(), "arxiv-test-"));
	const target = join(dir, "dup.md");
	try {
		await Bun.write(target, "x");
		expect(await uniquePath(target)).toBe(join(dir, "dup-2.md"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("saveMarkdown: writes <safeId> - <title>.md with the body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "arxiv-test-"));
	try {
		const path = await saveMarkdown("2401.12345v1", "A Cool Paper", "# body", dir);
		expect(path).toBe(join(dir, "2401.12345v1 - A Cool Paper.md"));
		await expect(Bun.file(path).text()).resolves.toBe("# body");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("saveMarkdown: avoids clobbering an existing file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "arxiv-test-"));
	try {
		const first = await saveMarkdown("2401.12345", "Same Title", "v1", dir);
		const second = await saveMarkdown("2401.12345", "Same Title", "v2", dir);
		expect(second).not.toBe(first);
		expect(second.endsWith("-2.md")).toBe(true);
		await expect(Bun.file(second).text()).resolves.toBe("v2");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
