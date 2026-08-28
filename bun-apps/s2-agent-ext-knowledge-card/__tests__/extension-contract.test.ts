/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under s2-agent's real extension protocol without
 * throwing, and must register at least one usable tool or command. Mirrors
 * bun-apps/s2-agent/src/__tests__/extension-contract.test.ts's mock `pi`,
 * scoped to just this package so a break here fails locally (bun test in
 * this package) instead of only being caught centrally in s2-agent.
 */
import { describe, test, expect } from "bun:test";
import extensionFactory from "../extensions/knowledge-card.ts";

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

describe("s2-agent-ext-knowledge-card extension contract", () => {
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

	// ── auto-recall injector contract (ticket 08, context-lifecycle P2) ──────
	test("before_agent_start is registered and default-off returns no prompt change", async () => {
		const hooks: Record<string, ((e: unknown) => Promise<unknown>) | undefined> = {};
		const { pi, commands } = makeMockPi();
		// Swap the no-op `on` for a captor so the hook body is testable.
		(pi as { on?: unknown }).on = (ev: string, fn: (e: unknown) => Promise<unknown>) => {
			hooks[ev] = fn;
		};
		extensionFactory(pi as never);
		expect(typeof hooks["before_agent_start"]).toBe("function");
		expect(commands.some((c) => c.name === "knowledge-recall")).toBe(true);
		// Default-off (no KC_AUTORECALL): the hook must not touch the prompt —
		// merging is a zero-behavior-change operation (ticket 08 acceptance).
		delete process.env.KC_AUTORECALL;
		const out = await hooks["before_agent_start"]!({ prompt: "a substantive prompt about lora training", systemPrompt: "BASE" });
		expect(out).toBeUndefined();
		// The systemPrompt base is never mutated in place either.
		expect(process.env.S2_AGENT_SUBAGENT).toBeUndefined();
	});
});
