/**
 * execute() happy-path WIRING.
 *
 * Mocks runSubagentWithRetry + resolveVault (the two symbols pi-knowledge-card
 * imports from pi-obsidian) and asserts each action assembles the correct
 * (task, toolsCsv, tmpPrefix, opts) and shapes the result the right way. No real
 * subagent/LLM runs. bun test isolates each test FILE in its own process, so the
 * module mock here does not leak into allowlists/taskValidation.
 *
 *   bun test __tests__/toolWiring.test.mjs
 */
import { describe, it, expect, beforeAll, mock } from "bun:test";

// --- record + control the mocked runner -------------------------------------
const calls = [];
function defaultOk() {
	return {
		output: "DONE",
		result: null,
		attempts: 1,
	};
}
let nextResult = defaultOk();
let resolveVaultRet = {
	name: "TestVault",
	path: "/tmp/v",
	source: "env",
	staleReason: undefined,
};

// Build a mock of obsidian.ts that provides stubs for EVERY export the real
// module declares. Bun's mock.module() validates the mock against the real
// module's export list, so omitting any export causes a SyntaxError.
// Only `runSubagentWithRetry` and `resolveVault` are functional; the rest
// are never invoked in wiring-only tests.
//
// MOCK.GUARD (mock.module leak insulation — see e2e-orchestration.test.ts):
// Under `bun test` (no --isolate), test files share ONE process. The
// mock.module registered here leaks into sibling test files' static imports.
// If we stub `parseFrontmatter = () => ({ data: {}, bodyStart: 0 })`, that
// empty stub poisons every downstream test that reads frontmatter via
// pi-obsidian (distill gate's cross-vault card match, converge's supersede,
// retrieve's status filter), silently breaking the distill pipeline.
//
// We prevent this by pre-loading the REAL obsidian module via absolute
// filesystem path BEFORE registering our mock (which SPREADS the real exports
// and overrides only resolveVault + runSubagentWithRetry). The absolute-path
// import bypasses Bun's mock interception, so the real parseFrontmatter,
// validateZettelNote, graphDeadLinks, etc. flow through to sibling test files
// even when our mock leaks.
const _obsRealAbs = new URL(
	"../../pi-agent-ext-obsidian/src/index.ts",
	import.meta.url,
).pathname;
const _obsReal = await import(_obsRealAbs);

const mockObj = { ..._obsReal };
mockObj.runSubagentWithRetry = (...args) => {
	calls.push(args);
	return Promise.resolve(nextResult);
};
mockObj.resolveVault = async () => resolveVaultRet;
// Keep invalidateCache as a no-op so the mock does not touch the real
// module-level file/index caches during wiring tests.
mockObj.invalidateCache = () => {};
mockObj.toolAllowlist = (e, d) => d;
mockObj.registerDeterministicHealthCheck = () => {};

// MUST be registered before any import of pi-knowledge-card (which pulls
// runSubagentWithRetry and resolveVault from pi-obsidian at module-eval time).
mock.module("@repo/pi-agent-ext-obsidian", () => mockObj);

// --- load the extension + its pure builders/allowlists for comparison --------
const kc = await import("../extensions/knowledge-card.ts");
const {
	DISTILL_TOOLS,
	ADD_TOOLS,
	FIND_TOOLS,
	UPDATE_TOOLS,
	REMOVE_TOOLS,
	CHECK_TOOLS,
	RAG_TOOLS,
	buildDistillTask,
	buildAddTask,
	buildFindTask,
	buildUpdateTask,
	buildRemoveTask,
	CHECK_TASK,
	buildRagTask,
} = kc;

// zk_card now spawns via the injectable zkSpawn seam (① Phase 3); zk_ask still
// uses runSubagentWithRetry (Phase 4). Route zk_card's spawn through a recorder
// that returns the same `nextResult` the runner mock uses.
const zkSpawnCalls = [];
const zkSpawnMock = (opts) => {
	zkSpawnCalls.push(opts);
	return Promise.resolve(nextResult);
};
kc.__setZkSpawnForTest(zkSpawnMock);
const lastZkSpawnCall = () => zkSpawnCalls[zkSpawnCalls.length - 1];

// --- fake-pi to register the 3 zk_* tools -----------------------------------
function makeFakePi() {
	const tools = {};
	return {
		pi: {
			registerTool: (t) => {
				tools[t.name] = t;
			},
			registerCommand: () => {},
			on: () => {},
		},
		tools,
	};
}
const { pi, tools } = makeFakePi();
kc.default(pi);

const CWD = "/proj";
async function run(toolName, params, overrides = {}) {
	calls.length = 0;
	zkSpawnCalls.length = 0;
	nextResult = overrides.result ?? defaultOk();
	resolveVaultRet =
		overrides.vault ?? {
			name: "TestVault",
			path: "/tmp/v",
			source: "env",
			staleReason: undefined,
		};
	return await tools[toolName].execute("id", params, undefined, undefined, {
		cwd: CWD,
	});
}

// runSubagentWithRetry(cwd, systemPrompt, task, toolsCsv, signal, tmpPrefix, opts)
const lastCall = () => calls[calls.length - 1];

describe("zk_card — per-action wiring (zkSpawn seam)", () => {
	it("add → ADD_TOOLS + buildAddTask", async () => {
		await run("zk_card", { action: "add", content: "BODY", folder: "Inbox", force: true });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(ADD_TOOLS);
		expect(c.task.startsWith(buildAddTask("BODY", "Inbox", true))).toBe(true);
		expect(c.cwd).toBe(CWD);
	});

	it("find → FIND_TOOLS + buildFindTask", async () => {
		await run("zk_card", { action: "find", query: "Q", limit: 4, context_lines: 0 });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(FIND_TOOLS);
		expect(c.task.startsWith(buildFindTask("Q", 0, 4))).toBe(true);
	});

	it("update → UPDATE_TOOLS + buildUpdateTask", async () => {
		await run("zk_card", { action: "update", note: "n.md", content: "MORE" });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(UPDATE_TOOLS);
		expect(c.task.startsWith(buildUpdateTask("n.md", "MORE"))).toBe(true);
	});

	it("remove → REMOVE_TOOLS + buildRemoveTask", async () => {
		await run("zk_card", { action: "remove", note: "n.md", force: false });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(REMOVE_TOOLS);
		expect(c.task.startsWith(buildRemoveTask("n.md", false))).toBe(true);
	});

	it("check → CHECK_TOOLS + CHECK_TASK", async () => {
		await run("zk_card", { action: "check" });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(CHECK_TOOLS);
		expect(c.task.startsWith(CHECK_TASK)).toBe(true);
	});
});

describe("zk_ask — wiring + defaults (zkSpawn seam)", () => {
	it("passes RAG_TOOLS + buildRagTask with default args", async () => {
		await run("zk_ask", { question: "Why?" });
		const c = lastZkSpawnCall();
		expect(c.tools).toEqual(RAG_TOOLS);
		// defaults: depth=2, top_k=8, summarize=false, retrieveOnly=false,
		// maxNeighbors=5, maxNoteTokens=2000, noRefine=false, folder=undefined
		expect(c.task.startsWith(buildRagTask("Why?", 2, 8, false, false, 5, 2000, false, undefined))).toBe(true);
	});

	it("forwards explicit RAG params", async () => {
		await run("zk_ask", {
			question: "Why?",
			depth: 1,
			top_k: 3,
			max_neighbors: 2,
			max_note_tokens: 500,
			summarize: true,
			retrieve_only: true,
			no_refine: true,
			folder: "Notes",
		});
		expect(lastZkSpawnCall().task.startsWith(
			buildRagTask("Why?", 1, 3, true, true, 2, 500, true, "Notes"),
		)).toBe(true);
	});
});

describe("result shaping", () => {
	it("success prepends the vault header", async () => {
		const r = await run("zk_ask", { question: "Q" }, {
			result: { ...defaultOk(), output: "the answer" },
		});
		expect(r.isError).toBeUndefined();
		const text = r.content[0].text;
		expect(text.startsWith("vault: TestVault (/tmp/v) [env]")).toBe(true);
		expect(text.includes("the answer")).toBe(true);
		expect(r.details).toEqual({ status: "done" });
	});

	it("marks ⚠stale when resolveVault returns staleReason", async () => {
		const r = await run(
			"zk_card",
			{ action: "check" },
			{
				vault: {
					name: "V",
					path: "/tmp/v2",
					source: "walk",
					staleReason: "no vault found",
				},
			},
		);
		expect(r.content[0].text.includes("[walk] ⚠stale")).toBe(true);
	});

	it("a timedout failure → isError with output tail", async () => {
		const r = await run(
			"zk_card",
			{ action: "find", query: "q" },
			{
				result: {
					...defaultOk(),
					output: "x".repeat(3000),
					failure: { kind: "timedout", message: "boom" },
				},
			},
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text.includes("timed out")).toBe(true);
		// output is sliced to last 2000 chars
		expect(r.content[0].text.length).toBeLessThanOrEqual(
			"zk_card find timed out.\n".length + 2000,
		);
		expect(r.details).toEqual({ status: "timedout", error: "boom" });
	});

	it("a failure with no output → isError with the message tail", async () => {
		const r = await run(
			"zk_card",
			{ action: "find", query: "q" },
			{ result: { ...defaultOk(), output: "", failure: { kind: "failed", message: "y".repeat(3000) } } },
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text.includes("zk_card find failed.")).toBe(true);
		expect(r.details).toEqual({ status: "failed", error: "y".repeat(3000) });
	});

	it("a failure WITH output → still success (output shown)", async () => {
		// A failure with output present is treated as soft success.
		const r = await run(
			"zk_ask",
			{ question: "Q" },
			{ result: { ...defaultOk(), output: "partial result", failure: { kind: "failed", message: "partial" } } },
		);
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text.includes("partial result")).toBe(true);
		expect(r.details.status).toBe("failed");
	});
});
