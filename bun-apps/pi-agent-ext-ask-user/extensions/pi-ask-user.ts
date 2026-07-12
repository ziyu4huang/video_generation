/**
 * pi-agent-ext-ask-user — ask_user_question tool.
 *
 * Extracted from pi-agent-ext-power-tool (2026-07-12). Registers the
 * `ask_user_question` tool (a structured option selector with a free-text
 * "Other" fallback) and its reconciler (rewrites a pending tool call into the
 * canonical question shape on `before_agent_start`).
 *
 * Ported from @juicesharp/rpiv-ask-user-question.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import register from "../src/ask-user";

const extension: ExtensionFactory = (pi) => {
	register(pi);
};

export default extension;
