/**
 * driver-wiring.ts — connect the driver's `produce` to real producers.
 *
 * Routes each stage via pickProducer():
 *   • agent        (research)        → runAgentWaypoint
 *   • completion   (proposal/script/scene_plan/edit) → runCompletionWaypoint
 *   • mechanical   (assets/compose/publish)          → dispatch()
 *
 * The assets stage EXECUTES the proactive plan from assets-encoder.ts: each
 * generate call carries frames computed from the scene's real duration, and
 * chained I2V links continue from the prior clip's last frame (extractLastFrame,
 * injectable so the chaining is unit-testable without ffmpeg).
 */
import { runCompletionWaypoint, runAgentWaypoint, pickProducer, type WaypointDeps } from "./waypoints.ts";
import { planAssetGeneration, type AssetGenCall } from "./assets-encoder.ts";

export type DispatchLike = (
	command: string,
	opts: Record<string, unknown>,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

/** Canonical artifact name each stage produces (the driver checkpoint key). */
const ARTIFACT_FOR: Record<string, string> = {
	research: "research_brief",
	proposal: "proposal_packet",
	script: "script",
	scene_plan: "scene_plan",
	edit: "edit_decisions",
	assets: "asset_manifest",
	compose: "render_report",
	publish: "publish_log",
};

export interface WireDeps {
	dispatchFn: DispatchLike;
	waypointDeps: WaypointDeps;
	projectId: string;
	pipeline?: string;
	fps?: number;
	maxCallSeconds?: number;
	/** Extract the last frame of a generated clip → PNG path (ffmpeg at runtime; injected in tests). */
	extractLastFrame?: (clipPath: string) => Promise<string>;
	/** Probe a clip's REAL duration in seconds (ffprobe at runtime; injected in tests).
	 *  The deterministic edit uses this so each cut's out_seconds matches the actual
	 *  generated clip, not the planned frames/fps (LTX over/under-generates). */
	probeDuration?: (path: string) => Promise<number>;
}

/** Build the per-stage `produce` the driver consumes. */
export function wireProduce(deps: WireDeps) {
	const fps = deps.fps ?? 25;
	const maxCallSeconds = deps.maxCallSeconds ?? 8;
	return async (stage: string, inputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const kind = pickProducer(stage);
		if (kind === "agent") {
			const art = await runAgentWaypoint(stage, inputs, deps.waypointDeps);
			return { [ARTIFACT_FOR[stage] ?? stage]: art };
		}
		if (kind === "completion") {
			const art = await runCompletionWaypoint(stage, inputs, deps.waypointDeps);
			return { [ARTIFACT_FOR[stage] ?? stage]: art };
		}
		if (stage === "assets") return produceAssets(deps, fps, maxCallSeconds, inputs);
		if (stage === "edit") return produceEdit(deps, inputs);
		if (stage === "compose") return produceCompose(deps, inputs);
		if (stage === "publish") return producePublish(deps, inputs);
		throw new Error(`wireProduce: no producer for stage "${stage}"`);
	};
}

/** Pull the first produced file path out of a generate result (shape varies by director). */
function firstArtifactPath(result: unknown): string | undefined {
	const r = result as { result?: { artifacts?: Array<{ path?: string }> }; artifacts?: Array<{ path?: string }> };
	return r?.result?.artifacts?.[0]?.path ?? r?.artifacts?.[0]?.path;
}

/** Extract the rendered mp4 path from a compose render_report — robust to either
 *  `output` (singular) or `outputs[0].path` (the real compose-motion shape). */
function renderMp4Path(rr: Record<string, unknown> | undefined): string | undefined {
	if (!rr) return undefined;
	if (typeof rr.output === "string") return rr.output;
	const outs = rr.outputs as Array<{ path?: string }> | undefined;
	return outs?.[0]?.path;
}

/** Execute the proactive asset plan via generate calls, chaining I2V links. */
async function produceAssets(
	deps: WireDeps,
	fps: number,
	maxCallSeconds: number,
	inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const scenePlan = inputs.scene_plan as { scenes: unknown[] } | undefined;
	const script = inputs.script as Record<string, unknown> | undefined;
	if (!scenePlan) throw new Error("assets: missing scene_plan input");
	const plan = planAssetGeneration(scenePlan as never, script as never, { fps, maxCallSeconds });

	const assets: Array<Record<string, unknown>> = [];
	const lastFrameByScene: Record<string, string> = {};
	const extract = deps.extractLastFrame;

	for (const call of plan.calls) {
		const options: Record<string, unknown> = { ...call.options };
		// Chaining: a non-first I2V link continues from the prior clip's last frame.
		if (
			call.capability === "video_generation" &&
			call.chainIndex &&
			call.chainIndex > 0 &&
			call.sceneId &&
			lastFrameByScene[call.sceneId]
		) {
			options.image = lastFrameByScene[call.sceneId];
		}
		const res = await deps.dispatchFn("generate", {
			capability: call.capability,
			command: call.command,
			options,
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate ${call.command} failed: ${res.error}`);
		const parsed = JSON.parse(res.text) as { provider?: string; result?: { artifacts?: Array<{ path?: string }> } };
		const outPath = firstArtifactPath(parsed) ?? "";
		// Shape each asset to the canonical asset_manifest schema: required
		// id/type/path/source_tool/scene_id + optional prompt/duration_seconds/
		// generation_summary, and NOTHING else (the schema is additionalProperties:false).
		// AssetGenCall.capability is only "video_generation" | "tts" (assets-encoder.ts
		// never plans an "image_generation" call), so this reduces to those two cases.
		const isNarration = call.capability === "tts";
		const type = isNarration ? "narration" : "video";
		const frames = Number((call.options as Record<string, unknown>)?.frames ?? 0);
		const asset: Record<string, unknown> = {
			id: isNarration ? "narration" : `${call.sceneId}-${call.chainIndex ?? 0}`,
			type,
			path: outPath,
			source_tool: parsed.provider ?? call.command,
			scene_id: call.sceneId ?? "",
			generation_summary: `generated via ${call.command} (chain ${call.chainIndex ?? 0})`,
		};
		if (typeof (call.options as Record<string, unknown>)?.prompt === "string") asset.prompt = (call.options as Record<string, unknown>).prompt;
		if (frames > 0 && fps > 0) asset.duration_seconds = Math.round((frames / fps) * 1000) / 1000;
		assets.push(asset);
		if (call.capability === "video_generation" && outPath && extract && call.sceneId) {
			try {
				lastFrameByScene[call.sceneId] = await extract(outPath);
			} catch {
				/* best-effort: a missing continuation frame just yields independent clips */
			}
		}
	}
	return { asset_manifest: { version: "1.0", assets } };
}

/** The script's narration mode (for final-review: 'none' scores a silent track as warn). */
function narrationMode(script: Record<string, unknown> | undefined): "none" | "voiced" | undefined {
	const n = script?.narration;
	return n === "none" || n === "voiced" ? (n as "none" | "voiced") : undefined;
}

/** edit → deterministic edit_decisions: one cut per video clip at its REAL
 *  (probed) duration, concatenated in manifest order. No LLM — the driver owns
 *  this like the assets encoder, so every cut fits its source (defeats
 *  cut_duration_vs_source; the frozen-frame failure cannot occur by construction). */
async function produceEdit(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const manifest = inputs.asset_manifest as { assets?: Array<{ type?: string; path?: string; duration_seconds?: number }> } | undefined;
	if (!manifest?.assets) throw new Error("edit: missing asset_manifest input");
	const cuts: Array<Record<string, unknown>> = [];
	let i = 0;
	for (const a of manifest.assets) {
		if (a.type !== "video" || !a.path) continue;
		i++;
		const dur = deps.probeDuration ? await deps.probeDuration(a.path) : Number(a.duration_seconds ?? 0);
		cuts.push({ id: `cut-${i}`, source: a.path, in_seconds: 0, out_seconds: dur });
	}
	return { edit_decisions: { version: "1.0", render_runtime: "ffmpeg", cuts } };
}

/** compose → compose-motion (render_report) + final-review (final_review). */
async function produceCompose(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const edit = inputs.edit_decisions as Record<string, unknown> | undefined;
	if (!edit) throw new Error("compose: missing edit_decisions input");
	const res = await deps.dispatchFn("compose-motion", {
		editDecisions: edit,
		projectId: deps.projectId,
		render_runtime: "ffmpeg",
	});
	if (!res.ok) throw new Error(`compose-motion failed: ${res.error}`);
	const renderReport = JSON.parse(res.text) as Record<string, unknown>;
	// final_review artifact: run final-review on the rendered mp4 (advisory; non-blocking here).
	const mp4 = renderMp4Path(renderReport);
	const narration = narrationMode(inputs.script as Record<string, unknown> | undefined);
	let finalReview: Record<string, unknown> = { verdict: "unknown" };
	if (mp4) {
		const fr = await deps.dispatchFn("final-review", { mp4Path: mp4, ...(narration ? { narration } : {}) });
		if (fr.ok) finalReview = JSON.parse(fr.text) as Record<string, unknown>;
	}
	return { render_report: renderReport, final_review: finalReview };
}

/** publish → final-review (delivery checks) + publish_log. */
async function producePublish(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const renderReport = inputs.render_report as Record<string, unknown> | undefined;
	const mp4 = renderMp4Path(renderReport);
	const narration = narrationMode(inputs.script as Record<string, unknown> | undefined);
	const fr = await deps.dispatchFn("final-review", { mp4Path: mp4, ...(narration ? { narration } : {}) });
	const finalReview = fr.ok ? (JSON.parse(fr.text) as Record<string, unknown>) : { verdict: "fail", error: fr.error };
	const verdict = String(finalReview.verdict ?? "fail");
	const entry: Record<string, unknown> = {
		platform: "local",
		status: verdict === "pass" ? "exported" : "failed",
		timestamp: new Date().toISOString(),
		export_path: mp4 ?? "",
	};
	if (verdict !== "pass") entry.error = String(finalReview.error ?? `final-review verdict: ${verdict}`);
	return { publish_log: { version: "1.0", entries: [entry] } };
}
