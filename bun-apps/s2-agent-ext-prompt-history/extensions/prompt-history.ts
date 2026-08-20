import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { recordPrompt } from "../src/history-store.ts";

/**
 * Create the prompt-history extension. `record` is injectable for testing;
 * production uses recordPrompt (writes to the per-cwd history.jsonl).
 */
export function createPromptHistoryExtension(
	record: (cwd: string, text: string) => unknown = recordPrompt,
): ExtensionFactory {
	return (pi) => {
		// Self-gate: BUN_PI_PROMPT_HISTORY=0 disables capture entirely (no subscription).
		// Mirrors the legacy self-gate pattern (footer-extension-status-notify.ts) since this
		// is a statically-registered extension, not a runtime patch.
		if (process.env.BUN_PI_PROMPT_HISTORY === "0") return;
		pi.on("input", (event, ctx) => {
			// Skip synthetic/programmatic input — only persist human prompts.
			if (event.source === "extension") return;
			record(ctx.cwd, event.text);
		});
	};
}

export default createPromptHistoryExtension();
