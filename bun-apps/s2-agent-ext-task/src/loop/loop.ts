/** /loop — CC-style recurring prompt execution (replaces the process-improvement loop). */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseLoopCommand, completeLoopArguments, type ActiveLoop } from "./loop-commands.js";
import { LoopScheduler } from "./loop-scheduler.js";
import { persistLoop, clearPersistedLoop, loadLoopFromSession } from "./loop-persistence.js";
import type { LoopOverlayLike } from "./overlay.js";

let schedulerRef: LoopScheduler | undefined;
let extensionApiRef: ExtensionAPI | undefined;

export function isLoopActive(): boolean {
	return schedulerRef?.active() !== undefined;
}

/** Test seam — drop the in-process scheduler (mirrors __resetLoopState's role). */
export function __resetLoop(): void {
	schedulerRef?.stop();
	schedulerRef = undefined;
	extensionApiRef = undefined;
}

function newScheduler(pi: ExtensionAPI, ctx: { isIdle?: () => boolean }): LoopScheduler {
	return new LoopScheduler({
		fire: (prompt) => pi.sendUserMessage(prompt),
		isIdle: () => ctx.isIdle?.() ?? true,
	});
}

function loopStatus(loop: ActiveLoop): string {
	const nextIn = Math.max(0, Math.round((loop.nextFireAt - Date.now()) / 1000));
	return `⟳ /loop every ${Math.round(loop.intervalMs / 60_000)}m · fired ${loop.iteration}× · next in ${nextIn}s · "${loop.prompt}"`;
}

export function registerLoop(pi: ExtensionAPI, overlay: LoopOverlayLike): void {
	extensionApiRef = pi;
	pi.registerCommand("loop", {
		description: "Run a prompt on a recurring interval: /loop [interval] <prompt…> (default 10m) | stop | status",
		getArgumentCompletions: completeLoopArguments,
		handler: async (args: string, ctx: { isIdle?: () => boolean; sessionManager?: unknown; ui: { notify?: (m: string, k?: "info" | "warning" | "error") => void } }) => {
			const parsed = parseLoopCommand(args ?? "");
			if (typeof parsed === "string") {
				ctx.ui.notify?.(parsed, "warning");
				return;
			}
			if (parsed.kind === "show") {
				const loop = schedulerRef?.active();
				ctx.ui.notify?.(loop ? loopStatus(loop) : "No active loop.", "info");
				return;
			}
			if (parsed.kind === "stop") {
				if (!schedulerRef?.active()) {
					ctx.ui.notify?.("No active loop.", "info");
					return;
				}
				schedulerRef.stop();
				overlay.update(undefined);
				clearPersistedLoop(extensionApiRef);
				ctx.ui.notify?.("Loop stopped.", "info");
				return;
			}
			if (schedulerRef?.active()) {
				ctx.ui.notify?.("A loop is already active. Run /loop stop first.", "warning");
				return;
			}
			const loop: ActiveLoop = {
				id: crypto.randomUUID(),
				prompt: parsed.prompt,
				intervalMs: parsed.intervalMs,
				startedAt: Date.now(),
				nextFireAt: Date.now() + parsed.intervalMs,
				iteration: 0,
			};
			schedulerRef = newScheduler(pi, ctx);
			schedulerRef.start(loop);
			persistLoop(extensionApiRef, loop);
			overlay.update(loop);
			ctx.ui.notify?.(loopStatus(loop), "info");
		},
	});
}

/** Called from extensions/task.ts session_start to recover an active loop. */
export function restoreLoopFromSession(sessionManager: unknown, overlay: LoopOverlayLike): void {
	const loop = loadLoopFromSession(sessionManager);
	if (!loop || !extensionApiRef) return;
	schedulerRef = newScheduler(extensionApiRef, {});
	schedulerRef.start(loop);
	overlay.update(loop);
}
