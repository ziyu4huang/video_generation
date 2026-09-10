/**
 * extraction.test.ts — lane 1a on a REAL fixture conversion (GMSBench, the
 * smallest paper): convert with file2md `--extract text` (deterministic,
 * vision off) into a tmp outRoot, then measure the faithfulness proxies
 * against direct openPdf re-extraction. Thresholds per design §3: number
 * recall ≥ 0.98, span coverage ≥ 0.95, table-row survival ≥ 0.95.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPdf } from "@repo/s2-agent-ext-file2md/src/core/pdf-text.ts";
import { runFile2mdPipeline } from "@repo/s2-agent-ext-file2md/src/pipeline.ts";
import { measureExtraction } from "../src/lanes/extraction.ts";
import { repoRoot } from "../src/vault-sandbox.ts";

const ID = "2609.08871"; // GMSBench — 5 pages, deterministic

describe("lane 1a — extraction faithfulness (GMSBench fixture)", () => {
	const outRoot = mkdtempSync(join(tmpdir(), "bench-extract-"));

	test("number recall ≥ 0.98, span coverage ≥ 0.95, table-row survival ≥ 0.95", async () => {
		const pdfPath = join(repoRoot(), "bun-apps", "bench-kcards", "fixtures", "papers", `${ID}.pdf`);
		await runFile2mdPipeline({ inputs: [pdfPath], outRoot, mode: "text" });

		const converted = (
			await Array.fromAsync(new Bun.Glob("**/pages/page-*.md").scan({ cwd: outRoot, absolute: true }))
		).sort();
		expect(converted.length).toBe(5);
		const convertedText = (await Promise.all(converted.map((p) => Bun.file(p).text()))).join("\n");

		const bytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
		const pdf = await openPdf(bytes);
		const pages: string[] = [];
		for (let p = 1; p <= pdf.numPages; p++) pages.push(await pdf.getText(p));
		const reference = pages.join("\n\n");
		await pdf.destroy();

		const m = measureExtraction(reference, convertedText);
		expect(m.numbersReference).toBeGreaterThan(50);
		expect(m.numberRecall).toBeGreaterThanOrEqual(0.98);
		expect(m.spanCoverage).toBeGreaterThanOrEqual(0.95);
		expect(m.tableRowSurvival).toBeGreaterThanOrEqual(0.95);
	});
});
