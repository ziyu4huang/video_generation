/** LoopOverlay — loop section renderer for the CoreTaskStatusWidget (mirror goal/overlay.ts). */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { LoopState, LoopStopReason } from "./loop-state.js";

const STOP_FLASH_MS = 8_000;

export interface LoopOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(loop: LoopState | undefined): void;
	showStop(reason: LoopStopReason): void;
	dispose(): void;
}

export class LoopOverlay implements LoopOverlayLike {
	private current: LoopState | undefined;
	private flashReason: LoopStopReason | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private refresh: (() => void) | undefined;

	setUICtx(_ctx: ExtensionUIContext): void {}
	setRefresh(fn: () => void): void { this.refresh = fn; }

	update(loop: LoopState | undefined): void {
		this.current = loop;
		if (loop) this.clearFlash();
		this.refresh?.();
	}

	showStop(reason: LoopStopReason): void {
		this.flashReason = reason;
		this.clearFlashTimer();
		this.flashTimer = setTimeout(() => { this.flashTimer = undefined; this.flashReason = undefined; this.refresh?.(); }, STOP_FLASH_MS);
		this.refresh?.();
	}

	dispose(): void { this.clearFlashTimer(); this.flashReason = undefined; this.current = undefined; }

	render(_theme: Theme, width: number): string[] {
		if (this.flashReason !== undefined) return [`✓ loop stopped (${this.flashReason})`.slice(0, width)];
		const l = this.current;
		if (!l || !l.active) return [];
		const n = l.iteration + 1;
		if (l.mode === "metric") {
			const best = l.bestValue !== undefined ? `best=${l.bestValue}` : "best=—";
			return [`⟳ loop #${n} · ${best} · stall=${l.stallCount}/${l.plateauWindow} · ${l.direction}`.slice(0, width)];
		}
		const tok = l.tokenBudget ? ` · ${l.tokensUsed}/${l.tokenBudget}` : "";
		return [`⟳ loop #${n} (metricless)${tok}`.slice(0, width)];
	}

	private clearFlash(): void { this.clearFlashTimer(); this.flashReason = undefined; }
	private clearFlashTimer(): void { if (this.flashTimer) { clearTimeout(this.flashTimer); this.flashTimer = undefined; } }
}
