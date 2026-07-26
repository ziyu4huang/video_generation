/** Loop persistence — session-store only (mirror goal/persistence.ts). */
import { cloneLoop, isLoop, type LoopState } from "./loop-state.js";

export const LOOP_STATE_ENTRY_TYPE = "loop-state";

export interface LoopPersistenceApi {
	appendEntry: (customType: string, data: unknown) => void;
}

export function persistLoop(api: LoopPersistenceApi | undefined, loop: LoopState): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: cloneLoop(loop) });
}

export function clearPersistedLoop(api: LoopPersistenceApi | undefined): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: null });
}

export function loadLoopFromSession(sessionManager: unknown): LoopState | undefined {
	const sm = sessionManager as
		| { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>; getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries.filter((e) => e.type === "custom" && e.customType === LOOP_STATE_ENTRY_TYPE).pop();
	const data = entry?.data as { loop?: unknown } | undefined;
	return isLoop(data?.loop) && (data!.loop as LoopState).active ? cloneLoop(data!.loop as LoopState) : undefined;
}
