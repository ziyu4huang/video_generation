/**
 * driver-wiring.test.ts — wireProduce routes each stage to its producer and
 * executes the asset plan via dispatch (with chaining), all against fakes.
 */
import { describe, test, expect } from "bun:test";
import { wireProduce, type WireDeps, type DispatchLike } from "./driver-wiring.ts";
import type { WaypointDeps } from "./waypoints.ts";
import { validateArtifact } from "./schema.ts";

function makeWireDeps(over: Partial<WireDeps> = {}): WireDeps {
	const defaults: WireDeps = {
		dispatchFn: async () => ({ ok: true, text: JSON.stringify({ result: { artifacts: [{ path: "/tmp/clip.mp4" }] } }) }),
		waypointDeps: {
			completionFn: async () => JSON.stringify({ ok: true }),
			agentFn: async () => JSON.stringify({ data_points: [1, 2, 3] }),
			validateFn: async () => ({ valid: true }),
		},
		projectId: "demo",
		pipeline: "animated-explainer",
	};
	return { ...defaults, ...over };
}

describe("wireProduce — routing", () => {
	test("research → agent waypoint (research_brief artifact)", async () => {
		let called = "";
		const deps = makeWireDeps({
			waypointDeps: {
				completionFn: async () => "x",
				agentFn: async () => {
					called = "agent";
					return JSON.stringify({ data_points: [1] });
				},
				validateFn: async () => ({ valid: true }),
			},
		});
		const produce = wireProduce(deps);
		const out = await produce("research", { topic: "x" });
		expect(called).toBe("agent");
		expect(out).toHaveProperty("research_brief");
	});

	test("script → completion waypoint (script artifact)", async () => {
		let called = "";
		const deps = makeWireDeps({
			waypointDeps: {
				completionFn: async () => {
					called = "completion";
					return JSON.stringify({ sections: [] });
				},
				agentFn: async () => "x",
				validateFn: async () => ({ valid: true }),
			},
		});
		const out = await wireProduce(deps)("script", { topic: "x" });
		expect(called).toBe("completion");
		expect(out).toHaveProperty("script");
	});
});

describe("wireProduce — assets execution (single native-relay call for the whole movie)", () => {
	function assetsDeps(opts: { segmentDurations?: number[]; ttsDuration?: number } = {}) {
		const genCalls: Record<string, unknown>[] = [];
		const segDurations = opts.segmentDurations ?? [8, 8];
		const dispatchFn: DispatchLike = async (command, callOpts) => {
			if (command !== "generate") return { ok: true, text: JSON.stringify({}) };
			genCalls.push(callOpts);
			const capability = (callOpts as Record<string, unknown>).capability;
			if (capability === "tts") {
				return { ok: true, text: JSON.stringify({ provider: "tts", result: { artifacts: [{ path: "/tmp/narration.wav" }] } }) };
			}
			if (capability === "music_generation") {
				return { ok: true, text: JSON.stringify({ provider: "musicgen", result: { artifacts: [{ path: "/tmp/music.wav" }] } }) };
			}
			// native-relay: one artifact per segment (role segment_1, segment_2, ...) + the final mp4 as the primary artifact.
			const segmentArtifacts = segDurations.map((_, i) => ({ path: `/tmp/relay/seg0${i + 1}/segment.mp4`, role: `segment_${i + 1}` }));
			return {
				ok: true,
				text: JSON.stringify({ provider: "ltx", result: { artifacts: [{ path: "/tmp/relay/relay.mp4" }, ...segmentArtifacts] } }),
			};
		};
		const probeDuration = async (path: string) => {
			if (path === "/tmp/narration.wav") return opts.ttsDuration ?? 16;
			const m = path.match(/seg0(\d)\/segment\.mp4$/);
			return m ? segDurations[Number(m[1]) - 1]! : 0;
		};
		return { deps: makeWireDeps({ dispatchFn, probeDuration }), genCalls };
	}

	test("dispatches exactly ONE native-relay call for a two-scene movie, with provider:'ltx'", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCalls = genCalls.filter((c) => c.command === "native-relay");
		expect(relayCalls).toHaveLength(1);
		expect(relayCalls[0]!.provider).toBe("ltx");
		const options = relayCalls[0]!.options as Record<string, unknown>;
		expect(options.prompts).toEqual(["a cube", "a sphere"]);
		expect(options.secondsPerSegment).toEqual([8, 8]);
		expect(options.segmentContinuity).toEqual([true, true]); // no scene declared continuity:"cut"
		expect(options.relayAudio).toBe("/tmp/narration.wav");
	});

	test("a scene with continuity:'cut' sets that scene's first link to false, others stay true", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16, continuity: "cut" },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCall = genCalls.find((c) => c.command === "native-relay")!;
		expect((relayCall.options as Record<string, unknown>).segmentContinuity).toEqual([true, false]);
	});

	test("forwards cameraMovements to the native-relay dispatch options, defaulting missing entries to 'none'", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8, shot_language: { camera_movement: "dolly_in" } },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCall = genCalls.find((c) => c.command === "native-relay")!;
		expect((relayCall.options as Record<string, unknown>).cameraMovements).toEqual(["dolly_in", "none"]);
	});

	test("returns a SCHEMA-VALID asset_manifest with scene_boundaries derived from real probed segment durations", async () => {
		const { deps } = assetsDeps({ segmentDurations: [7.5, 8.2] });
		const out = await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const manifest = out.asset_manifest as Record<string, unknown>;
		expect(manifest.version).toBe("1.0");
		expect(validateArtifact("asset_manifest", manifest).ok).toBe(true);
		const boundaries = (manifest.metadata as Record<string, unknown>).scene_boundaries as Array<Record<string, unknown>>;
		expect(boundaries).toEqual([
			{ sceneId: "s1", startSeconds: 0, endSeconds: 7.5 },
			{ sceneId: "s2", startSeconds: 7.5, endSeconds: 15.7 },
		]);
	});

	test("narrative_duration_seconds in asset_manifest.metadata comes from the narration wav's real probed duration", async () => {
		const { deps } = assetsDeps({ ttsDuration: 22.4, segmentDurations: [8] });
		const out = await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const manifest = out.asset_manifest as Record<string, unknown>;
		expect((manifest.metadata as Record<string, unknown>).narrative_duration_seconds).toBe(22.4);
	});

	test("dispatches a music_generation call when music_prompt is supplied, and records it in asset_manifest", async () => {
		const { deps, genCalls } = assetsDeps({ segmentDurations: [8] });
		const out = await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
			music_prompt: "gentle solo piano, melancholic",
			music_duration: 20,
		});
		const musicCalls = genCalls.filter((c) => c.capability === "music_generation");
		expect(musicCalls).toHaveLength(1);
		expect(musicCalls[0]!.command).toBe("music");
		expect(musicCalls[0]!.options).toEqual({ prompt: "gentle solo piano, melancholic", duration: 20 });
		const manifest = out.asset_manifest as Record<string, unknown>;
		const assets = manifest.assets as Array<Record<string, unknown>>;
		const musicAsset = assets.find((a) => a.type === "music");
		expect(musicAsset?.path).toBe("/tmp/music.wav");
		expect(musicAsset?.source_tool).toBe("musicgen");
		expect(validateArtifact("asset_manifest", manifest).ok).toBe(true);
	});

	test("no music_prompt in inputs dispatches no music_generation call", async () => {
		const { deps, genCalls } = assetsDeps({ segmentDurations: [8] });
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		expect(genCalls.filter((c) => c.capability === "music_generation")).toHaveLength(0);
	});

	test("a scene_plan with no video scenes dispatches no native-relay call", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "text_card", description: "title", start_seconds: 0, end_seconds: 3 }] },
			script: { narration: "none" },
		});
		expect(genCalls.filter((c) => c.command === "native-relay")).toHaveLength(0);
	});

	test("throws when native-relay returns no primary output artifact (malformed/empty relay response)", async () => {
		const dispatchFn: DispatchLike = async (command, callOpts) => {
			if (command !== "generate") return { ok: true, text: JSON.stringify({}) };
			const capability = (callOpts as Record<string, unknown>).capability;
			if (capability === "tts") {
				return { ok: true, text: JSON.stringify({ provider: "tts", result: { artifacts: [{ path: "/tmp/narration.wav" }] } }) };
			}
			// Only segment_N artifacts, no unroled primary output artifact at index 0.
			return {
				ok: true,
				text: JSON.stringify({
					provider: "ltx",
					result: { artifacts: [{ path: "", role: undefined }, { path: "/tmp/relay/seg01/segment.mp4", role: "segment_1" }] },
				}),
			};
		};
		const probeDuration = async () => 8;
		const deps = makeWireDeps({ dispatchFn, probeDuration });
		await expect(
			wireProduce(deps)("assets", {
				scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
				script: { sections: [{ id: "s1", text: "hi" }] },
			}),
		).rejects.toThrow(/primary output/i);
	});

	test("throws when native-relay returns fewer segments than requested links (partial/corrupt output)", async () => {
		const dispatchFn: DispatchLike = async (command, callOpts) => {
			if (command !== "generate") return { ok: true, text: JSON.stringify({}) };
			const capability = (callOpts as Record<string, unknown>).capability;
			if (capability === "tts") {
				return { ok: true, text: JSON.stringify({ provider: "tts", result: { artifacts: [{ path: "/tmp/narration.wav" }] } }) };
			}
			// Only 1 segment artifact even though 2 links were requested.
			return {
				ok: true,
				text: JSON.stringify({
					provider: "ltx",
					result: { artifacts: [{ path: "/tmp/relay/relay.mp4" }, { path: "/tmp/relay/seg01/segment.mp4", role: "segment_1" }] },
				}),
			};
		};
		const probeDuration = async () => 8;
		const deps = makeWireDeps({ dispatchFn, probeDuration });
		await expect(
			wireProduce(deps)("assets", {
				scene_plan: {
					scenes: [
						{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 },
						{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
					],
				},
				script: { sections: [{ id: "s1", text: "hi" }] },
			}),
		).rejects.toThrow(/segment/i);
	});
});

describe("wireProduce — deterministic edit (scene-boundary cuts on the shared relay source)", () => {
	test("builds schema-valid edit_decisions with one cut per scene boundary, all sharing the relay mp4 as source, transition:none", async () => {
		const out = await wireProduce(makeWireDeps())("edit", {
			asset_manifest: {
				version: "1.0",
				assets: [{ id: "relay-movie", type: "video", path: "/tmp/relay/relay.mp4", source_tool: "native-relay", scene_id: "s1", duration_seconds: 15.7 }],
				metadata: {
					scene_boundaries: [
						{ sceneId: "s1", startSeconds: 0, endSeconds: 7.5 },
						{ sceneId: "s2", startSeconds: 7.5, endSeconds: 15.7 },
					],
				},
			},
		});
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.version).toBe("1.0");
		expect(edit.render_runtime).toBe("ffmpeg");
		expect(edit.transition).toBe("none");
		const cuts = edit.cuts as Array<Record<string, unknown>>;
		expect(cuts).toEqual([
			{ id: "cut-s1", source: "/tmp/relay/relay.mp4", in_seconds: 0, out_seconds: 7.5 },
			{ id: "cut-s2", source: "/tmp/relay/relay.mp4", in_seconds: 7.5, out_seconds: 15.7 },
		]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});

	test("no video asset / no scene_boundaries → empty cuts (still schema-valid)", async () => {
		const out = await wireProduce(makeWireDeps())("edit", { asset_manifest: { version: "1.0", assets: [], metadata: {} } });
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.cuts).toEqual([]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});

	test("metadata entirely absent from the manifest → empty cuts (still schema-valid)", async () => {
		const out = await wireProduce(makeWireDeps())("edit", {
			asset_manifest: {
				version: "1.0",
				assets: [{ id: "relay-movie", type: "video", path: "/tmp/relay/relay.mp4", source_tool: "native-relay", scene_id: "s1", duration_seconds: 15.7 }],
			},
		});
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.cuts).toEqual([]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});

	test("a zero-width scene boundary is dropped; a normal boundary alongside it still produces a cut", async () => {
		const out = await wireProduce(makeWireDeps())("edit", {
			asset_manifest: {
				version: "1.0",
				assets: [{ id: "relay-movie", type: "video", path: "/tmp/relay/relay.mp4", source_tool: "native-relay", scene_id: "s1", duration_seconds: 15.7 }],
				metadata: {
					scene_boundaries: [
						{ sceneId: "s1", startSeconds: 0, endSeconds: 0 },
						{ sceneId: "s2", startSeconds: 0, endSeconds: 7.5 },
					],
				},
			},
		});
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.cuts).toEqual([{ id: "cut-s2", source: "/tmp/relay/relay.mp4", in_seconds: 0, out_seconds: 7.5 }]);
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});

	test("more than one video asset in the manifest throws loudly instead of silently picking the first", async () => {
		await expect(
			wireProduce(makeWireDeps())("edit", {
				asset_manifest: {
					version: "1.0",
					assets: [
						{ id: "a", type: "video", path: "/tmp/a.mp4" },
						{ id: "b", type: "video", path: "/tmp/b.mp4" },
					],
					metadata: { scene_boundaries: [{ sceneId: "s1", startSeconds: 0, endSeconds: 5 }] },
				},
			}),
		).rejects.toThrow(/at most one video asset/i);
	});
});

describe("wireProduce — compose / publish", () => {
	test("compose → dispatch compose-motion with render_runtime ffmpeg AND narrativeDurationSeconds from asset_manifest.metadata", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4", render_grammar: "motion" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", {
			edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg", transition: "none" },
			asset_manifest: { version: "1.0", assets: [], metadata: { narrative_duration_seconds: 22.4 } },
		});
		const compose = calls.find((c) => c.command === "compose-motion")!;
		expect((compose.opts as Record<string, unknown>).narrativeDurationSeconds).toBe(22.4);
	});

	test("compose → omits narrativeDurationSeconds when asset_manifest carries none (e.g. silent video)", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", { edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg" } });
		const compose = calls.find((c) => c.command === "compose-motion")!;
		expect(compose.opts).not.toHaveProperty("narrativeDurationSeconds");
	});

	test("publish → dispatch final-review on the rendered mp4", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			return { ok: true, text: JSON.stringify({ verdict: "pass" }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("publish", { render_report: { output: "/tmp/final.mp4" } });
		expect(calls.some((c) => c.command === "final-review")).toBe(true);
	});

	test("publish reads the mp4 from render_report.outputs[] (the real compose-motion shape)", async () => {
		let reviewed: string | undefined;
		const dispatchFn: DispatchLike = async (command, opts) => {
			if (command === "final-review") reviewed = String((opts as Record<string, unknown>).mp4Path);
			return { ok: true, text: JSON.stringify({ verdict: "pass" }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("publish", { render_report: { outputs: [{ path: "/tmp/real.mp4" }] } });
		expect(reviewed).toBe("/tmp/real.mp4");
	});

	test("publish returns a SCHEMA-VALID publish_log (version + entries[platform,status,timestamp])", async () => {
		const dispatchFn: DispatchLike = async () => ({ ok: true, text: JSON.stringify({ verdict: "pass" }) });
		const out = await wireProduce(makeWireDeps({ dispatchFn }))("publish", { render_report: { outputs: [{ path: "/tmp/f.mp4" }] } });
		const pl = out.publish_log as Record<string, unknown>;
		expect(pl.version).toBe("1.0");
		expect(validateArtifact("publish_log", pl).ok).toBe(true);
		const entry = (pl.entries as Array<Record<string, unknown>>)[0]!;
		expect(entry.status).toBe("exported");
		expect(entry.export_path).toBe("/tmp/f.mp4");
	});
});

describe("wireProduce — full assets→edit→compose chain (multi-scene, mixed continuity)", () => {
	test("chains REAL produceAssets output through REAL produceEdit and produceCompose across 3 scenes with mixed continuity", async () => {
		const calls: Array<{ command: string; opts: Record<string, unknown> }> = [];
		// Per-segment probed durations, in flattened relay-link order:
		// [sceneA link0, sceneB link0, sceneB link1, sceneC link0]. Scene B's two
		// links are deliberately asymmetric (9 + 7, not the planned 8 + 8) to model
		// LTX's real per-clip over/under-generation vs. the planned even split.
		const segDurations = [6, 9, 7, 8];
		const narrationDuration = 26.4;

		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "generate" && opts.capability === "tts") {
				return { ok: true, text: JSON.stringify({ provider: "tts", result: { artifacts: [{ path: "/tmp/narration.wav" }] } }) };
			}
			if (command === "generate" && opts.command === "native-relay") {
				const options = opts.options as Record<string, unknown>;
				const prompts = options.prompts as string[];
				const segmentArtifacts = prompts.map((_, i) => ({ path: `/tmp/relay/seg0${i + 1}/segment.mp4`, role: `segment_${i + 1}` }));
				return {
					ok: true,
					text: JSON.stringify({ provider: "ltx", result: { artifacts: [{ path: "/tmp/relay/relay.mp4" }, ...segmentArtifacts] } }),
				};
			}
			if (command === "compose-motion") {
				return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4" }) };
			}
			if (command === "final-review") {
				return { ok: true, text: JSON.stringify({ verdict: "pass" }) };
			}
			return { ok: true, text: JSON.stringify({}) };
		};
		const probeDuration = async (path: string) => {
			if (path === "/tmp/narration.wav") return narrationDuration;
			const m = path.match(/seg0(\d)\/segment\.mp4$/);
			return m ? segDurations[Number(m[1]) - 1]! : 0;
		};

		const deps = makeWireDeps({ dispatchFn, probeDuration });
		const produce = wireProduce(deps);

		const scenePlan = {
			scenes: [
				// Scene A: 6s, no continuity field → defaults to "continue" (single link).
				{ id: "sceneA", type: "generated", description: "Establishing wide shot of the city at dawn", start_seconds: 0, end_seconds: 6 },
				// Scene B: 16s with a hard cut in → splits into 2 links (maxCallSeconds=8):
				// link0 is the hard cut (continuity:false), link1 continues from it (continuity:true).
				{ id: "sceneB", type: "generated", description: "Chase sequence through the market", start_seconds: 6, end_seconds: 22, continuity: "cut" },
				// Scene C: 8s, explicit continuity:"continue" (single link).
				{ id: "sceneC", type: "generated", description: "Quiet resolution on the rooftop", start_seconds: 22, end_seconds: 30, continuity: "continue" },
			],
		};
		const script = { sections: [{ id: "s1", text: "A long narration describing the whole three-scene movie." }] };

		// --- Stage 1: REAL produceAssets ---
		const assetsOut = await produce("assets", { scene_plan: scenePlan, script });
		expect(validateArtifact("asset_manifest", assetsOut.asset_manifest).ok).toBe(true);
		const manifest = assetsOut.asset_manifest as Record<string, unknown>;
		const metadata = manifest.metadata as Record<string, unknown>;
		const boundaries = metadata.scene_boundaries as Array<Record<string, unknown>>;

		// 4 relay links get dispatched (sceneA:1 + sceneB:2 + sceneC:1)...
		const relayCall = calls.find((c) => c.command === "generate" && c.opts.command === "native-relay")!;
		const relayOptions = relayCall.opts.options as Record<string, unknown>;
		expect((relayOptions.prompts as string[]).length).toBe(4);
		expect(relayOptions.segmentContinuity).toEqual([true, false, true, true]);

		// ...but they group into exactly 3 scene_boundaries entries (one per SCENE), NOT 4.
		expect(boundaries).toEqual([
			{ sceneId: "sceneA", startSeconds: 0, endSeconds: 6 },
			{ sceneId: "sceneB", startSeconds: 6, endSeconds: 22 },
			{ sceneId: "sceneC", startSeconds: 22, endSeconds: 30 },
		]);
		expect(metadata.narrative_duration_seconds).toBe(narrationDuration);

		// --- Stage 2: REAL produceEdit, fed the REAL asset_manifest merged with the script
		//     (mirrors driver.ts's stage-to-stage inputArtifacts accumulation) ---
		const editOut = await produce("edit", { asset_manifest: manifest, script });
		expect(validateArtifact("edit_decisions", editOut.edit_decisions).ok).toBe(true);
		const editDecisions = editOut.edit_decisions as Record<string, unknown>;
		const cuts = editDecisions.cuts as Array<Record<string, unknown>>;
		expect(cuts).toHaveLength(3); // one cut per SCENE, not per relay link
		expect(editDecisions.transition).toBe("none");
		expect(cuts.map((c) => c.id)).toEqual(["cut-sceneA", "cut-sceneB", "cut-sceneC"]);

		// --- Stage 3: REAL produceCompose, fed both edit_decisions and asset_manifest ---
		await produce("compose", { edit_decisions: editDecisions, asset_manifest: manifest, script });
		const composeCall = calls.find((c) => c.command === "compose-motion")!;
		expect(composeCall.opts.narrativeDurationSeconds).toBe(narrationDuration);
	});
});
