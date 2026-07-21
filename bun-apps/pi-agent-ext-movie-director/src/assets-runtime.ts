/**
 * assets-runtime.ts — ffmpeg-backed runtime helpers for the assets stage.
 *
 * `defaultProbeDuration` is the PRODUCTION implementation used by the
 * deterministic edit step (see below).
 */
import { spawnSync } from "node:child_process";

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
