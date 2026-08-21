import { expect, test } from "bun:test";
import { buildStaticExtensionsSource } from "../static-extensions-gen.ts";

/**
 * Unit tests for the pure static-extensions source generator (PR A, Phase D).
 * The fixture deliberately mixes commented rows (task, subagent) with bare
 * rows (prompt-history, workflow) and exercises an unknown suffix.
 */
test("generates header + banner + ordered imports + rows", () => {
	const src = buildStaticExtensionsSource({ staticExtensions: ["task", "prompt-history", "subagent", "ultracode"] });
	expect(src.startsWith("/**")).toBe(true);
	expect(src).toContain("// AUTO-GENERATED from run-dir/manifest.json staticExtensions[]");
	expect(src).toContain('import taskExtension from "../../s2-agent-ext-task/extensions/task.ts";');
	expect(src).toContain('import ultracodeExtension from "../../s2-agent-ext-ultracode/extensions/ultracode.ts";');
	expect(src).toContain('\t{ name: "s2-agent-ext-task", factory: taskExtension },');
	// ROW_COMMENTS from the current file survive on their rows:
	expect(src).toContain("must\n\t// load before workflow");
	// unknown suffix → bare row, no crash:
	const bare = buildStaticExtensionsSource({ staticExtensions: ["brand-new"] });
	expect(bare).toContain('\t{ name: "s2-agent-ext-brand-new", factory: brandNewExtension },');
	// determinism:
	expect(buildStaticExtensionsSource({ staticExtensions: ["task"] })).toBe(
		buildStaticExtensionsSource({ staticExtensions: ["task"] }),
	);
});

test("output shape: ends with ]; and each binding appears exactly twice (import + row)", () => {
	const src = buildStaticExtensionsSource({ staticExtensions: ["task", "prompt-history", "subagent", "ultracode"] });
	expect(src.endsWith("];\n")).toBe(true);
	for (const binding of ["taskExtension", "promptHistoryExtension", "subagentExtension", "ultracodeExtension"]) {
		expect(src.split(binding).length - 1).toBe(2);
	}
});

test("import order follows input order", () => {
	const src = buildStaticExtensionsSource({ staticExtensions: ["task", "prompt-history", "subagent", "ultracode"] });
	const positions = [
		src.indexOf('import taskExtension from "../../s2-agent-ext-task/extensions/task.ts";'),
		src.indexOf('import promptHistoryExtension from "../../s2-agent-ext-prompt-history/extensions/prompt-history.ts";'),
		src.indexOf('import subagentExtension from "../../s2-agent-ext-subagent/extensions/subagent.ts";'),
		src.indexOf('import ultracodeExtension from "../../s2-agent-ext-ultracode/extensions/ultracode.ts";'),
	];
	expect(positions.every((p) => p >= 0)).toBe(true);
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test("manifest-style full package names normalize to the same output as bare suffixes", () => {
	// manifest.json currently carries full names ("s2-agent-ext-task"), while
	// the generator's contract also accepts bare suffixes ("task").
	const bare = buildStaticExtensionsSource({ staticExtensions: ["task", "webui"] });
	const full = buildStaticExtensionsSource({ staticExtensions: ["s2-agent-ext-task", "s2-agent-ext-webui"] });
	expect(full).toBe(bare);
});
