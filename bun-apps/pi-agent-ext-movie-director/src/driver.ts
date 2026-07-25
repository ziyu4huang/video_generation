/**
 * driver.ts — the deterministic pipeline driver (state machine).
 *
 * A thin sequencer OVER the existing dispatch() core: it owns stage transitions,
 * checkpoint writing, the consent-flag approval policy, resume re-entry, and
 * retry-to-bound-then-abort. It does NOT reimplement pipeline logic — it talks
 * to core only via the injected `dispatchFn` (so it is unit-testable with a
 * fake and avoids any circular ESM import with dispatch.ts) and produces each
 * stage's artifact via the injected `produce` (wired to real dispatch + the
 * waypoint executors in Phase 3).
 *
 * Phase 1 scope: walking + checkpoints + approval + pause + resume +
 * pre-supplied skip + retry/abort. The assets-stage proactive encoder
 * (frames-from-duration, chaining) lives in the `produce` wiring (Phase 3).
 */
import { getStageOrder, getStage } from "./pipeline.ts";

export interface DriverOptions {
	// ── entry (discriminated by `topic` presence) ────────────────────────────
	/** Fresh run: start at stage 0. Mutually exclusive with resume. */
	topic?: string;
	/** Resume: re-enter at the first non-completed stage (read from checkpoints). */
	projectId?: string;
	/** Skip a stage's producer when its artifact is supplied; still validate + checkpoint. */
	preSuppliedArtifacts?: Record<string, unknown>;
	// ── run config ───────────────────────────────────────────────────────────
	pipeline: string; // default "animated-explainer" applied by the dispatch case
	model?: string;
	/** Stage names that must PAUSE for human review instead of auto-approving. */
	requireHumanApproval?: string[];
	/** Per-producer failure retries before aborting (default 3). */
	maxRetries?: number;
}

export interface DriverDeps {
	/** Core command channel (the existing dispatch()). Returns parsed-already JSON text. */
	dispatchFn: (
		command: string,
		opts: Record<string, unknown>,
	) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
	/** Produce ONE stage's artifacts {artifactName: data}. Throws on failure (retried). */
	produce: (
		stage: string,
		inputs: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
}

export type DriverResult =
	| { ok: true; status: "completed"; projectId: string; stages: string[]; finalMp4?: string }
	| { ok: true; status: "paused"; projectId: string; stage: string; reason: string }
	| { ok: false; status: "failed"; projectId: string; stage: string; reason: string };

const DEFAULT_MAX_RETRIES = 3;

export function slugifyTopic(topic: string): string {
	return (
		topic
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "project"
	);
}

/** Read the completed-stage set for a project via the dispatch channel. */
async function readCompletedStages(
	projectId: string,
	pipeline: string,
	deps: DriverDeps,
): Promise<Set<string>> {
	const res = await deps.dispatchFn("read-checkpoint", { projectId, pipeline });
	if (!res.ok) return new Set();
	try {
		const parsed = JSON.parse(res.text) as { completedStages?: string[] };
		return new Set(parsed.completedStages ?? []);
	} catch {
		return new Set();
	}
}

/** Read one completed stage's checkpointed artifacts (for resume — see below). */
async function readStageArtifacts(
	projectId: string,
	pipeline: string,
	stage: string,
	deps: DriverDeps,
): Promise<Record<string, unknown>> {
	const res = await deps.dispatchFn("read-checkpoint", { projectId, pipeline, stage });
	if (!res.ok) return {};
	try {
		const parsed = JSON.parse(res.text) as { checkpoint?: { artifacts?: Record<string, unknown> } | null };
		return parsed.checkpoint?.artifacts ?? {};
	} catch {
		return {};
	}
}

/**
 * Run the pipeline deterministically. Fresh when `topic` is set; resume when
 * only `projectId` is set. Walks stages in manifest order, producing each,
 * writing a checkpoint after each, honoring the consent-flag approval policy,
 * and aborting resumably when a producer exhausts its retry bound.
 */
export async function runPipeline(opts: DriverOptions, deps: DriverDeps): Promise<DriverResult> {
	const pipeline = opts.pipeline || "animated-explainer";
	const isFresh = opts.topic !== undefined;
	const projectId = opts.projectId ?? (isFresh ? slugifyTopic(opts.topic!) : undefined);
	if (!projectId) {
		return { ok: false, status: "failed", projectId: "", stage: "(entry)", reason: "no topic or projectId given" };
	}
	const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
	const requireHuman = new Set(opts.requireHumanApproval ?? []);

	const order = getStageOrder(pipeline);
	if (order.length === 0) {
		return { ok: false, status: "failed", projectId, stage: "(entry)", reason: `pipeline "${pipeline}" not loadable` };
	}

	// Resolve the start stage: fresh → first; resume → first non-completed.
	const completed = isFresh ? new Set<string>() : await readCompletedStages(projectId, pipeline, deps);
	const startIndex = order.findIndex((s) => !completed.has(s));
	if (startIndex === -1) {
		return { ok: true, status: "completed", projectId, stages: order };
	}

	// Gather the most recent artifact for each completed stage (producer inputs).
	// For Phase 1, inputs are best-effort (the producer receives whatever prior
	// artifacts the wiring resolves); the walker hands the stage name + a map of
	// supplied artifacts. Pre-supplied artifacts are merged in here.
	const inputArtifacts: Record<string, unknown> = { ...(opts.preSuppliedArtifacts ?? {}) };

	// On resume, stages before startIndex completed in a PRIOR process — this
	// process's inputArtifacts starts empty, so their artifact content (not just
	// their names, already known via `completed`) must be reloaded from disk or
	// every producer downstream of the resume point silently runs with missing
	// inputs (caught for real: the `assets` producer hard-fails with "missing
	// scene_plan input" on a resumed run whose scene_plan completed earlier).
	if (!isFresh) {
		for (const stage of order) {
			if (!completed.has(stage)) continue;
			const artifacts = await readStageArtifacts(projectId, pipeline, stage, deps);
			for (const [k, v] of Object.entries(artifacts)) inputArtifacts[k] = v;
		}
	}

	for (let i = startIndex; i < order.length; i++) {
		const stage = order[i]!;
		const meta = getStage(pipeline, stage);
		const produces = meta?.produces ?? [];

		// ── produce (with retry) OR use a pre-supplied artifact ──────────────
		let artifacts: Record<string, unknown> | undefined;
		const suppliedKey = produces.find((p) => opts.preSuppliedArtifacts && p in opts.preSuppliedArtifacts);
		if (suppliedKey !== undefined) {
			artifacts = { [suppliedKey]: opts.preSuppliedArtifacts![suppliedKey] };
		} else {
			// Bounded retry: produce may throw (transient MLX/provider/schema failure).
			// Heartbeat to stderr: run-pipeline otherwise emits nothing until the whole
			// run finishes, which is indistinguishable from a hang when a waypoint's
			// bounded pi sub-session takes minutes on a real model + web search.
			let lastErr: unknown;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				console.error(`[driver] stage=${stage} attempt=${attempt}/${maxRetries} start ${new Date().toISOString()}`);
				try {
					artifacts = await deps.produce(stage, { ...inputArtifacts, topic: opts.topic });
					console.error(`[driver] stage=${stage} attempt=${attempt}/${maxRetries} ok ${new Date().toISOString()}`);
					break;
				} catch (err) {
					lastErr = err;
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[driver] stage=${stage} attempt=${attempt}/${maxRetries} failed ${new Date().toISOString()}: ${msg}`);
				}
			}
			if (artifacts === undefined) {
				const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
				// Record the failure for resume visibility (best-effort).
				await deps.dispatchFn("write-checkpoint", {
					projectId,
					pipeline,
					stage,
					status: "in_progress",
					error: `producer exhausted ${maxRetries} retries: ${reason}`,
				});
				return { ok: false, status: "failed", projectId, stage, reason };
			}
		}

		// ── consent-flag approval ────────────────────────────────────────────
		const gated = meta?.human_approval_default === true;
		if (gated && requireHuman.has(stage)) {
			// Pause for human review: record the produced artifact in_progress.
			await deps.dispatchFn("write-checkpoint", {
				projectId,
				pipeline,
				stage,
				status: "in_progress",
				artifacts,
			});
			return { ok: true, status: "paused", projectId, stage, reason: `awaiting human approval for ${stage}` };
		}

		// ── commit the stage ─────────────────────────────────────────────────
		const cpRes = await deps.dispatchFn("write-checkpoint", {
			projectId,
			pipeline,
			stage,
			status: "completed",
			artifacts,
			humanApproved: gated, // auto-approve gated stages; non-gated → false (gate only enforces on gated)
		});
		if (!cpRes.ok) {
			return { ok: false, status: "failed", projectId, stage, reason: cpRes.error };
		}

		// Surface produced artifacts to later stages' producers.
		for (const [k, v] of Object.entries(artifacts)) inputArtifacts[k] = v;
	}

	return { ok: true, status: "completed", projectId, stages: order };
}
