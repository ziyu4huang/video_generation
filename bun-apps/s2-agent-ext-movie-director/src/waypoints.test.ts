/**
 * waypoints.test.ts — the scoped LLM producers, unit-tested against faked
 * completionFn / agentFn / validateFn (no real provider, no real pi session).
 */
import { describe, test, expect } from "bun:test";
import {
	runCompletionWaypoint,
	runAgentWaypoint,
	pickProducer,
	WaypointExhaustedError,
	type WaypointDeps,
} from "./waypoints.ts";

/** A completionFn stub: returns canned outputs in order, recording the prompts. */
function makeCompletion(outputs: string[]) {
	const calls: { system: string; user: string }[] = [];
	let i = 0;
	const completionFn: WaypointDeps["completionFn"] = async (system, user) => {
		calls.push({ system, user });
		return outputs[Math.min(i++, outputs.length - 1)]!;
	};
	return { completionFn, calls };
}

const VALIDATE_OK = async () => ({ valid: true });
const VALIDATE_BAD = async () => ({ valid: false, errors: "data_points: minItems 3 not satisfied" });

describe("runCompletionWaypoint", () => {
	test("valid JSON passes on the first try", async () => {
		const { completionFn, calls } = makeCompletion([JSON.stringify({ data_points: [1, 2, 3] })]);
		const artifact = await runCompletionWaypoint(
			"proposal",
			{ topic: "x" },
			{ completionFn, validateFn: VALIDATE_OK },
			3,
		);
		expect(artifact).toEqual({ data_points: [1, 2, 3] });
		expect(calls).toHaveLength(1);
	});

	test("schema-invalid → retries with the ajv errors fed back, then throws WaypointExhaustedError", async () => {
		const { completionFn, calls } = makeCompletion([JSON.stringify({ data_points: [] }), JSON.stringify({ data_points: [] })]);
		await expect(
			runCompletionWaypoint("proposal", { topic: "x" }, { completionFn, validateFn: VALIDATE_BAD }, 2),
		).rejects.toBeInstanceOf(WaypointExhaustedError);
		expect(calls).toHaveLength(2);
		// the 2nd attempt's prompt must carry the validation errors (feedback loop)
		expect(calls[1]!.user).toContain("data_points: minItems 3 not satisfied");
	});

	test("schema-invalid then recovers within the bound → returns the recovered artifact", async () => {
		const { completionFn, calls } = makeCompletion([
			JSON.stringify({ data_points: [] }),
			JSON.stringify({ data_points: [1, 2, 3] }),
		]);
		const artifact = await runCompletionWaypoint(
			"proposal",
			{ topic: "x" },
			{ completionFn, validateFn: async (_a, data) => (Array.isArray((data as any)?.data_points) && (data as any).data_points.length >= 3 ? { valid: true } : { valid: false, errors: "too few" }) },
			3,
		);
		expect((artifact as any).data_points).toHaveLength(3);
		expect(calls).toHaveLength(2);
	});

	test("system prompt names the target schema + stage skill", async () => {
		const { completionFn, calls } = makeCompletion([JSON.stringify({ ok: true })]);
		await runCompletionWaypoint("script", { topic: "x" }, { completionFn, validateFn: VALIDATE_OK }, 1);
		expect(calls[0]!.system).toContain("script");
	});
});

describe("runAgentWaypoint", () => {
	test("research → agentFn called with a scoped toolset that includes web_search", async () => {
		const calls: { toolset: string[] }[] = [];
		const agentFn: WaypointDeps["agentFn"] = async (_s, _u, opts) => {
			calls.push({ toolset: opts.toolset });
			return JSON.stringify({ data_points: [1, 2, 3] });
		};
		const artifact = await runAgentWaypoint(
			"research",
			{ topic: "ancient quasars" },
			{ agentFn, validateFn: VALIDATE_OK },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.toolset).toContain("web_search");
		expect((artifact as any).data_points).toHaveLength(3);
	});
});

describe("clean-to-schema wiring (produceAndValidate)", () => {
	test("dirty LLM output with extra fields is cleaned before validation → passes in one call", async () => {
		// A strict schema: object with one declared property, additionalProperties:false.
		const schema = {
			type: "object",
			additionalProperties: false,
			properties: { status: { type: "string" } },
			required: ["status"],
		};
		// completionFn returns a DIRTY object (stray field) that would fail additionalProperties:false.
		const { completionFn, calls } = makeCompletion([JSON.stringify({ status: "approved", stray: "drop me" })]);
		// validateFn is a strict validator: any key not 'status' → invalid (mirrors ajv additionalProperties:false).
		const validateFn: WaypointDeps["validateFn"] = async (_a, data) => {
			const keys = Object.keys(data as object);
			return keys.every((k) => k === "status") && typeof (data as Record<string, unknown>).status === "string"
				? { valid: true }
				: { valid: false, errors: "additional properties not allowed" };
		};
		const artifact = await runCompletionWaypoint(
			"proposal",
			{ topic: "x" },
			{ completionFn, validateFn, schemaFor: () => schema },
			1,
		);
		expect(artifact).toEqual({ status: "approved" }); // stray stripped by the safety net
		expect(calls).toHaveLength(1); // no retry needed — clean fixed it on the first parse
	});

	test("without schemaFor, dirty output is NOT cleaned → validateFn sees it raw → exhausts (opt-in)", async () => {
		const { completionFn } = makeCompletion([JSON.stringify({ status: "approved", stray: "drop me" })]);
		const validateFn: WaypointDeps["validateFn"] = async (_a, data) =>
			Object.keys(data as object).every((k) => k === "status") ? { valid: true } : { valid: false, errors: "extra" };
		await expect(
			runCompletionWaypoint("proposal", { topic: "x" }, { completionFn, validateFn }, 1),
		).rejects.toBeInstanceOf(WaypointExhaustedError);
	});
});

describe("markdown-fenced JSON output (produceAndValidate)", () => {
	test("output wrapped in a ```json fence is still parsed and validated (deepseek-v4-flash behavior)", async () => {
		const fenced = "```json\n" + JSON.stringify({ data_points: [1, 2, 3] }, null, 2) + "\n```";
		const { completionFn, calls } = makeCompletion([fenced]);
		const artifact = await runCompletionWaypoint("proposal", { topic: "x" }, { completionFn, validateFn: VALIDATE_OK }, 1);
		expect(artifact).toEqual({ data_points: [1, 2, 3] });
		expect(calls).toHaveLength(1); // no retry burned on the fence alone
	});

	test("output wrapped in a bare ``` fence (no language tag) is also parsed", async () => {
		const fenced = "```\n" + JSON.stringify({ data_points: [1, 2, 3] }) + "\n```";
		const { completionFn } = makeCompletion([fenced]);
		const artifact = await runCompletionWaypoint("proposal", { topic: "x" }, { completionFn, validateFn: VALIDATE_OK }, 1);
		expect(artifact).toEqual({ data_points: [1, 2, 3] });
	});

	test("exhausted-retries error includes the last attempt's feedback, not just the bare count", async () => {
		const { completionFn } = makeCompletion(["not json at all", "still not json"]);
		await expect(
			runCompletionWaypoint("proposal", { topic: "x" }, { completionFn, validateFn: VALIDATE_OK }, 2),
		).rejects.toThrow(/exhausted 2 retries\. Last attempt: Previous output was not valid JSON/);
	});
});

describe("pickProducer", () => {
	test("maps each stage to its producer type", () => {
		expect(pickProducer("research")).toBe("agent");
		expect(pickProducer("proposal")).toBe("completion");
		expect(pickProducer("script")).toBe("completion");
		expect(pickProducer("scene_plan")).toBe("completion");
		expect(pickProducer("edit")).toBe("mechanical");
		expect(pickProducer("assets")).toBe("mechanical");
		expect(pickProducer("compose")).toBe("mechanical");
		expect(pickProducer("publish")).toBe("mechanical");
	});
});
