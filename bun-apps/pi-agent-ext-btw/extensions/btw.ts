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
	// Self-gate: BUN_PI_BTW=0 disables the entire extension — it registers
	// nothing and publishes no seam. Mirrors prompt-history's
	// BUN_PI_PROMPT_HISTORY=0 so every extension in the portable base set
	// (deploy-config.yaml) shares one symmetric full-disable knob; enforced by
	// tests/extension-isolation-contract.test.ts. Safe: every cross-extension
	// consumer reads its seam defensively, so disabling degrades features,
	// never crashes.
	if (process.env.BUN_PI_BTW === "0") return;
	registerBtwFeature(pi);
};

export default extension;
