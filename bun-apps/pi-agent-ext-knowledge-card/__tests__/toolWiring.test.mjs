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
		exitCode: 0,
		stderr: "",
		timedOut: false,
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
const obsidianExports = [
	"runSubagentWithRetry", "resolveVault",
	"__fileCacheOrder", "appendUnderHeading", "assertExtensionApi",
	"assertWithinVault", "assertWritablePath", "atomicWriteFile",
	"backlinkPaths", "buildIndex", "buildMatcher", "buildSubagentArgs",
	"computeFieldLabels", "deleteNote", "detectTitleStyleOutliers",
	"dropIndex", "findBacklinks", "findTagNotes", "fuzzyMatch",
	"getAdjacency", "getIndex", "graphDeadLinks", "graphNeighbors",
	"graphOrphans", "graphOutgoing", "invalidateCache", "isTransientError",
	"isWeakModel", "launcherForUri", "listVaultCandidates",
	"loadCachedIndex", "makeSubagentProgressLogger", "moveNote",
	"parseFrontmatter", "parseStructuredResult", "queryNotes",
	"readCached", "refreshIndex", "reindexFile", "resolveSubagentModel",
	"resolveVault", "resolveWikiLink", "rewriteLinksProtected",
	"runSubagent", "runSubagentWithRetry", "safeNotePath", "saveIndex",
	"scheduleVaultBanner", "searchVault", "serializeIndex", "tagPaths",
	"toolAllowlist", "trigramCandidates", "updateFrontmatter",
	"validateNoteIntegrity", "validateNoteIntegrityBatch",
	"validateZettelNote", "validateZettelNotes",
	"ZETTEL_MAX_BYTES", "ZETTEL_REQUIRED_KEYS",
];
const mockObj = {};
for (const name of obsidianExports) {
	mockObj[name] = async () => {};
}
mockObj.runSubagentWithRetry = (...args) => {
	calls.push(args);
	return Promise.resolve(nextResult);
};
mockObj.resolveVault = async () => resolveVaultRet;
mockObj.invalidateCache = () => {};
mockObj.toolAllowlist = (e, d) => d;
mockObj.parseFrontmatter = () => ({ data: {}, bodyStart: 0 });
mockObj.validateZettelNote = () => ({ ok: true, errors: [] });
mockObj.validateZettelNotes = async () => ({ valid: 0, invalid: [] });
mockObj.ZETTEL_MAX_BYTES = 64 * 1024;
mockObj.ZETTEL_REQUIRED_KEYS = ["id", "created", "tags"];
mockObj.fuzzyMatch = () => false;
mockObj.isWeakModel = () => false;
mockObj.isTransientError = () => false;

// MUST be registered before any import of pi-knowledge-card (which pulls
// runSubagentWithRetry and resolveVault from pi-obsidian at module-eval time).
mock.module("@repo/pi-agent-ext-obsidian/extensions/obsidian.ts", () => mockObj);

// --- load the extension + its pure builders/allowlists for comparison --------
const kc = await import("../extensions/pi-knowledge-card.ts");
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

describe("zk_card — per-action wiring", () => {
	it("add → ADD_TOOLS + pi-kc-add- + buildAddTask", async () => {
		await run("zk_card", { action: "add", content: "BODY", folder: "Inbox", force: true });
		const c = lastCall();
		expect(c[3]).toBe(ADD_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-add-");
		expect(c[2]).toBe(buildAddTask("BODY", "Inbox", true));
	});

	it("find → FIND_TOOLS + pi-kc-find- + buildFindTask", async () => {
		await run("zk_card", { action: "find", query: "Q", limit: 4, context_lines: 0 });
		const c = lastCall();
		expect(c[3]).toBe(FIND_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-find-");
		expect(c[2]).toBe(buildFindTask("Q", 0, 4));
	});

	it("update → UPDATE_TOOLS + pi-kc-update-", async () => {
		await run("zk_card", { action: "update", note: "n.md", content: "MORE" });
		const c = lastCall();
		expect(c[3]).toBe(UPDATE_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-update-");
		expect(c[2]).toBe(buildUpdateTask("n.md", "MORE"));
	});

	it("remove → REMOVE_TOOLS + pi-kc-remove-", async () => {
		await run("zk_card", { action: "remove", note: "n.md", force: false });
		const c = lastCall();
		expect(c[3]).toBe(REMOVE_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-remove-");
		expect(c[2]).toBe(buildRemoveTask("n.md", false));
	});

	it("check → CHECK_TOOLS + pi-kc-check- + CHECK_TASK", async () => {
		await run("zk_card", { action: "check" });
		const c = lastCall();
		expect(c[3]).toBe(CHECK_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-check-");
		expect(c[2]).toBe(CHECK_TASK);
	});
});

describe("zk_ask — wiring + defaults", () => {
	it("passes RAG_TOOLS + pi-kc-rag- + buildRagTask with default args", async () => {
		await run("zk_ask", { question: "Why?" });
		const c = lastCall();
		expect(c[3]).toBe(RAG_TOOLS.join(","));
		expect(c[5]).toBe("pi-kc-rag-");
		// defaults: depth=2, top_k=8, summarize=false, retrieveOnly=false,
		// maxNeighbors=5, maxNoteTokens=2000, noRefine=false, folder=undefined
		expect(c[2]).toBe(buildRagTask("Why?", 2, 8, false, false, 5, 2000, false, undefined));
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
		expect(lastCall()[2]).toBe(
			buildRagTask("Why?", 1, 3, true, true, 2, 500, true, "Notes"),
		);
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
		expect(r.details).toEqual({ exitCode: 0, stderr: "" });
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

	it("timedOut → isError with output tail", async () => {
		const r = await run(
			"zk_card",
			{ action: "find", query: "q" },
			{
				result: {
					...defaultOk(),
					timedOut: true,
					output: "x".repeat(3000),
					stderr: "boom",
				},
			},
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text.includes("timed out")).toBe(true);
		// output is sliced to last 2000 chars
		expect(r.content[0].text.length).toBeLessThanOrEqual(
			"zk_card find timed out.\n".length + 2000,
		);
		expect(r.details).toEqual({ timedOut: true, stderr: "boom" });
	});

	it("non-zero exit + no output → isError with stderr tail", async () => {
		const r = await run(
			"zk_card",
			{ action: "find", query: "q" },
			{ result: { ...defaultOk(), exitCode: 2, output: "", stderr: "y".repeat(3000) } },
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text.includes("failed (exit 2)")).toBe(true);
		expect(r.details).toEqual({ exitCode: 2, stderr: "y".repeat(3000) });
	});

	it("non-zero exit WITH output → still success (output shown)", async () => {
		// exitCode !== 0 but output present is treated as soft success.
		const r = await run(
			"zk_ask",
			{ question: "Q" },
			{ result: { ...defaultOk(), exitCode: 1, output: "partial result" } },
		);
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text.includes("partial result")).toBe(true);
		expect(r.details.exitCode).toBe(1);
	});
});
