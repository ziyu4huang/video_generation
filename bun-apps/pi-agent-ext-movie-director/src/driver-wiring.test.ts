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
		const { deps } = assetsDeps({ ttsDuration: 22.4 });
		const out = await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8 }] },
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const manifest = out.asset_manifest as Record<string, unknown>;
		expect((manifest.metadata as Record<string, unknown>).narrative_duration_seconds).toBe(22.4);
	});

	test("a scene_plan with no video scenes dispatches no native-relay call", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: { scenes: [{ id: "s1", type: "text_card", description: "title", start_seconds: 0, end_seconds: 3 }] },
			script: { narration: "none" },
		});
		expect(genCalls.filter((c) => c.command === "native-relay")).toHaveLength(0);
	});
});

describe("wireProduce — deterministic edit (one cut per clip at its REAL duration)", () => {
	test("builds schema-valid edit_decisions from asset_manifest; cuts use the PROBED duration, not the planned one", async () => {
		const probeDuration = async (p: string) => (p.includes("a.mp4") ? 3.88 : 5.16);
		const deps = makeWireDeps({ probeDuration });
		const out = await wireProduce(deps)("edit", {
			asset_manifest: {
				version: "1.0",
				assets: [
					{ id: "sc1-0", type: "video", path: "/tmp/a.mp4", source_tool: "ltx", scene_id: "sc1", duration_seconds: 4 },
					{ id: "sc2-0", type: "video", path: "/tmp/b.mp4", source_tool: "ltx", scene_id: "sc2", duration_seconds: 5 },
				],
			},
		});
		const edit = out.edit_decisions as Record<string, unknown>;
		expect(edit.version).toBe("1.0");
		expect(edit.render_runtime).toBe("ffmpeg");
		const cuts = edit.cuts as Array<Record<string, unknown>>;
		expect(cuts).toHaveLength(2);
		// REAL probed durations (3.88/5.16), NOT the planned 4/5 — this is what keeps
		// each cut within its source and defeats cut_duration_vs_source.
		expect(cuts[0]).toMatchObject({ id: "cut-1", source: "/tmp/a.mp4", in_seconds: 0, out_seconds: 3.88 });
		expect(cuts[1]).toMatchObject({ id: "cut-2", source: "/tmp/b.mp4", in_seconds: 0, out_seconds: 5.16 });
		expect(validateArtifact("edit_decisions", edit).ok).toBe(true);
	});
});

describe("wireProduce — compose / publish", () => {
	test("compose → dispatch compose-motion with render_runtime ffmpeg", async () => {
		const calls: Record<string, unknown>[] = [];
		const dispatchFn: DispatchLike = async (command, opts) => {
			calls.push({ command, opts });
			if (command === "compose-motion") return { ok: true, text: JSON.stringify({ output: "/tmp/final.mp4", render_grammar: "motion" }) };
			return { ok: true, text: JSON.stringify({ ok: true }) };
		};
		await wireProduce(makeWireDeps({ dispatchFn }))("compose", { edit_decisions: { version: "1.0", cuts: [], render_runtime: "ffmpeg" } });
		const compose = calls.find((c) => c.command === "compose-motion");
		expect(compose).toBeTruthy();
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
