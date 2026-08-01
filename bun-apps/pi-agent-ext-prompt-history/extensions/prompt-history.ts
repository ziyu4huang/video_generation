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
		pi.on("input", (event, ctx) => {
			// Skip synthetic/programmatic input — only persist human prompts.
			if (event.source === "extension") return;
			record(ctx.cwd, event.text);
		});
	};
}

export default createPromptHistoryExtension();
