import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergeKnowledgeEmission } from "../src/converge.ts";
import type { KnowledgeEmission } from "../src/emit.ts";
import type { KnowledgeRecord } from "../src/types.ts";


let vault: string;
let src: string;

beforeEach(() => {
	vault = mkdtempSync(join(tmpdir(), "kc-vault-"));
	src = mkdtempSync(join(tmpdir(), "kc-src-"));
});
afterEach(() => {
	rmSync(vault, { recursive: true, force: true });
	rmSync(src, { recursive: true, force: true });
});

const sampleRecord = (): KnowledgeRecord => ({
	id: "workflow:probe-1",
	type: "pattern",
	title: "Probe pattern",
	detail: "A deterministic convergence probe.",
	tags: ["probe"],
	dimension: null,
	confidence: 0.8,
	status: "active",
	superseded_by: null,
});

describe("convergeKnowledgeEmission — dir route (file2md path)", () => {
	test("ingests every .md in the dir, idempotent on re-emit", async () => {
		writeFileSync(join(src, "page-1.md"), "# Page One\n\nbody text.\n");
		writeFileSync(join(src, "page-2.md"), "# Page Two\n\nmore body.\n");
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "file2md:doc", dir: src };

		const first = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(first).not.toBeNull();
		expect(first!.created).toBe(2);

		const second = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(second!.created).toBe(0);
		expect(second!.unchanged).toBe(2);
	});

	test("returns null for a dir with no .md files", async () => {
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "file2md:empty", dir: src };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).toBeNull();
	});
});

describe("convergeKnowledgeEmission — kbFile route", () => {
	test("parses a .knowledge.jsonl and ingests", async () => {
		const kbFile = join(src, "out.knowledge.jsonl");
		writeFileSync(kbFile, `${JSON.stringify(sampleRecord())}\n`);
		const payload: KnowledgeEmission = { source: "workflow-jsonl", sourceLabel: "wf:x", kbFile };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).not.toBeNull();
		expect(out!.created).toBeGreaterThanOrEqual(1);
	});
});

describe("convergeKnowledgeEmission — records route", () => {
	test("ingests inline records", async () => {
		const payload: KnowledgeEmission = {
			source: "workflow-jsonl",
			sourceLabel: "wf:inline",
			records: [sampleRecord()],
		};
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).not.toBeNull();
		expect(out!.created).toBeGreaterThanOrEqual(1);
	});
});

describe("convergeKnowledgeEmission — empty payload", () => {
	test("returns null when no records/kbFile/dir", async () => {
		const payload: KnowledgeEmission = { source: "generic", sourceLabel: "x", note: "nothing" };
		const out = await convergeKnowledgeEmission(payload, { vaultPath: vault, cwd: src });
		expect(out).toBeNull();
	});
});
