/** LoopOverlay — recurring-loop section renderer for the CoreTaskStatusWidget.
 *
 * Ticket 03 (2026-08-28) retired ext-task's own /loop machinery (scheduler,
 * persistence, command) into s2-agent-ext-ultracode's WakeupRegistry; this
 * overlay survives as the composite-widget FACE ONLY and renders from the
 * cross-extension read seam `globalThis.__piWakeupLoops?.()` (the
 * __piGoalActive pattern — ext-task must not import ultracode). The seam
 * publishes the registry's pending WakeupEntry snapshots.
 */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

/** Minimal render-facing shape of ultracode's WakeupEntry (kept local so this
 *  package stays import-free of s2-agent-ext-ultracode). */
export interface WakeupLoopSnapshot {
	id: string;
	prompt: string;
	mode: "fixed" | "dynamic";
	delaySeconds?: number;
	dueAt: number;
	fireCount: number;
	startedAt?: number;
}

/** Read the live pending loops from the seam; [] when ultracode isn't loaded. */
export function readWakeupLoops(): WakeupLoopSnapshot[] {
	const seam = (globalThis as Record<string, unknown>).__piWakeupLoops;
	if (typeof seam !== "function") return [];
	const list = (seam as () => unknown)();
	return Array.isArray(list) ? (list as WakeupLoopSnapshot[]) : [];
}

export interface LoopOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(_loops: unknown): void;
	setRefresh(fn: () => void): void;
	dispose(): void;
}

export class LoopOverlay implements LoopOverlayLike {
	private refresh: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	setUICtx(_ctx: ExtensionUIContext): void {}
	setRefresh(fn: () => void): void {
		this.refresh = fn;
	}
	/** No-op retained for interface compat: state lives in ultracode's registry;
	 *  render() reads the seam directly on every widget refresh. */
	update(_loops: unknown): void {
		this.refresh?.();
	}

	/** Re-render cadence while active: the registry mutates in ultracode (fires,
	 *  re-arms) without notifying this package, so a light 30s poll keeps the
	 *  "next fire in Ns" line live between task events. unref'd — never keeps a
	 *  headless process alive. */
	startPolling(): void {
		this.stopPolling();
		this.timer = setInterval(() => {
			if (readWakeupLoops().length) this.refresh?.();
		}, 30_000);
		this.timer.unref?.();
	}

	private stopPolling(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.stopPolling();
	}

	render(_theme: Theme, width: number): string[] {
		const lines: string[] = [];
		for (const l of readWakeupLoops()) {
			const cadence =
				l.mode === "fixed" && l.delaySeconds != null
					? `every ${Math.max(1, Math.round(l.delaySeconds / 60))}m`
					: "dynamic";
			const nextIn = Math.max(0, Math.round((l.dueAt - Date.now()) / 1000));
			lines.push(`⟳ /loop ${l.id} [${l.mode}] ${cadence} · fired ${l.fireCount}× · next in ${nextIn}s · ${l.prompt}`.slice(0, width));
		}
		return lines;
	}
}
