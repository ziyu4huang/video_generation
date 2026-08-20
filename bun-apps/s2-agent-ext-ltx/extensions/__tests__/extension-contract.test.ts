/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under s2-agent's real extension protocol without
 * throwing, and must register at least one usable tool or command. Mirrors
 * bun-apps/s2-agent/src/__tests__/extension-contract.test.ts's mock `pi`,
 * scoped to just this package so a break here fails locally (bun test in
 * this package) instead of only being caught centrally in s2-agent.
 */
import { describe, test, expect } from "bun:test";
import extensionFactory from "../ltx.ts";

interface ToolLike {
	name?: string;
	label?: string;
	description?: string;
	[key: string]: unknown;
}
interface CommandLike {
	name?: string;
	handler?: unknown;
}

function makeMockPi() {
	const tools: ToolLike[] = [];
	const commands: CommandLike[] = [];
	const pi = {
		registerTool: (t: ToolLike) => { tools.push(t); return t; },
		registerCommand: (name: string, opts: CommandLike) => { commands.push({ name, handler: opts.handler }); },
		registerMessageRenderer: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		sendMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setActiveTools: () => {},
		getActiveTools: () => [] as string[],
		getFlag: () => undefined,
		setModel: async () => true,
		on: () => {},
		events: { on: () => () => {}, emit: () => {} },
		getAllTools: () => tools,
		exec: async () => "",
		sendUserMessage: () => {},
	};
	return { pi, tools, commands };
}

describe("s2-agent-ext-ltx extension contract", () => {
	test("factory loads without throwing and registers at least one tool/command", () => {
		const { pi, tools, commands } = makeMockPi();
		expect(() => extensionFactory(pi as never)).not.toThrow();
		expect(tools.length + commands.length).toBeGreaterThan(0);
	});

	test("every registered tool has a non-empty name/label/description", () => {
		const { pi, tools } = makeMockPi();
		extensionFactory(pi as never);
		for (const t of tools) {
			expect(t.name, `tool missing name: ${JSON.stringify(t)}`).toBeTruthy();
			expect(t.label, `tool "${t.name}" missing label`).toBeTruthy();
			expect(t.description, `tool "${t.name}" missing description`).toBeTruthy();
		}
	});

	test("every registered command has a handler function", () => {
		const { pi, commands } = makeMockPi();
		extensionFactory(pi as never);
		for (const c of commands) {
			expect(typeof c.handler, `command "${c.name}" missing handler`).toBe("function");
		}
	});
});
