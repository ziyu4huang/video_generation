/**
 * End-to-end structural tests for the research-tool CLI sub-commands.
 *
 * These tests verify that:
 *   1. The CLI subcommand specs (`collectVideosSubcommand` etc.) satisfy the
 *      `ExtensionSubcommandSpec` shape structurally (name/summary/details/factory/tools/task).
 *   2. The `task()` builder produces correct tool parameter strings for every
 *      flag combination the specs document.
 *   3. Edge cases (missing positionals, unknown platform/preset, keyword quoting,
 *      all flag permutations) are handled without error.
 *
 * These are NOT agent-session e2e tests (the CLI session pipeline requires an
 * LLM provider and is covered by s2-agent's own integration tests). They
 * validate the task-builder logic that CLI flags → agent prompt translation.
 */
import { test, expect, describe } from "bun:test";
import {
	collectVideosSubcommand,
	organizeVaultSubcommand,
	importMemorySubcommand,
	newsSubcommand,
} from "../extensions/cli-subcommand.ts";
import extension from "../extensions/research-tool.ts";

/** Minimal cast helper: adds runtime flag fields to `{ positionals: string[] }`. */
function taskInput(positionals: string[], flags?: Record<string, unknown>) {
	return { positionals, ...flags };
}

// ── Structural contract (ExtensionSubcommandSpec) ───────────────────────────

describe("CLI subcommand specs — structural contract", () => {
	const specs = [
		{ name: "collect-videos", spec: collectVideosSubcommand },
		{ name: "organize-vault", spec: organizeVaultSubcommand },
		{ name: "import-memory", spec: importMemorySubcommand },
		{ name: "news", spec: newsSubcommand },
	];

	for (const { name, spec } of specs) {
		test(`${name}: has all ExtensionSubcommandSpec fields`, () => {
			expect(typeof spec.name).toBe("string");
			expect(spec.name.length).toBeGreaterThan(0);
			expect(spec.name[0]).not.toBe("-");

			expect(typeof spec.summary).toBe("string");
			expect(spec.summary.length).toBeGreaterThan(0);

			expect(typeof spec.details).toBe("string");
			expect(spec.details.length).toBeGreaterThan(0);

			expect(typeof spec.factory).toBe("function");
			expect(Array.isArray(spec.tools)).toBe(true);
			expect(spec.tools.length).toBeGreaterThan(0);
			expect(typeof spec.task).toBe("function");
		});

		test(`${name}: factory is the research extension`, () => {
			expect(spec.factory).toBe(extension);
		});

		test(`${name}: tools list is non-empty and every tool name is a string`, () => {
			for (const tool of spec.tools) {
				expect(typeof tool).toBe("string");
				expect(tool.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("CLI subcommand specs — unique names", () => {
	test("no two specs share a name", () => {
		const names = [collectVideosSubcommand.name, organizeVaultSubcommand.name, importMemorySubcommand.name, newsSubcommand.name];
		expect(new Set(names).size).toBe(names.length);
	});
});

// ── collect-videos task builder ─────────────────────────────────────────────

describe("collect-videos task builder — positionals", () => {
	test("bilibili llm → platform=bilibili, preset=llm", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"]));
		expect(task).toContain('platform="bilibili"');
		expect(task).toContain('preset="llm"');
		expect(task).toContain("collect_videos");
	});

	test("youtube llm → platform=youtube, preset=llm", () => {
		const task = collectVideosSubcommand.task(taskInput(["youtube", "llm"]));
		expect(task).toContain('platform="youtube"');
		expect(task).toContain('preset="llm"');
	});

	test("bilibili media → preset=media", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "media"]));
		expect(task).toContain('preset="media"');
	});

	test("bilibili custom → preset=custom", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "custom"]));
		expect(task).toContain('preset="custom"');
	});

	test("no positionals → defaults to bilibili/llm", () => {
		const task = collectVideosSubcommand.task(taskInput([]));
		expect(task).toContain('platform="bilibili"');
		expect(task).toContain('preset="llm"');
	});

	test("only platform → preset defaults to llm", () => {
		const task = collectVideosSubcommand.task(taskInput(["youtube"]));
		expect(task).toContain('platform="youtube"');
		expect(task).toContain('preset="llm"');
	});

	test("unknown platform → falls back to bilibili with note", () => {
		const task = collectVideosSubcommand.task(taskInput(["tiktok", "llm"]));
		expect(task).toContain('platform="bilibili"');
		expect(task).toContain('unrecognised "tiktok"');
	});

	test("unknown preset → treated as custom with note", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "unknown-preset"]));
		expect(task).toContain('preset="custom"');
		expect(task).toContain('unrecognised "unknown-preset"');
	});

	test("keywords from extra positionals → comma-joined", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "custom", "RLHF", "PPO", "DPO"]));
		expect(task).toContain('keywords=["RLHF,PPO,DPO"]');
	});

	test("single keyword → no comma sep needed", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "custom", "Sora"]));
		expect(task).toContain('keywords=["Sora"]');
	});

	test("keyword with embedded quotes is escaped", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "custom", 'term with "quotes"']));
		expect(task).not.toContain('"quotes"');
		expect(task).toContain('\\"quotes\\"');
	});
});

describe("collect-videos task builder — flags", () => {
	test("--popular true → popular=true emitted", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { popular: true }));
		expect(task).toContain("popular=true");
	});

	test("--popular false → not emitted", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { popular: false }));
		expect(task).not.toContain("popular=");
	});

	test("--pages 3 → pages=3", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { pages: 3 }));
		expect(task).toContain("pages=3");
	});

	test("--pages 0 (edge) → pages=0", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { pages: 0 }));
		expect(task).toContain("pages=0");
	});

	test("--order click → order=click", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { order: "click" }));
		expect(task).toContain('order="click"');
	});

	test("--order date (youtube) → order=date", () => {
		const task = collectVideosSubcommand.task(taskInput(["youtube", "llm"], { order: "date" }));
		expect(task).toContain('order="date"');
	});

	test("--proxy http://127.0.0.1:7890 → proxy=...", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { proxy: "http://127.0.0.1:7890" }));
		expect(task).toContain('proxy="http://127.0.0.1:7890"');
	});

	test("--recency 7 → recency=7", () => {
		const task = collectVideosSubcommand.task(taskInput(["youtube", "llm"], { recency: 7 }));
		expect(task).toContain("recency=7");
	});

	test("--recency 0 (all history) → recency=0", () => {
		const task = collectVideosSubcommand.task(taskInput(["youtube", "llm"], { recency: 0 }));
		expect(task).toContain("recency=0");
	});

	test("--output-path custom.md → outputPath=...", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { outputPath: "/tmp/my-news.md" }));
		expect(task).toContain('outputPath="/tmp/my-news.md"');
	});

	test("all flags combined → all appear in output", () => {
		const task = collectVideosSubcommand.task(
			taskInput(["bilibili", "custom", "Attention", "Mechanism"], {
				popular: true,
				pages: 2,
				order: "dm",
				proxy: "http://127.0.0.1:7890",
				outputPath: "./out.md",
			}),
		);
		expect(task).toContain('platform="bilibili"');
		expect(task).toContain('preset="custom"');
		expect(task).toContain('keywords=["Attention,Mechanism"]');
		expect(task).toContain("popular=true");
		expect(task).toContain("pages=2");
		expect(task).toContain('order="dm"');
		expect(task).toContain('proxy="http://127.0.0.1:7890"');
		expect(task).toContain('outputPath="./out.md"');
	});

	test("trailing report instruction always present", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"]));
		expect(task).toContain("total videos collected");
		expect(task).toContain("per-keyword counts");
		expect(task).toContain("output file path");
		expect(task).toContain("any errors");
	});

	test("--dry-run → dryRun=true", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"], { dryRun: true }));
		expect(task).toContain("dryRun=true");
	});

	test("--dry-run absent → dryRun not emitted", () => {
		const task = collectVideosSubcommand.task(taskInput(["bilibili", "llm"]));
		expect(task).not.toContain("dryRun=");
	});
});

// ── organize-vault task builder ─────────────────────────────────────────────

describe("organize-vault task builder", () => {
	test("no flags → minimal task referencing the tool", () => {
		const task = organizeVaultSubcommand.task(taskInput([]));
		expect(task).toContain("organize_vault_notes");
		expect(task).toContain("report the results");
		expect(task).toContain("how many notes were updated");
	});

	test("--dry-run → dryRun=true", () => {
		const task = organizeVaultSubcommand.task(taskInput([], { dryRun: true }));
		expect(task).toContain("dryRun=true");
	});

	test("--dry-run false → not emitted", () => {
		const task = organizeVaultSubcommand.task(taskInput([], { dryRun: false }));
		expect(task).not.toContain("dryRun=");
	});

	test("--vault-root /path/to/vault → vaultRoot=...", () => {
		const task = organizeVaultSubcommand.task(taskInput([], { vaultRoot: "/Users/test/vault" }));
		expect(task).toContain('vaultRoot="/Users/test/vault"');
	});

	test("--dry-run + --vault-root combined", () => {
		const task = organizeVaultSubcommand.task(
			taskInput([], { dryRun: true, vaultRoot: "./test-vault" }),
		);
		expect(task).toContain("dryRun=true");
		expect(task).toContain('vaultRoot="./test-vault"');
	});
});

// ── import-memory task builder ──────────────────────────────────────────────

describe("import-memory task builder", () => {
	test("no flags → minimal task referencing the tool", () => {
		const task = importMemorySubcommand.task(taskInput([]));
		expect(task).toContain("import_memory_to_vault");
		expect(task).toContain("report how many entries");
	});

	test("--output-path custom.jsonl → outputPath=...", () => {
		const task = importMemorySubcommand.task(taskInput([], { outputPath: "/tmp/out.jsonl" }));
		expect(task).toContain('outputPath="/tmp/out.jsonl"');
	});

	test("--hermes-dir /custom/hermes → hermesDir=...", () => {
		const task = importMemorySubcommand.task(taskInput([], { hermesDir: "/custom/hermes" }));
		expect(task).toContain('hermesDir="/custom/hermes"');
	});

	test("--output-path + --hermes-dir combined", () => {
		const task = importMemorySubcommand.task(
			taskInput([], { outputPath: "./my-collection.jsonl", hermesDir: "/tmp/hermes" }),
		);
		expect(task).toContain('outputPath="./my-collection.jsonl"');
		expect(task).toContain('hermesDir="/tmp/hermes"');
	});

	test("--dry-run → dryRun=true", () => {
		const task = importMemorySubcommand.task(taskInput([], { dryRun: true }));
		expect(task).toContain("dryRun=true");
	});

	test("--dry-run absent → dryRun not emitted", () => {
		const task = importMemorySubcommand.task(taskInput([]));
		expect(task).not.toContain("dryRun=");
	});
});

// ── news task builder ───────────────────────────────────────────────────────

describe("news task builder", () => {
	test("no flags → names the tool + full workflow + report instruction", () => {
		const task = newsSubcommand.task(taskInput([]));
		expect(task).toContain("collect_news");
		expect(task).toContain("step 1");
		expect(task).toContain("web search");
		expect(task).toContain("繁體中文");
		expect(task).toContain("issue path");
		expect(task).toContain("date range");
		expect(task).toContain("top headlines");
	});

	test("focus positionals → mentioned in the research step", () => {
		const task = newsSubcommand.task(taskInput(["agents", "evals"]));
		expect(task).toContain("focus: agents, evals");
	});

	test("--date iso → date=...", () => {
		const task = newsSubcommand.task(taskInput([], { date: "2026-09-01" }));
		expect(task).toContain('date="2026-09-01"');
	});

	test("--output-path → outputPath=...", () => {
		const task = newsSubcommand.task(taskInput([], { outputPath: "/tmp/issue.md" }));
		expect(task).toContain('outputPath="/tmp/issue.md"');
	});

	test("--overwrite → overwrite=true", () => {
		const task = newsSubcommand.task(taskInput([], { overwrite: true }));
		expect(task).toContain("overwrite=true");
	});

	test("--overwrite absent → not emitted", () => {
		const task = newsSubcommand.task(taskInput([]));
		expect(task).not.toContain("overwrite=");
	});

	test("--dry-run → dryRun=true", () => {
		const task = newsSubcommand.task(taskInput([], { dryRun: true }));
		expect(task).toContain("dryRun=true");
	});

	test("--dry-run absent → not emitted", () => {
		const task = newsSubcommand.task(taskInput([]));
		expect(task).not.toContain("dryRun=");
	});
});

// ── TypeScript compile-time check (re-export consistency) ───────────────────

describe("export consistency", () => {
	test("all exports are structurally-compatible ExtensionSubcommandSpecs", () => {
		// The type check is compile-time (tsc --noEmit passes). Runtime shape guard:
		const all = [collectVideosSubcommand, organizeVaultSubcommand, importMemorySubcommand, newsSubcommand];
		for (const spec of all) {
			expect(spec).toHaveProperty("name");
			expect(spec).toHaveProperty("summary");
			expect(spec).toHaveProperty("details");
			expect(spec).toHaveProperty("factory");
			expect(spec).toHaveProperty("tools");
			expect(spec).toHaveProperty("task");
		}
	});
});
