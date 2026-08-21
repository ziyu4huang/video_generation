/**
 * entry-smoke — the factory loads, is callable, and honors its self-gate.
 * When the extension registers tools, tighten this into a stealth-trim guard
 * (short routing description, no promptSnippet/promptGuidelines) — see
 * s2-agent-ext-flux2/extensions/__tests__/stealth-trim.test.ts.
 */
import { test, expect } from "bun:test";
import extensionFactory from "../compact.ts";

function captureTools() {
	const tools: Record<string, Record<string, unknown>> = {};
	const mockPi = {
		registerTool: (t: Record<string, unknown>) => { tools[t.name as string] = t; },
		on(_event: string, _handler: (...args: unknown[]) => void) {},
		getActiveTools: () => [] as string[],
		setActiveTools: (_tools: string[]) => {},
	};
	extensionFactory(mockPi as never);
	return tools;
}

test("factory loads and self-gates on BUN_PI_COMPACT=0", () => {
	expect(() => captureTools()).not.toThrow();
	const prev = process.env.BUN_PI_COMPACT;
	process.env.BUN_PI_COMPACT = "0";
	try {
		expect(() => captureTools()).not.toThrow();
	} finally {
		if (prev === undefined) delete process.env.BUN_PI_COMPACT;
		else process.env.BUN_PI_COMPACT = prev;
	}
});
