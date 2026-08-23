/** LoopOverlay — recurring-loop section renderer for the CoreTaskStatusWidget (mirror goal/overlay.ts). */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ActiveLoop } from "./loop-commands.js";

const STOP_FLASH_MS = 8_000;

export interface LoopOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(loop: ActiveLoop | undefined): void;
	setRefresh(fn: () => void): void;
	dispose(): void;
}

export class LoopOverlay implements LoopOverlayLike {
	private current: ActiveLoop | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private refresh: (() => void) | undefined;

	setUICtx(_ctx: ExtensionUIContext): void {}
	setRefresh(fn: () => void): void {
		this.refresh = fn;
	}

	update(loop: ActiveLoop | undefined): void {
		this.current = loop;
		this.refresh?.();
	}

	/** Brief "stopped" line after /loop stop or max-age expiry. */
	showStopped(): void {
		this.current = undefined;
		this.clearFlashTimer();
		// one render pass without the loop, then nothing further — a stopped
		// loop leaves no permanent row.
		this.refresh?.();
	}

	dispose(): void {
		this.clearFlashTimer();
		this.current = undefined;
	}

	render(_theme: Theme, width: number): string[] {
		const l = this.current;
		if (!l) return [];
		const mins = Math.max(1, Math.round(l.intervalMs / 60_000));
		const nextIn = Math.max(0, Math.round((l.nextFireAt - Date.now()) / 1000));
		return [`⟳ /loop every ${mins}m · fired ${l.iteration}× · next in ${nextIn}s · ${l.prompt}`.slice(0, width)];
	}

	private clearFlashTimer(): void {
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
			this.flashTimer = undefined;
		}
	}
}
