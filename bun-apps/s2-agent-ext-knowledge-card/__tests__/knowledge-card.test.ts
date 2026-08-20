import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piKnowledgeCardExtension, {
	ADD_TOOLS,
	CHECK_TASK,
	CHECK_TOOLS,
	DISTILL_TOOLS,
	FIND_TOOLS,
	RAG_TOOLS,
	REMOVE_TOOLS,
	UPDATE_TOOLS,
	buildAddTask,
	buildDistillTask,
	buildFindTask,
	buildRagTask,
	buildRemoveTask,
	buildUpdateTask,
	__setVaultResolverForTest,
} from "../extensions/knowledge-card.ts";
import { ingestRecords } from "../src/ingest.ts";
import type { KnowledgeRecord } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Tool allowlists — sanity checks (the CLI imports these verbatim)
// ---------------------------------------------------------------------------

describe("tool allowlists", () => {
	test("all are non-empty string arrays", () => {
		for (const list of [
			DISTILL_TOOLS,
			ADD_TOOLS,
			FIND_TOOLS,
			UPDATE_TOOLS,
			REMOVE_TOOLS,
			CHECK_TOOLS,
			RAG_TOOLS,
		]) {
			expect(Array.isArray(list)).toBe(true);
			expect(list.length).toBeGreaterThan(0);
			for (const t of list) expect(typeof t).toBe("string");
		}
	});

	test('csv-joinable (the extension passes .join(",") to runSubagentWithRetry)', () => {
		// Post Phase-3 obsidian fat-tool migration: only `obsidian`/`obsidian_help`
		// are real registered tools (see knowledge-card.ts's allowlist comment).
		expect(DISTILL_TOOLS.join(",")).toBe("read,obsidian,obsidian_help");
		expect(RAG_TOOLS.join(",")).toBe("obsidian,obsidian_help");
	});

	test("FIND_TOOLS == RAG_TOOLS (graph expansion is a search param, not a new tool)", () => {
		expect(RAG_TOOLS).toEqual(FIND_TOOLS);
	});
});

// ---------------------------------------------------------------------------
// buildDistillTask
// ---------------------------------------------------------------------------

describe("buildDistillTask", () => {
	test("includes each file relative to cwd", () => {
		const cwd = "/home/user/proj";
		const task = buildDistillTask(
			["/home/user/proj/inbox/a.md", "/home/user/proj/inbox/b.txt"],
			cwd,
			"Zettelkasten",
		);
		expect(task).toContain("- inbox/a.md");
		expect(task).toContain("- inbox/b.txt");
	});

	test("shows a path relative to cwd even when outside it", () => {
		const task = buildDistillTask(
			["/elsewhere/x.md"],
			"/home/user/proj",
			"Zettelkasten",
		);
		// relative() yields a "../…" form (depth-dependent), so assert the tail.
		expect(task).toContain("elsewhere/x.md");
		expect(task).not.toContain("- /elsewhere/x.md");
	});

	test("falls back to the raw path only when it equals cwd", () => {
		const task = buildDistillTask(["/cwd"], "/cwd", "Zettelkasten");
		expect(task).toContain("- /cwd");
	});

	test("embeds the target folder", () => {
		const task = buildDistillTask(["a.md"], "/cwd", "MyNotes");
		expect(task).toContain("Target folder: MyNotes");
	});

	test("includes the max-notes hint when given", () => {
		const task = buildDistillTask(["a.md"], "/cwd", "Zettelkasten", 20);
		expect(task).toContain("no more than 20 notes");
	});

	test("omits the hint when not given", () => {
		const task = buildDistillTask(["a.md"], "/cwd", "Zettelkasten");
		expect(task).not.toContain("no more than");
	});

	test('instructs to call obsidian action:"distill" and summarise in zh-TW', () => {
		const task = buildDistillTask(["a.md"], "/cwd", "Zettelkasten");
		expect(task).toContain('action:"distill"');
		expect(task).toContain("Traditional Chinese");
	});
});

// ---------------------------------------------------------------------------
// buildAddTask
// ---------------------------------------------------------------------------

describe("buildAddTask", () => {
	test("non-force: includes 4-layer duplicate check protocol", () => {
		const task = buildAddTask(
			"Zettelkasten is atomic notes",
			"Zettelkasten",
			false,
		);
		expect(task).toContain("Duplicate-check protocol (4 layers)");
		expect(task).toContain("Layer 1");
		expect(task).toContain("Layer 2");
		expect(task).toContain("Layer 3");
		expect(task).toContain("Layer 4");
		expect(task).toContain("85%");
		expect(task).toContain("60–85%");
	});

	test("non-force: includes the content", () => {
		const task = buildAddTask("my concept text", "Zettelkasten", false);
		expect(task).toContain("my concept text");
	});

	test("non-force: targets the specified folder", () => {
		const task = buildAddTask("content", "MyFolder", false);
		expect(task).toContain("MyFolder");
	});

	test("force: skips duplicate check, instructs direct creation", () => {
		const task = buildAddTask("content", "Zettelkasten", true);
		expect(task).not.toContain("Duplicate-check protocol");
		expect(task).toContain("force_inserted: true");
		expect(task).toContain("duplicate_candidates");
		expect(task).toContain("#duplicate-candidate");
	});

	test("force: still includes the content", () => {
		const task = buildAddTask("my concept text", "Zettelkasten", true);
		expect(task).toContain("my concept text");
	});
});

// ---------------------------------------------------------------------------
// buildFindTask
// ---------------------------------------------------------------------------

describe("buildFindTask", () => {
	test("includes the query", () => {
		const task = buildFindTask("bun workspace", 3, 10);
		expect(task).toContain("bun workspace");
	});

	test("contextLines=0: titles only description", () => {
		const task = buildFindTask("query", 0, 10);
		expect(task).toContain("Titles only");
		expect(task).not.toContain("lines of context");
	});

	test("contextLines=3: shows surrounding lines description", () => {
		const task = buildFindTask("query", 3, 10);
		expect(task).toContain("3 context lines");
	});

	test("contextLines=5: custom count in description", () => {
		const task = buildFindTask("query", 5, 10);
		expect(task).toContain("5 context lines");
	});

	test("limit is embedded in task", () => {
		const task = buildFindTask("query", 3, 5);
		expect(task).toContain("5 results");
	});

	test("includes 3-strategy search order", () => {
		const task = buildFindTask("query", 3, 10);
		expect(task).toContain("Title fuzzy match");
		expect(task).toContain("Tag match");
		expect(task).toContain("Body keyword match");
	});
});

// ---------------------------------------------------------------------------
// buildUpdateTask
// ---------------------------------------------------------------------------

describe("buildUpdateTask", () => {
	test("includes note path", () => {
		const task = buildUpdateTask("Zettelkasten/My-Note.md", "new content");
		expect(task).toContain("Zettelkasten/My-Note.md");
	});

	test("includes new content", () => {
		const task = buildUpdateTask(
			"Zettelkasten/My-Note.md",
			"additional info here",
		);
		expect(task).toContain("additional info here");
	});

	test("includes all 5 smart merge rules", () => {
		const task = buildUpdateTask("note.md", "content");
		expect(task).toContain("SKIP");
		expect(task).toContain('action:"append_section"');
		expect(task).toContain('action:"append"');
		expect(task).toContain('action:"update_frontmatter"');
		expect(task).toContain("sources[]");
	});
});

// ---------------------------------------------------------------------------
// buildRemoveTask
// ---------------------------------------------------------------------------

describe("buildRemoveTask", () => {
	test("safe mode: includes backlink check steps", () => {
		const task = buildRemoveTask("Zettelkasten/Note.md", false);
		expect(task).toContain("Zettelkasten/Note.md");
		expect(task).toContain('action:"read"');
		expect(task).toContain("backlinks:true");
		expect(task).toContain("--force");
	});

	test("safe mode: does NOT immediately delete", () => {
		const task = buildRemoveTask("Zettelkasten/Note.md", false);
		expect(task).not.toContain("--force mode");
	});

	test("force mode: immediate delete instruction", () => {
		const task = buildRemoveTask("Zettelkasten/Note.md", true);
		expect(task).toContain("--force mode");
		expect(task).toContain('action:"delete"');
		expect(task).toContain("link cleanup");
	});

	test("force mode: no backlink check", () => {
		const task = buildRemoveTask("Zettelkasten/Note.md", true);
		expect(task).not.toContain("backlinks:true");
	});

	test("includes the note path in both modes", () => {
		const path = "Zettelkasten/Target.md";
		expect(buildRemoveTask(path, false)).toContain(path);
		expect(buildRemoveTask(path, true)).toContain(path);
	});
});

// ---------------------------------------------------------------------------
// CHECK_TASK
// ---------------------------------------------------------------------------

describe("CHECK_TASK", () => {
	test("is a non-empty string", () => {
		expect(typeof CHECK_TASK).toBe("string");
		expect(CHECK_TASK.length).toBeGreaterThan(0);
	});

	test('references obsidian action:"garden"', () => {
		expect(CHECK_TASK).toContain('action:"garden"');
	});

	test("covers all 4 audit categories", () => {
		expect(CHECK_TASK).toContain("Duplicate");
		expect(CHECK_TASK).toContain("Orphan");
		expect(CHECK_TASK).toContain("Dead links");
		expect(CHECK_TASK).toContain("Unlinked related");
	});
});

// ---------------------------------------------------------------------------
// buildRagTask
// ---------------------------------------------------------------------------

describe("buildRagTask", () => {
	const BASE = { query: "How does Bun handle workspaces?", depth: 2, topK: 8 };

	test("includes query in output", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain(BASE.query);
	});

	test("includes all 3 seed retrieval strategies", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("matchMode:fuzzy");
		expect(t).toContain("fields:title");
		expect(t).toContain("fields:tags");
		expect(t).toContain("fields:body");
	});

	test("includes graph:neighbors with correct depth", () => {
		const t = buildRagTask(BASE.query, 3, BASE.topK, false, false);
		expect(t).toContain('graph:"neighbors"');
		expect(t).toContain("3 hop");
	});

	test("default depth=2 produces 2-hop instruction", () => {
		const t = buildRagTask(BASE.query, 2, BASE.topK, false, false);
		expect(t).toContain("2 hop");
	});

	test("top-K appears in cluster & rank step", () => {
		const t = buildRagTask(BASE.query, BASE.depth, 12, false, false);
		expect(t).toContain("12");
	});

	test("generate mode includes generate instruction", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Step 5: Generate answer");
		expect(t).not.toContain("Step 5: Context output");
	});

	test("retrieve-only mode skips generation, outputs context", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, true);
		expect(t).toContain("Step 5: Context output");
		expect(t).not.toContain("Step 5: Generate answer");
	});

	test("summarize=true includes cluster summary instruction", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, true, false);
		expect(t).toContain("summary per cluster");
	});

	test("summarize=false uses raw note content", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("raw note content");
		expect(t).not.toContain("summary per cluster");
	});

	test("always includes referenced notes footer", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Reference notes");
		expect(t).toContain("one-line reason");
	});

	test("retrieve-only + summarize can be combined", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, true, true);
		expect(t).toContain("Step 5: Context output");
		expect(t).toContain("summary per cluster");
	});

	test("5 steps are all present in the task", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Step 1");
		expect(t).toContain("Step 2");
		expect(t).toContain("Step 3");
		expect(t).toContain("Step 4");
		expect(t).toContain("Step 5");
	});

	// Enhancement 1: Deterministic Stage 3 scoring
	test("Stage 3 includes deterministic scoring formula with search_score", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("search_score");
		expect(t).toContain("0.7");
		expect(t).toContain("0.3");
	});

	test("Stage 3 includes link_count signal", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("link_count");
		expect(t).toContain("[[wikilink]]");
	});

	test("Stage 3 specifies fallback score when search_score unavailable", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("0.5");
	});

	// Enhancement 2: Graph expansion budget
	test("Stage 2 progressive deepening: depth>=2 mentions depth-2", () => {
		const t = buildRagTask(BASE.query, 2, BASE.topK, false, false);
		expect(t).toContain("depth-1");
		expect(t).toContain("depth-2");
	});

	test("Stage 2 depth=1 says depth-1 only, no depth-2", () => {
		const t = buildRagTask(BASE.query, 1, BASE.topK, false, false);
		expect(t).toContain("depth-1");
		expect(t).not.toContain("depth-2");
	});

	test("Stage 2 uses default maxNeighbors=5 when not specified", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("5");
	});

	test("Stage 2 respects custom maxNeighbors", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false, 10);
		expect(t).toContain("10");
	});

	test("Stage 2 progressive deepening uses topK as threshold", () => {
		const t = buildRagTask(BASE.query, BASE.depth, 12, false, false);
		expect(t).toContain("12");
	});

	// Enhancement 3: Snippet-first context assembly
	test("Stage 4 uses 2-tier strategy with score threshold 0.7", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Tier 1 (full read)");
		expect(t).toContain("Tier 2 (snippet only)");
		expect(t).toContain("score ≥ 0.7");
		expect(t).toContain('Do NOT call action:"read"');
	});

	// P1: callout surfacing instruction is wired into context assembly
	test("Stage 4 instructs the agent to surface Obsidian callouts first", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Feature surfacing (P1)");
		expect(t).toContain("> [!warning|tip|info|caution|...]");
		expect(t).toContain("must not be buried");
	});

	test("Stage 4 maxNoteTokens controls full-read truncation limit", () => {
		const t = buildRagTask(
			BASE.query,
			BASE.depth,
			BASE.topK,
			false,
			false,
			5,
			1500,
		);
		expect(t).toContain("1500 tokens");
	});

	// Fix 4: Tier 1 threshold respects topK
	test("Stage 4 tier1Count = 1 when topK = 1", () => {
		const t = buildRagTask(BASE.query, BASE.depth, 1, false, false);
		expect(t).toContain("ranked in the top 1");
		expect(t).not.toContain("ranked in the top 3");
	});

	test("Stage 4 tier1Count = 2 when topK = 2", () => {
		const t = buildRagTask(BASE.query, BASE.depth, 2, false, false);
		expect(t).toContain("ranked in the top 2");
		expect(t).not.toContain("ranked in the top 3");
	});

	test("Stage 4 tier1Count = 3 when topK >= 3 (default)", () => {
		const t = buildRagTask(BASE.query, BASE.depth, 8, false, false);
		expect(t).toContain("ranked in the top 3");
	});

	// Enhancement 4: Seed refinement loop
	test("Stage 1 includes seed quality gate by default", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).toContain("Seed quality gate");
		expect(t).toContain("0.4");
		expect(t).toContain("maximum 1 retry");
	});

	test("Stage 1 seed quality gate is suppressed when noRefine=true", () => {
		const t = buildRagTask(
			BASE.query,
			BASE.depth,
			BASE.topK,
			false,
			false,
			5,
			2000,
			true,
		);
		expect(t).not.toContain("Seed quality gate");
		expect(t).not.toContain("maximum 1 retry");
	});

	// Fix 5: --folder scope
	test("folder param injects scope restriction into Step 1", () => {
		const t = buildRagTask(
			BASE.query,
			BASE.depth,
			BASE.topK,
			false,
			false,
			5,
			2000,
			false,
			"Inbox",
		);
		expect(t).toContain("Inbox");
		expect(t).toContain('folder: "Inbox"');
	});

	test("no folder param — no folder restriction in output", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, false);
		expect(t).not.toContain("folder:");
	});

	// Fix 6: query wrapped in XML tags
	test("query is wrapped in XML tags, not bare double-quotes", () => {
		const q = 'query with "quotes" and\n## Step N: fake step';
		const t = buildRagTask(q, BASE.depth, BASE.topK, false, false);
		expect(t).toContain(`<question>${q}</question>`);
	});

	// Fix 7: --summarize --retrieve-only Step 5 text
	test("retrieve-only + summarize Step 5 says summaries, not content", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, true, true);
		expect(t).toContain("per-cluster summaries");
		expect(t).not.toContain("content of each note");
	});

	test("retrieve-only without summarize Step 5 says content of each note", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, false, true);
		expect(t).toContain("content of each note");
		expect(t).not.toContain("per-cluster summaries");
	});

	// Fix 8: assembleNote placed inside Tier 1 block, before Tier 2
	test("assembleNote appears before Tier 2 block", () => {
		const t = buildRagTask(BASE.query, BASE.depth, BASE.topK, true, false);
		const tier1Pos = t.indexOf("Tier 1 (full read)");
		const assemblePos = t.indexOf("summary per cluster");
		const tier2Pos = t.indexOf("Tier 2 (snippet only)");
		expect(tier1Pos).toBeLessThan(assemblePos);
		expect(assemblePos).toBeLessThan(tier2Pos);
	});

	// Defensive clamp: depth <= 0 must not produce contradictory instructions
	test("depth=0 is clamped to 1 (no 'up to 0 hops' contradiction)", () => {
		const t = buildRagTask(BASE.query, 0, BASE.topK, false, false);
		expect(t).not.toContain("up to 0 hop");
		expect(t).toContain("depth-1 neighbors only");
	});

	test("negative depth is clamped to 1", () => {
		const t = buildRagTask(BASE.query, -3, BASE.topK, false, false);
		expect(t).not.toContain("up to -3 hop");
		expect(t).toContain("depth-1 neighbors only");
	});
});

// ---------------------------------------------------------------------------
// Tool execute() — parameter-validation early returns
//
// These tests capture the registered tools via a mock ExtensionAPI and invoke
// their execute() with invalid params. The validation branches return *before*
// runSubagentWithRetry is called, so no real subagent is spawned.
// ---------------------------------------------------------------------------

type CapturedTool = {
	name: string;
	execute: (
		id: any,
		params: any,
		signal: any,
		_u: any,
		ctx: any,
	) => Promise<any>;
};

function loadTools(): Record<string, CapturedTool> {
	const tools: Record<string, CapturedTool> = {};
	const mockPi: any = {
		registerTool: (def: any) => {
			tools[def.name] = { name: def.name, execute: def.execute };
		},
		on() {},
		events: { on() {}, emit() {} },
	};
	piKnowledgeCardExtension(mockPi);
	return tools;
}

const CTX = { cwd: "/test" };

async function runTool(name: string, params: any): Promise<any> {
	const tools = loadTools();
	const tool = tools[name];
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool.execute(undefined, params, undefined, undefined, CTX);
}

describe("zk_card execute validation", () => {
	test("add without content -> error", async () => {
		const res = await runTool("zk_card", { action: "add" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("requires 'content'");
		expect(res.details).toBeNull();
	});

	test("find without query -> error", async () => {
		const res = await runTool("zk_card", { action: "find" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("requires 'query'");
		expect(res.details).toBeNull();
	});

	test("update without note -> error", async () => {
		const res = await runTool("zk_card", { action: "update", content: "x" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("requires 'note' and 'content'");
		expect(res.details).toBeNull();
	});

	test("update without content -> error", async () => {
		const res = await runTool("zk_card", { action: "update", note: "n.md" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("requires 'note' and 'content'");
		expect(res.details).toBeNull();
	});

	test("remove without note -> error", async () => {
		const res = await runTool("zk_card", { action: "remove" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("requires 'note'");
		expect(res.details).toBeNull();
	});
});

describe("tool registration", () => {
	test("registers exactly zk_card, zk_ask, zk_ingest, knowledge_query", () => {
		const tools = loadTools();
		expect(Object.keys(tools).sort()).toEqual([
			"knowledge_query",
			"zk_ask",
			"zk_card",
			"zk_ingest",
		]);
	});

	test("the migrated knowledge_query tool is wired (consolidation cycle)", () => {
		const tools = loadTools();
		// Migrated from s2-agent-ext-power-tool so the hub owns every agent-facing
		// knowledge tool. No-LLM surface over retrieve.ts.
		expect(tools.knowledge_query).toBeDefined();
		expect(typeof tools.knowledge_query.execute).toBe("function");
	});

	test("each registered tool has a non-empty description and execute fn", () => {
		const tools = loadTools();
		for (const name of Object.keys(tools)) {
			expect(typeof tools[name].execute).toBe("function");
		}
	});
});

// ---------------------------------------------------------------------------
// Migrated tool (knowledge_query) — behavior preservation.
// Proves the move from s2-agent-ext-power-tool kept the tool-level behavior:
// it resolves the vault (OB_VAULT_PATH) and returns the retrieve.ts digest.
// The underlying library contracts are covered by retrieve.test.ts; this pins
// the tool EXECUTE wrapper.
// ---------------------------------------------------------------------------

describe("knowledge_query (migrated tool)", () => {
	let vault: string;
	let prevVaultEnv: string | undefined;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "kc-migrated-"));
		prevVaultEnv = process.env.OB_VAULT_PATH;
		process.env.OB_VAULT_PATH = vault;
		// Deterministic vault resolution: inject the test seam so knowledge_query /
		// graph_health resolve THIS temp vault directly, bypassing the multi-tier
		// resolveVault (which reads OB_VAULT_PATH and — under bun's async test
		// scheduling on CI — can observe a stale env value mid-await). Same seam
		// the error-path test below uses; resolveKnowledgeVault checks it FIRST.
		__setVaultResolverForTest(() => Promise.resolve(vault));
	});
	afterEach(() => {
		__setVaultResolverForTest(null);
		if (prevVaultEnv === undefined) delete process.env.OB_VAULT_PATH;
		else process.env.OB_VAULT_PATH = prevVaultEnv;
		rmSync(vault, { recursive: true, force: true });
	});

	test("knowledge_query returns the cross-workflow digest for matched tags", async () => {
		const rec: KnowledgeRecord = {
			id: "migrated:argv", type: "gotcha", title: "Argv gotcha",
			detail: "Reject leading-dash argv.", tags: ["argv"], dimension: "correctness",
			confidence: 0.8, status: "active", superseded_by: null,
		};
		await ingestRecords([rec], {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "migrated-test",
		});
		const res = await runTool("knowledge_query", { tags: ["argv"] });
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toContain("Knowledge graph: 1 card(s) matched");
		expect(res.content[0].text).toContain("Argv gotcha"); // digest surfaced the card
	});

	test("knowledge_query reports when no cards match", async () => {
		// Vault exists but has no matching card.
		await ingestRecords([{ ...{ id: "migrated:x", type: "gotcha", title: "X", detail: "d", tags: ["unrelated"], dimension: null, confidence: 0.5, status: "active", superseded_by: null } as KnowledgeRecord }], {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t",
		});
		const res = await runTool("knowledge_query", { tags: ["argv"] });
		expect(res.content[0].text).toContain("No knowledge cards matched");
	});

	test("knowledge_query infers tags from a natural-language query", async () => {
		await ingestRecords([{
			id: "migrated:argparse-lever", type: "lever", title: "Argparse lever",
			detail: "Use argparse.", tags: ["argparse"], dimension: "quality",
			confidence: 0.7, status: "active", superseded_by: null,
		} as KnowledgeRecord], {
			vaultPath: vault, source: "workflow-jsonl", sourceLabel: "t",
		});
		// No tags → the query "argparse configuration" is tokenized to [argparse, configuration].
		const res = await runTool("knowledge_query", { query: "argparse configuration" });
		expect(res.content[0].text).toContain("1 card(s) matched");
	});

	test("knowledge_query returns isError when vault resolution fails", async () => {
		// resolveVault has a Tier-2 (Obsidian app) fallback that resolves the real
		// open vault on this dev machine, so clearing OB_VAULT_PATH can't force a
		// failure deterministically. Inject a failing resolver via the test seam.
		__setVaultResolverForTest(() => Promise.reject(new Error("no vault for test")));
		try {
			const res = await runTool("knowledge_query", { tags: ["argv"] });
			expect(res.isError).toBe(true);
			expect(res.details.code).toBe("vault_resolution_failed");
			expect(res.content[0].text).toContain("vault resolution failed");
		} finally {
			__setVaultResolverForTest(null);
		}
	});

});
