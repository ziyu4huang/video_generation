/**
 * assets-runtime.ts — ffmpeg-backed runtime helpers for the assets stage.
 *
 * `defaultExtractLastFrame` is the PRODUCTION implementation of the chaining
 * step described in dispatch.ts's generate guidance: extract a frame near the
 * end of a generated clip → PNG, then feed it back as `image` for the next I2V
 * call so a >8s scene's motion CONTINUES across the chain boundary instead of
 * jumping to a fresh take. driver-wiring's produceAssets calls it (injectable
 * as WireDeps.extractLastFrame); dispatch wires it as the default so chaining
 * is not silently disabled in production (the gap that left chain clips
 * independent before this landed).
 */
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

/**
 * Extract a near-last frame of `clipPath` to a PNG alongside it; resolve the
 * PNG path. `spawnImpl` is injectable so the ffmpeg invocation is unit-testable.
 * Seeks 0.3s before EOF (`-sseof -0.3`) — robust against rounding at the very
 * last frame, and a frame that late preserves continuity for the next clip.
 */
export function defaultExtractLastFrame(
	clipPath: string,
	opts: { spawnImpl?: typeof spawn } = {},
): Promise<string> {
	const doSpawn = opts.spawnImpl ?? spawn;
	const base = basename(clipPath).replace(/\.[^.]+$/, "");
	const outPath = join(dirname(clipPath), `${base}_lastframe.png`);
	const args = ["-y", "-sseof", "-0.3", "-i", clipPath, "-update", "1", "-frames:v", "1", outPath];
	return new Promise((resolve, reject) => {
		const child = doSpawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d) => (stderr += d.toString()));
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve(outPath)
				: reject(new Error(`extractLastFrame ffmpeg exited ${code}: ${stderr.slice(0, 300)}`)),
		);
	});
}

/**
 * Probe a clip's REAL video-stream duration in seconds (ffprobe). Used by the
 * deterministic edit so each cut's out_seconds reflects the actual generated
 * clip (LTX over/under-generates vs the planned frames/fps) — keeping every
 * cut within its source and defeating cut_duration_vs_source. Returns 0 on failure.
 */
export function defaultProbeDuration(path: string, opts: { spawnImpl?: typeof spawnSync } = {}): number {
	const doSpawn = opts.spawnImpl ?? spawnSync;
	try {
		const r = doSpawn(
			"ffprobe",
			["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", path],
			{ encoding: "utf8" },
		);
		const s = String((r as { stdout?: unknown }).stdout ?? "").trim().split("\n")[0] ?? "";
		const n = Number(s);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}
