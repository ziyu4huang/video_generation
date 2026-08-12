import { describe, test, expect } from "bun:test";
import { generateWorkflowScript } from "../commands/memory-to-vault-script.ts";

describe("generateWorkflowScript", () => {
	test("emits valid engine syntax: one obsidian-distill agent per file", () => {
		const script = generateWorkflowScript({
			files: ["/a/MEMORY.md", "/b/MEMORY.md"],
			folder: "Zettelkasten/knowledge-graph",
		});
		expect(script).toContain("export const meta");
		expect(script).toContain("name: 'memory_to_vault'");
		expect(script).toContain("phase('Distill')");
		expect(script).toContain("parallel(");
		// the two file paths are embedded for the agents
		expect(script).toContain("/a/MEMORY.md");
		expect(script).toContain("/b/MEMORY.md");
		expect(script).toContain('"Zettelkasten/knowledge-graph"');
		// the agent is directed at the obsidian tool's distill action (GATE-0 resolution)
		expect(script).toContain("obsidian");
		expect(script).toContain("distill");
		// anti-hallucination directive
		expect(script).toMatch(/actually (invoke|call)/i);
	});

	test("threads maxNotes into the agent instruction when provided", () => {
		const script = generateWorkflowScript({ files: ["/x.md"], folder: "Z", maxNotes: 25 });
		expect(script).toContain("25");
	});

	test("omits maxNotes when not provided", () => {
		const script = generateWorkflowScript({ files: ["/x.md"], folder: "Z" });
		expect(script).not.toContain("max_notes");
	});
});
