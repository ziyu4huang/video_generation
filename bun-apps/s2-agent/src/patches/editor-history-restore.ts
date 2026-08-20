import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { readHistory } from "../../../s2-agent-ext-prompt-history/src/history-store.ts";

const HISTORY_RESTORE_CAP = 100;
const wrappedPrototypes = new WeakSet<object>();

/**
 * Wrap InteractiveMode.prototype.init so that, after the original init, the
 * editor's Up/Down recall buffer is hydrated from the per-cwd persisted
 * history. `read` is injectable for testing; production uses readHistory.
 * Returns true if wrapped now, false if already wrapped or init is missing.
 */
export function wrapInteractiveInitForHistoryRestore(
	proto: object,
	read: (cwd: string) => string[] = readHistory,
): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p.init;
	if (typeof original !== "function") return false;

	p.init = async function (this: any, ...args: unknown[]) {
		await (original as (...a: unknown[]) => unknown).apply(this, args);
		try {
			const cwd: string | undefined = this.sessionManager?.getCwd?.();
			const editor = this.editor;
			if (cwd && editor && Array.isArray(editor.history)) {
				editor.history = read(cwd).slice(0, HISTORY_RESTORE_CAP); // readHistory is newest-first
				editor.exitHistoryBrowsing?.();
			}
		} catch {
			// Never break startup on history restore.
		}
	};
	wrappedPrototypes.add(proto);
	return true;
}

// The boolean used to be discarded here and the debug line printed
// "patch applied" unconditionally — so when the wrap failed (a renamed
// InteractiveMode.init upstream), the diagnostic actively lied.
const outcome = wrapInteractiveInitForHistoryRestore(InteractiveMode.prototype);
if (process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true") {
	console.error(
		`[bun-pi] editor-history-restore: ${outcome ? "applied" : "already applied or failed"}`,
	);
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success — see ./index.ts.
 */
export const patchApplied = outcome;
