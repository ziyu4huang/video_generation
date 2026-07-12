/**
 * pi-agent-ext-btw — BTW side-conversation channel.
 *
 * Extracted from pi-agent-ext-power-tool (2026-07-12). Registers the `/btw`
 * commands, keyboard shortcuts, message renderer, session lifecycle handlers,
 * and context filter that together implement the BTW side-conversation
 * workflow — a focused modal for parallel Q&A without polluting the main
 * agent context.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder).
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerBtwFeature } from "../src/btw";

const extension: ExtensionFactory = (pi) => {
	registerBtwFeature(pi);
};

export default extension;
