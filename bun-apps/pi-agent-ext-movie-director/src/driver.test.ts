/**
 * driver.test.ts — the deterministic state machine, unit-tested against a
 * FAKED dispatchFn + produce (no LLM, no MLX, no real checkpoint files).
 *
 * Phase 1 scope: stage walking, checkpoint-after-every-stage, consent-flag
 * approval, pause-for-review, resume re-entry, pre-supplied-artifact skip,
 * and retry-to-bound-then-abort. (frames/chaining live in Phase 3 — they test
 * the assets producer, not the walker.)
 */
import { describe, test, expect } from "bun:test";
import { runPipeline, type DriverDeps, type DriverResult } from "./driver.ts";

/** In-memory fake dispatch: records calls + stores checkpoints per (project,stage). */
function makeFakeWorld() {
	const checkpoints = new Map<string, Record<string, unknown>>();
	const calls: { command: string; opts: Record<string, unknown> }[] = [];

	const dispatchFn: DriverDeps["dispatchFn"] = async (command, opts) => {
		calls.push({ command, opts });
		const key = `${opts.projectId}:${opts.stage}`;
		if (command === "write-checkpoint") {
			checkpoints.set(key, opts);
			return { ok: true, text: JSON.stringify({ recorded: true, stage: opts.stage }) };
		}
		if (command === "read-checkpoint") {
			const forProject = [...checkpoints.entries()].filter(([k]) => k.startsWith(`${opts.projectId}:`));
			const completed = forProject.filter(([, v]) => v.status === "completed").map(([k]) => k.split(":")[1]!);
			let checkpoint: Record<string, unknown> | null = null;
			if (opts.stage) {
				const cp = checkpoints.get(`${opts.projectId}:${opts.stage}`);
				checkpoint = cp ? { stage: cp.stage, status: cp.status, artifacts: cp.artifacts ?? {} } : null;
			}
			return { ok: true, text: JSON.stringify({ checkpoint, completedStages: completed }) };
		}
		if (command === "validate-artifact") {
			return { ok: true, text: JSON.stringify({ valid: true }) };
		}
		// mechanical commands (generate/compose/...) are driven via `produce` in
		// Phase 1 — the fake never sees them; if it does, default to success.
		return { ok: true, text: JSON.stringify({ ok: true }) };
	};
	return { dispatchFn, checkpoints, calls };
}

/** A produce stub that returns a valid artifact map per stage, keyable to fail. */
function makeProduce(stages: string[], opts: { failStage?: string; failTimes?: number } = {}) {
	let attempts = 0;
	const produce: DriverDeps["produce"] = async (stage) => {
		if (opts.failStage === stage) {
			attempts += 1;
			if (attempts <= (opts.failTimes ?? Infinity)) {
				throw new Error(`synthetic produce failure on ${stage} (attempt ${attempts})`);
			}
		}
		return { [`${stage}_artifact`]: { stage, ok: true } };
	};
	return { produce, attempts: () => attempts };
}

const STAGES = ["research", "proposal", "script", "scene_plan", "assets", "edit", "compose", "publish"];
const GATED = new Set(["proposal", "script", "scene_plan", "assets", "publish"]);

describe("runPipeline — stage walking", () => {
	test("fresh topic walks all 8 stages in order", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES);
		const res = await runPipeline(
			{ projectId: "demo", topic: "how black holes grow", pipeline: "animated-explainer" },
			{ dispatchFn: world.dispatchFn, produce },
		);
		expect((res as Extract<DriverResult, { status: "completed" }>).status).toBe("completed");
		expect((res as any).stages).toEqual(STAGES);
		// exactly one completed write-checkpoint per stage, in stage order
		const writes = world.calls.filter((c) => c.command === "write-checkpoint");
		expect(writes.map((w) => w.opts.stage)).toEqual(STAGES);
		expect(writes.every((w) => w.opts.status === "completed")).toBe(true);
	});

	test("writes a completed checkpoint after every stage", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES);
		await runPipeline({ projectId: "demo", topic: "x", pipeline: "animated-explainer" }, { dispatchFn: world.dispatchFn, produce });
		for (const s of STAGES) {
			expect(world.checkpoints.get(`demo:${s}`)?.status === "completed").toBe(true);
		}
	});
});

describe("runPipeline — consent-flag approval", () => {
	test("human-gated stage NOT in requireHumanApproval → write-checkpoint with humanApproved=true", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES);
		await runPipeline({ projectId: "demo", topic: "x", pipeline: "animated-explainer" }, { dispatchFn: world.dispatchFn, produce });
		for (const s of STAGES) {
			const cp = world.checkpoints.get(`demo:${s}`);
			if (GATED.has(s)) expect(cp?.humanApproved).toBe(true);
		}
	});

	test("human-gated stage IN requireHumanApproval → pauses with status:paused + in_progress checkpoint", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES);
		const res = await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", requireHumanApproval: ["script"] },
			{ dispatchFn: world.dispatchFn, produce },
		);
		const paused = res as Extract<DriverResult, { status: "paused" }>;
		expect(paused.status).toBe("paused");
		expect(paused.stage).toBe("script");
		// research + proposal completed before the pause at script
		expect(world.checkpoints.get("demo:research")?.status).toBe("completed");
		expect(world.checkpoints.get("demo:proposal")?.status).toBe("completed");
		// script itself is in_progress (not completed), awaiting human review
		expect(world.checkpoints.get("demo:script")?.status).toBe("in_progress");
		expect(world.checkpoints.get("demo:script")).toBeTruthy();
	});
});

describe("runPipeline — resume", () => {
	test("resume via projectId re-enters at the first non-completed stage", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES);
		// first run pauses at script (requireHumanApproval)
		await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", requireHumanApproval: ["script"] },
			{ dispatchFn: world.dispatchFn, produce },
		);
		// simulate human approval: mark script completed out-of-band
		world.checkpoints.get("demo:script")!.status = "completed";
		// resume WITHOUT the require flag → should start at scene_plan and finish
		const res = await runPipeline(
			{ projectId: "demo", pipeline: "animated-explainer" },
			{ dispatchFn: world.dispatchFn, produce },
		);
		expect((res as Extract<DriverResult, { status: "completed" }>).status).toBe("completed");
		// it must NOT re-run research/proposal/script (already completed)
		const writes = world.calls.filter((c) => c.command === "write-checkpoint" && c.opts.status === "completed");
		const secondRunStages = writes.map((w) => w.opts.stage).filter((s) => ["scene_plan", "assets", "edit", "compose", "publish"].includes(s as string));
		expect(secondRunStages).toEqual(["scene_plan", "assets", "edit", "compose", "publish"]);
	});
});

describe("runPipeline — resume reloads prior artifacts", () => {
	test("resume merges completed stages' checkpointed artifacts into producer inputs", async () => {
		const world = makeFakeWorld();
		const { produce: produce1 } = makeProduce(STAGES);
		// first run pauses at script (requireHumanApproval) — research/proposal complete
		// in THIS process, so their artifacts flow via the in-memory inputArtifacts map.
		await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", requireHumanApproval: ["script"] },
			{ dispatchFn: world.dispatchFn, produce: produce1 },
		);
		world.checkpoints.get("demo:script")!.status = "completed";

		// Second run is a FRESH runPipeline() call — simulating a new process with no
		// carried-over in-memory state (only the on-disk checkpoints survive). Regression:
		// the driver only reloaded completed stages' NAMES on resume, never their artifact
		// CONTENT, so producers downstream of the resume point silently ran with empty
		// inputs — caught for real when the `assets` stage's producer hard-fails with
		// "missing scene_plan input" on a resumed run.
		const seenInputs: Record<string, unknown>[] = [];
		const produce2: DriverDeps["produce"] = async (stage, inputs) => {
			seenInputs.push({ stage, ...inputs });
			return { [`${stage}_artifact`]: { stage, ok: true } };
		};
		const res = await runPipeline({ projectId: "demo", pipeline: "animated-explainer" }, { dispatchFn: world.dispatchFn, produce: produce2 });
		expect((res as Extract<DriverResult, { status: "completed" }>).status).toBe("completed");

		// scene_plan is the first stage produced in THIS process — it must still see
		// research/proposal/script artifacts even though this process never produced them.
		const sceneInputs = seenInputs.find((c) => c.stage === "scene_plan")!;
		expect(sceneInputs.research_artifact).toBeTruthy();
		expect(sceneInputs.proposal_artifact).toBeTruthy();
		expect(sceneInputs.script_artifact).toBeTruthy();
	});
});

describe("runPipeline — pre-supplied artifacts", () => {
	test("preSuppliedArtifacts skips that stage's producer but still validates + checkpoints it", async () => {
		const world = makeFakeWorld();
		const producedStages = new Set<string>();
		const produce: DriverDeps["produce"] = async (stage) => {
			producedStages.add(stage);
			return { [`${stage}_artifact`]: { ok: true } };
		};
		const res = await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", preSuppliedArtifacts: { research_brief: { data_points: [] } } },
			{ dispatchFn: world.dispatchFn, produce },
		);
		expect((res as any).status).toBe("completed");
		expect(producedStages.has("research")).toBe(false); // research producer never ran
		expect(producedStages.has("proposal")).toBe(true); // later stages still produced
		// research still got a completed checkpoint carrying the supplied artifact
		expect(world.checkpoints.get("demo:research")?.status).toBe("completed");
	});
});

describe("runPipeline — retry to bound, then abort", () => {
	test("producer failure retries maxRetries then aborts with status:failed + failed checkpoint", async () => {
		const world = makeFakeWorld();
		const { produce, attempts } = makeProduce(STAGES, { failStage: "script", failTimes: 99 });
		const res = await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", maxRetries: 3 },
			{ dispatchFn: world.dispatchFn, produce },
		);
		const failed = res as Extract<DriverResult, { status: "failed" }>;
		expect(failed.status).toBe("failed");
		expect(failed.stage).toBe("script");
		// exactly maxRetries attempts (not infinite)
		expect(attempts()).toBe(3);
		// research + proposal completed before the failure at script
		expect(world.checkpoints.get("demo:research")?.status).toBe("completed");
		expect(world.checkpoints.get("demo:proposal")?.status).toBe("completed");
	});

	test("transient failure within the retry bound eventually succeeds", async () => {
		const world = makeFakeWorld();
		const { produce } = makeProduce(STAGES, { failStage: "proposal", failTimes: 2 });
		const res = await runPipeline(
			{ projectId: "demo", topic: "x", pipeline: "animated-explainer", maxRetries: 3 },
			{ dispatchFn: world.dispatchFn, produce },
		);
		expect((res as Extract<DriverResult, { status: "completed" }>).status).toBe("completed");
	});
});
