import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Self-gate: BUN_PI_COMPACT=0 disables the extension entirely. */
const extension: ExtensionFactory = (pi) => {
	if (process.env.BUN_PI_COMPACT === "0") return;
	// TODO: subscribe to pi.on(...) / register tools.
};

export default extension;
