/**
 * Dynamic cross-package contract target for allowlists.test.mjs.
 *
 * Loads the REAL pi-obsidian extension through a fake pi and returns the Set of
 * tool names it registers. allowlists.test.mjs checks every `obsidian_*`
 * allowlist entry against this set, so a rename/removal in pi-obsidian fails
 * the test without any hand-maintained list here. Mirrors the fake-pi pattern in
 * pi-obsidian/extensions/__tests__/toolSmoke.test.mjs.
 */

let _obsidianTools;
/**
 * Load the real pi-obsidian extension and return the Set of tool names it
 * registers. Cached after the first call (idempotent).
 */
export async function collectObsidianTools() {
	if (_obsidianTools) return _obsidianTools;
	const tools = {};
	const pi = {
		registerTool: (t) => {
			tools[t.name] = t;
			// Phase 3: fat tool captures individual tools — expose them for contract validation
			if (t._capturedTools) Object.assign(tools, t._capturedTools);
		},
		registerCommand: () => {},
		on: () => {},
	};
	const mod = await import("@repo/s2-agent-ext-obsidian/extensions/obsidian.ts");
	mod.default(pi);
	_obsidianTools = new Set(Object.keys(tools));
	return _obsidianTools;
}
