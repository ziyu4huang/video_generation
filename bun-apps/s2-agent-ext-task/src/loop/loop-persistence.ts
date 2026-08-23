/** Loop persistence — session-store only. */
import type { ActiveLoop } from "./loop-commands.js";

export const LOOP_STATE_ENTRY_TYPE = "loop-state";

export interface LoopPersistenceApi {
	appendEntry: (customType: string, data: unknown) => void;
}

function isActiveLoop(v: unknown): v is ActiveLoop {
	const l = v as ActiveLoop | undefined;
	return (
		!!l &&
		typeof l.id === "string" &&
		typeof l.prompt === "string" &&
		typeof l.intervalMs === "number" &&
		typeof l.startedAt === "number" &&
		typeof l.nextFireAt === "number" &&
		typeof l.iteration === "number"
	);
}

export function persistLoop(api: LoopPersistenceApi | undefined, loop: ActiveLoop | undefined): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: loop ? { ...loop } : null });
}

export function clearPersistedLoop(api: LoopPersistenceApi | undefined): void {
	persistLoop(api, undefined);
}

export function loadLoopFromSession(sessionManager: unknown): ActiveLoop | undefined {
	const sm = sessionManager as
		| { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>; getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries.filter((e) => e.type === "custom" && e.customType === LOOP_STATE_ENTRY_TYPE).pop();
	const data = entry?.data as { loop?: unknown } | undefined;
	return isActiveLoop(data?.loop) ? { ...(data!.loop as ActiveLoop) } : undefined;
}
