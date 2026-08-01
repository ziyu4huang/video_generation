import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const HINT_LINE = "↑/↓ to browse history";
const wrappedPrototypes = new WeakSet<object>();

/**
 * Wrap InteractiveMode.prototype.init so that, after the original init, the
 * expanded startup header appends the history-browse hint. `hint` is injectable
 * for testing; production uses HINT_LINE. Returns true if wrapped now, false if
 * already wrapped or init is missing.
 */
export function wrapInteractiveInitForHistoryHint(proto: object, hint: string = HINT_LINE): boolean {
	if (wrappedPrototypes.has(proto)) return false;
	const p = proto as Record<string, unknown>;
	const original = p.init;
	if (typeof original !== "function") return false;

	p.init = async function (this: any, ...args: unknown[]) {
		await (original as (...a: unknown[]) => unknown).apply(this, args);
		try {
			const header = this.builtInHeader;
			if (
				header &&
				typeof header.getExpandedText === "function" &&
				typeof header.getCollapsedText === "function"
			) {
				const origExpanded = header.getExpandedText.bind(header);
				header.getExpandedText = () => `${origExpanded()}\n${hint}`;
			}
		} catch {
			// Never break startup on the hint.
		}
	};
	wrappedPrototypes.add(proto);
	return true;
}

wrapInteractiveInitForHistoryHint(InteractiveMode.prototype);
if (process.env.BUN_PI_DEBUG_PATCHES === "1" || process.env.BUN_PI_DEBUG_PATCHES === "true") {
	console.error("[bun-pi] startup-history-hint patch applied");
}
export const startupHistoryHintPatchApplied = true;
