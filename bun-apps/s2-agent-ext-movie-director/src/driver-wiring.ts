/**
 * driver-wiring.ts — connect the driver's `produce` to real producers.
 *
 * Routes each stage via pickProducer():
 *   • agent        (research)                        → runAgentWaypoint
 *   • completion   (proposal/script/scene_plan)       → runCompletionWaypoint
 *   • mechanical   (assets/edit/compose/publish)      → dispatch()
 *
 * The assets stage EXECUTES the proactive plan from assets-encoder.ts: it
 * dispatches at most one `tts` call and ONE native-relay call for the whole
 * movie (prompts/secondsPerSegment/segmentContinuity arrays derived from
 * scene_plan), then probes each returned segment_N artifact's real duration
 * to build asset_manifest.metadata.scene_boundaries. Last-frame reseed for
 * chained links happens natively inside Swift's native-relay, not via an
 * external ffmpeg extraction step.
 */
import { runCompletionWaypoint, runAgentWaypoint, pickProducer, type WaypointDeps } from "./waypoints.ts";
import { planAssetGeneration } from "./assets-encoder.ts";

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

/** Ordered per-segment clip paths from a native-relay generate() response —
 *  artifacts with role "segment_1", "segment_2", ... (see adaptLtx / result.ts's
 *  buildNativeRelayDetails). Order is the numeric suffix, not array position. */
function relaySegmentPaths(result: unknown): string[] {
	const r = result as { result?: { artifacts?: Array<{ path?: string; role?: string }> }; artifacts?: Array<{ path?: string; role?: string }> };
	const artifacts = r?.result?.artifacts ?? r?.artifacts ?? [];
	return artifacts
		.filter((a): a is { path: string; role: string } => typeof a.role === "string" && /^segment_\d+$/.test(a.role) && typeof a.path === "string")
		.sort((a, b) => Number(a.role.slice(8)) - Number(b.role.slice(8)))
		.map((a) => a.path);
}

/** Extract the rendered mp4 path from a compose render_report — robust to either
 *  `output` (singular) or `outputs[0].path` (the real compose-motion shape). */
function renderMp4Path(rr: Record<string, unknown> | undefined): string | undefined {
	if (!rr) return undefined;
	if (typeof rr.output === "string") return rr.output;
	const outs = rr.outputs as Array<{ path?: string }> | undefined;
	return outs?.[0]?.path;
}

/** Execute the proactive asset plan: one TTS call, then ONE native-relay call for the whole movie. */
async function produceAssets(
	deps: WireDeps,
	fps: number,
	maxCallSeconds: number,
	inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const scenePlan = inputs.scene_plan as { scenes: unknown[] } | undefined;
	const script = inputs.script as Record<string, unknown> | undefined;
	if (!scenePlan) throw new Error("assets: missing scene_plan input");
	const musicPrompt = inputs.music_prompt as string | undefined;
	const musicDuration = inputs.music_duration as number | undefined;
	const plan = planAssetGeneration(scenePlan as never, script as never, {
		maxCallSeconds,
		...(musicPrompt ? { music: { prompt: musicPrompt, duration: musicDuration } } : {}),
	});
	const probe = deps.probeDuration ?? (async () => 0);

	const assets: Array<Record<string, unknown>> = [];
	let narrationPath: string | undefined;
	let narrativeDurationSeconds = 0;

	if (plan.tts) {
		const res = await deps.dispatchFn("generate", {
			capability: "tts",
			command: "tts",
			options: { text: plan.tts.text },
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate tts failed: ${res.error}`);
		const parsedResult = JSON.parse(res.text) as { provider?: string };
		narrationPath = firstArtifactPath(parsedResult);
		if (narrationPath) narrativeDurationSeconds = await probe(narrationPath);
		assets.push({
			id: "narration",
			type: "narration",
			path: narrationPath ?? "",
			source_tool: parsedResult.provider ?? "tts",
			scene_id: plan.tts.sceneId ?? "",
			generation_summary: "generated via tts",
			...(narrativeDurationSeconds > 0 ? { duration_seconds: Math.round(narrativeDurationSeconds * 1000) / 1000 } : {}),
		});
	}

	if (plan.music) {
		const res = await deps.dispatchFn("generate", {
			capability: "music_generation",
			command: "music",
			options: { prompt: plan.music.prompt, ...(plan.music.duration != null ? { duration: plan.music.duration } : {}) },
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate music failed: ${res.error}`);
		const parsedResult = JSON.parse(res.text) as { provider?: string };
		const musicPath = firstArtifactPath(parsedResult);
		assets.push({
			id: "music",
			type: "music",
			path: musicPath ?? "",
			source_tool: parsedResult.provider ?? "musicgen",
			scene_id: plan.music.sceneId ?? "",
			generation_summary: "generated via music",
		});
	}

	const sceneBoundaries: Array<{ sceneId: string; startSeconds: number; endSeconds: number }> = [];

	if (plan.relayLinks.length > 0) {
		const res = await deps.dispatchFn("generate", {
			capability: "video_generation",
			command: "native-relay",
			provider: "ltx",
			options: {
				prompts: plan.relayLinks.map((l) => l.prompt),
				secondsPerSegment: plan.relayLinks.map((l) => l.seconds),
				segmentContinuity: plan.relayLinks.map((l) => l.continuity),
				cameraMovements: plan.relayLinks.map((l) => l.cameraMovement ?? "none"),
				fps,
				...(narrationPath ? { relayAudio: narrationPath } : {}),
			},
			projectId: deps.projectId,
			pipeline: deps.pipeline,
		});
		if (!res.ok) throw new Error(`assets generate native-relay failed: ${res.error}`);
		const parsedResult = JSON.parse(res.text) as { provider?: string };
		const relayMp4Path = firstArtifactPath(parsedResult) ?? "";
		if (!relayMp4Path) {
			throw new Error("assets native-relay response has no primary output artifact (malformed/empty relay output)");
		}
		const segmentPaths = relaySegmentPaths(parsedResult);
		if (segmentPaths.length !== plan.relayLinks.length) {
			throw new Error(
				`assets native-relay returned ${segmentPaths.length} segment(s), expected ${plan.relayLinks.length} — partial/corrupt relay output`,
			);
		}

		let cursor = 0;
		for (let i = 0; i < plan.relayLinks.length; i++) {
			const link = plan.relayLinks[i]!;
			const segPath = segmentPaths[i];
			const dur = segPath ? await probe(segPath) : 0;
			const start = cursor;
			cursor += dur;
			if (link.chainIndex === 0) {
				sceneBoundaries.push({ sceneId: link.sceneId, startSeconds: start, endSeconds: cursor });
			} else {
				sceneBoundaries[sceneBoundaries.length - 1]!.endSeconds = cursor;
			}
		}

		assets.push({
			id: "relay-movie",
			type: "video",
			path: relayMp4Path,
			source_tool: parsedResult.provider ?? "native-relay",
			scene_id: sceneBoundaries[0]?.sceneId ?? "",
			generation_summary: `generated via native-relay (${plan.relayLinks.length} link(s))`,
			duration_seconds: Math.round(cursor * 1000) / 1000,
		});
	}

	return {
		asset_manifest: {
			version: "1.0",
			assets,
			metadata: { scene_boundaries: sceneBoundaries, narrative_duration_seconds: narrativeDurationSeconds },
		},
	};
}

/** The script's narration mode (for final-review: 'none' scores a silent track as warn). */
function narrationMode(script: Record<string, unknown> | undefined): "none" | "voiced" | undefined {
	const n = script?.narration;
	return n === "none" || n === "voiced" ? (n as "none" | "voiced") : undefined;
}

/** edit → deterministic edit_decisions: one cut per SCENE BOUNDARY, all sharing
 *  the single native-relay output as source (produceAssets already probed each
 *  segment's REAL duration to build scene_boundaries — no source-clip-per-cut
 *  files anymore). transition:"none" because the relay's segments are already
 *  visually continuous (last-frame reseed inside Swift); a crossfade here would
 *  double-blend already-matching frames. No LLM — deterministic like before. */
async function produceEdit(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const manifest = inputs.asset_manifest as
		| { assets?: Array<{ type?: string; path?: string }>; metadata?: { scene_boundaries?: Array<{ sceneId: string; startSeconds: number; endSeconds: number }> } }
		| undefined;
	if (!manifest?.assets) throw new Error("edit: missing asset_manifest input");
	const videoAssets = manifest.assets.filter((a) => a.type === "video" && a.path);
	if (videoAssets.length > 1) {
		throw new Error(`edit: expected at most one video asset in asset_manifest, found ${videoAssets.length}`);
	}
	const relayAsset = videoAssets[0];
	const boundaries = manifest.metadata?.scene_boundaries ?? [];
	const cuts =
		relayAsset?.path && boundaries.length > 0
			? boundaries
					.filter((b) => b.endSeconds > b.startSeconds)
					.map((b) => ({ id: `cut-${b.sceneId}`, source: relayAsset.path!, in_seconds: b.startSeconds, out_seconds: b.endSeconds }))
			: [];
	return { edit_decisions: { version: "1.0", render_runtime: "ffmpeg", transition: "none", cuts } };
}

/** compose → compose-motion (render_report) + final-review (final_review). */
async function produceCompose(deps: WireDeps, inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
	const edit = inputs.edit_decisions as Record<string, unknown> | undefined;
	if (!edit) throw new Error("compose: missing edit_decisions input");
	const manifest = inputs.asset_manifest as { metadata?: { narrative_duration_seconds?: number } } | undefined;
	const narrativeDurationSeconds = manifest?.metadata?.narrative_duration_seconds;
	const res = await deps.dispatchFn("compose-motion", {
		editDecisions: edit,
		projectId: deps.projectId,
		render_runtime: "ffmpeg",
		...(narrativeDurationSeconds ? { narrativeDurationSeconds } : {}),
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
