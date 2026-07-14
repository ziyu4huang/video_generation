/**
 * assets-runtime.test.ts — the production ffmpeg last-frame extractor used by
 * the assets stage's I2V chaining. spawnImpl is injected (no real ffmpeg).
 */
import { test, expect } from "bun:test";
import { defaultExtractLastFrame } from "./assets-runtime.ts";

/** A fake spawn that records args and asynchronously "exits 0" (success). */
function fakeSpawnOk() {
	const calls: { cmd: string; args: string[] }[] = [];
	const spawnImpl = ((cmd: string, args: string[]): unknown => {
		calls.push({ cmd, args });
		const child = {
			stdout: { on: () => {} },
			stderr: { on: () => {} },
			on(ev: string, cb: (code?: number) => void) {
				if (ev === "exit") setImmediate(() => cb(0));
				return child;
			},
		};
		return child;
	}) as unknown as typeof import("node:child_process").spawn;
	return { spawnImpl, calls };
}

test("defaultExtractLastFrame spawns ffmpeg seeking near the end → 1 frame → a PNG path", async () => {
	const { spawnImpl, calls } = fakeSpawnOk();
	const out = await defaultExtractLastFrame("/proj/clip.mp4", { spawnImpl });
	expect(calls[0]!.cmd).toBe("ffmpeg");
	const args = calls[0]!.args;
	expect(args).toContain("/proj/clip.mp4"); // input clip
	expect(args).toContain("-sseof"); // seek from end (near-last frame)
	expect(args).toContain("-frames:v");
	expect(args[args.indexOf("-frames:v") + 1]).toBe("1"); // exactly one frame
	expect(out).toMatch(/clip_lastframe\.png$/); // a PNG alongside the clip
});

test("defaultExtractLastFrame rejects on a non-zero ffmpeg exit (caller sees the failure)", async () => {
	const spawnImpl = (((): unknown => {
		const child = {
			stdout: { on: () => {} },
			stderr: { on: () => {} },
			on(ev: string, cb: (code?: number) => void) {
				if (ev === "exit") setImmediate(() => cb(1));
				return child;
			},
		};
		return child;
	})()) as unknown as typeof import("node:child_process").spawn;
	await expect(defaultExtractLastFrame("/proj/x.mp4", { spawnImpl })).rejects.toThrow(/exited|ffmpeg/);
});
