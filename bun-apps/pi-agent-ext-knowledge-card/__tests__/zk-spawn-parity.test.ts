import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import piKnowledgeCardExtension, {
	__setZkSpawnForTest,
	resolveDistillModel,
	DISTILL_MODEL_DEFAULT,
	ADD_TOOLS,
	FIND_TOOLS,
	UPDATE_TOOLS,
	REMOVE_TOOLS,
	CHECK_TOOLS,
} from "../extensions/knowledge-card.ts";

/** Minimal pi double that captures registered tools. Returns { pi, tools }. */
function mkPi() {
	const tools = new Map<string, any>();
	const pi: any = {
		registerTool: (t: any) => {
			tools.set(t.name, t);
		},
		on() {},
		events: { on() {}, emit() {} },
	};
	return { pi, tools };
}

const CTX = { cwd: "/" } as any;

describe("zk_card spawn migration (① Phase 3 parity)", () => {
	let calls: any[];
	beforeEach(() => {
		calls = [];
		__setZkSpawnForTest(async (opts: any) => {
			calls.push(opts);
			return { output: "SUBAGENT_OUTPUT" };
		});
	});
	afterEach(() => __setZkSpawnForTest(null));

	it("routes each action through zkSpawn with the correct frozen allowlist", async () => {
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");

		await zkCard.execute("id", { action: "add", content: "note body" }, undefined, undefined, CTX);
		assert.deepEqual(calls.at(-1)!.tools, ADD_TOOLS, "add → ADD_TOOLS");
		assert.match(calls.at(-1)!.task, /Add the following content/);

		await zkCard.execute("id", { action: "find", query: "loRA" }, undefined, undefined, CTX);
		assert.deepEqual(calls.at(-1)!.tools, FIND_TOOLS, "find → FIND_TOOLS");

		await zkCard.execute("id", { action: "update", note: "Zettelkasten/X.md", content: "more" }, undefined, undefined, CTX);
		assert.deepEqual(calls.at(-1)!.tools, UPDATE_TOOLS, "update → UPDATE_TOOLS");

		await zkCard.execute("id", { action: "remove", note: "Zettelkasten/X.md" }, undefined, undefined, CTX);
		assert.deepEqual(calls.at(-1)!.tools, REMOVE_TOOLS, "remove → REMOVE_TOOLS");

		await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		assert.deepEqual(calls.at(-1)!.tools, CHECK_TOOLS, "check → CHECK_TOOLS");
	});

	it("passes model + excludeTools through; returns the subagent output (shape parity)", async () => {
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");
		const res: any = await zkCard.execute(
			"id",
			{ action: "check", model: "openai/gpt-5", exclude_tools: ["bash"] },
			undefined,
			undefined,
			CTX,
		);
		assert.equal(calls.at(-1)!.model, "openai/gpt-5");
		assert.deepEqual(calls.at(-1)!.excludeTools, ["bash"]);
		assert.equal(res.isError, undefined, "success path is not an error");
		assert.match(res.content[0].text, /SUBAGENT_OUTPUT/, "subagent output reaches the result");
		assert.deepEqual(res.details, { status: "done" }, "details shape preserved");
	});

	it("a timedout failure → isError result with the timed-out message (branch parity)", async () => {
		__setZkSpawnForTest(async () => ({ output: "partial", failure: { kind: "timedout", message: "timeout" } }));
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");
		const res: any = await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /timed out/i);
		assert.deepEqual(res.details, { status: "timedout", error: "timeout" });
	});

	it("a failure with no output → isError failure branch (branch parity)", async () => {
		__setZkSpawnForTest(async () => ({ output: "", failure: { kind: "failed", message: "boom" } }));
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");
		const res: any = await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /boom/);
		assert.deepEqual(res.details, { status: "failed", error: "boom" });
	});
});

describe("zk_* role-aware dispatch bounds (writer/recon envelopes at the zk seam)", () => {
	const ENV_KEY = "SUBAGENT_TOKEN_BUDGET_DISABLE";
	let prev: string | undefined;
	let calls: any[];
	beforeEach(() => {
		prev = process.env[ENV_KEY];
		delete process.env[ENV_KEY];
		calls = [];
		__setZkSpawnForTest(async (opts: any) => {
			calls.push(opts);
			return { output: "SUBAGENT_OUTPUT" };
		});
	});
	afterEach(() => {
		__setZkSpawnForTest(null);
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	});

	it("zk_card gets writer bounds, zk_ask gets recon bounds; SUBAGENT_TOKEN_BUDGET_DISABLE strips both", async () => {
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");
		const zkAsk: any = tools.get("zk_ask");

		// writer envelope: zk_card → zkRoleBounds("writer") → roleAwareDefaults({}, "writer")
		await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		assert.deepEqual(
			{
				tokenBudget: calls.at(-1)!.tokenBudget,
				maxTurns: calls.at(-1)!.maxTurns,
				timeoutMs: calls.at(-1)!.timeoutMs,
			},
			{ tokenBudget: 400_000, maxTurns: 28, timeoutMs: 1_200_000 },
			"zk_card → writer bounds 400k / 28 turns / 20 min",
		);

		// recon envelope: zk_ask → zkRoleBounds("recon") → roleAwareDefaults({}, "recon")
		await zkAsk.execute("id", { question: "what is a zettel?" }, undefined, undefined, CTX);
		assert.deepEqual(
			{
				tokenBudget: calls.at(-1)!.tokenBudget,
				maxTurns: calls.at(-1)!.maxTurns,
				timeoutMs: calls.at(-1)!.timeoutMs,
		},
			{ tokenBudget: 120_000, maxTurns: 12, timeoutMs: 300_000 },
			"zk_ask → recon bounds 120k / 12 turns / 5 min",
		);

		// global escape hatch: envelope absent entirely (no partial leftovers)
		process.env[ENV_KEY] = "1";
		await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		await zkAsk.execute("id", { question: "what is a zettel?" }, undefined, undefined, CTX);
		for (const [label, opts] of [
			["zk_card", calls.at(-2)],
			["zk_ask", calls.at(-1)],
		] as const) {
			assert.equal(opts.tokenBudget, undefined, `${label}: tokenBudget absent under disable`);
			assert.equal(opts.maxTurns, undefined, `${label}: maxTurns absent under disable`);
			assert.equal(opts.timeoutMs, undefined, `${label}: timeoutMs absent under disable`);
		}
	});
});

describe("resolveDistillModel precedence (explicit arg > KC_SUBAGENT_MODEL env > default)", () => {
	const ENV_KEY = "KC_SUBAGENT_MODEL";
	let prev: string | undefined;
	beforeEach(() => {
		prev = process.env[ENV_KEY];
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = prev;
	});

	it("DISTILL_MODEL_DEFAULT is the local LM Studio gemma", () => {
		assert.equal(DISTILL_MODEL_DEFAULT, "google/gemma-4-12b");
	});

	it("returns the explicit arg when provided (wins over env + default)", () => {
		process.env[ENV_KEY] = "env/override";
		assert.equal(resolveDistillModel("explicit/x"), "explicit/x");
	});

	it("falls back to KC_SUBAGENT_MODEL env when no explicit arg", () => {
		process.env[ENV_KEY] = "env/override";
		assert.equal(resolveDistillModel(undefined), "env/override");
	});

	it("falls back to the hardcoded default when neither arg nor env set", () => {
		delete process.env[ENV_KEY];
		assert.equal(resolveDistillModel(undefined), "google/gemma-4-12b");
	});

	it("zk_card spawn receives the resolved default model when no explicit arg", async () => {
		const calls: any[] = [];
		__setZkSpawnForTest(async (opts: any) => {
			calls.push(opts);
			return { output: "OK" };
		});
		delete process.env[ENV_KEY];
		const { pi, tools } = mkPi();
		piKnowledgeCardExtension(pi);
		const zkCard: any = tools.get("zk_card");
		await zkCard.execute("id", { action: "check" }, undefined, undefined, CTX);
		assert.equal(calls.at(-1)!.model, "google/gemma-4-12b");
		__setZkSpawnForTest(null);
	});
});
