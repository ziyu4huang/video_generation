/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under s2-agent's real extension protocol without
 * throwing, and must register at least one usable tool or command. Mirrors
 * bun-apps/s2-agent/src/__tests__/extension-contract.test.ts's mock `pi`,
 * scoped to just this package so a break here fails locally (bun test in
 * this package) instead of only being caught centrally in s2-agent.
 *
 * Host-state isolation: the factory calls createBackendBundle() (opens a DB).
 * We redirect AGENT_ROOT to a tmpdir via __setAgentRootForTest so the factory
 * opens a throwaway SQLite DB, NOT the real ~/.pi/agent store (concurrent-live
 * + 32MB). The previous un-isolated run initialized the production backend
 * (live SurrealDB / 32MB SQLite) and timed out at bun:test's 5s default while
 * leaving the real connection unclosed (mock `on()` swallows session_shutdown,
 * so backend.close() never ran). Isolation + awaiting the factory fixes both.
 * See paths.ts __setAgentRootForTest: "Every hermes test that touches host
 * state must resolve it to a tmpdir, never the real ~/.pi/agent."
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import extensionFactory from "../src/index.ts";
import { __setAgentRootForTest } from "../src/paths.ts";

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

describe("s2-agent-ext-hermes-memory extension contract", () => {
	const tools: ToolLike[] = [];
	const commands: CommandLike[] = [];
	let tmpRoot = "";

	beforeAll(async () => {
		tmpRoot = mkdtempSync(path.join(tmpdir(), "hermes-contract-"));
		__setAgentRootForTest(tmpRoot);
		const mock = makeMockPi();
		const maybe = extensionFactory(mock.pi as never);
		// The factory is async — await it (mirrors the canonical
		// s2-agent/src/__tests__/extension-contract.test.ts loadExtension).
		if (maybe && typeof (maybe as Promise<void>).then === "function") {
			await maybe;
		}
		tools.push(...mock.tools);
		commands.push(...mock.commands);
	}, 15000);

	afterAll(() => {
		__setAgentRootForTest(null);
		if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	});

	test("factory loads without throwing and registers at least one tool/command", () => {
		expect(tools.length + commands.length).toBeGreaterThan(0);
	});

	test("every registered tool has a non-empty name/label/description", () => {
		for (const t of tools) {
			expect(t.name, `tool missing name: ${JSON.stringify(t)}`).toBeTruthy();
			expect(t.label, `tool "${t.name}" missing label`).toBeTruthy();
			expect(t.description, `tool "${t.name}" missing description`).toBeTruthy();
		}
	});

	test("every registered command has a handler function", () => {
		for (const c of commands) {
			expect(typeof c.handler, `command "${c.name}" missing handler`).toBe("function");
		}
	});
});
