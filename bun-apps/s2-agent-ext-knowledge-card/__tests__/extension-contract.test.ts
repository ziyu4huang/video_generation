/**
 * extension-contract — local regression guard: this package's extension
 * factory must load under s2-agent's real extension protocol without
 * throwing, and must register at least one usable tool or command. Mirrors
 * bun-apps/s2-agent/src/__tests__/extension-contract.test.ts's mock `pi`,
 * scoped to just this package so a break here fails locally (bun test in
 * this package) instead of only being caught centrally in s2-agent.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extensionFactory, { __setVaultResolverForTest } from "../extensions/knowledge-card.ts";
import { ingestRecords } from "../src/ingest.ts";

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
	// ── recall-ledger session cooldown (ticket 09: t08's deferred two-turn
	//    session test — turn 1 injects the top cards, turn 2 shows cooldown) ──
	test("armed hook: turn 1 injects, turns 2–3 cooled silent, turn 4 eligible again", async () => {
		const hooks: Record<string, ((e: unknown, ctx?: unknown) => Promise<unknown>) | undefined> = {};
		const { pi } = makeMockPi();
		(pi as { on?: unknown }).on = (ev: string, fn: (e: unknown, ctx?: unknown) => Promise<unknown>) => {
			hooks[ev] = fn;
		};
		process.env.KC_AUTORECALL = "1";
		extensionFactory(pi as never); // ONE factory call ⇒ ONE session-scoped ledger
		const vault = mkdtempSync(join(tmpdir(), "kcard-ledger-"));
		__setVaultResolverForTest(async () => vault);
		try {
			// Two cards that both clear the score floor for the shared prompt
			// (lora+argparse / lora+training), so both serve on turn 1.
			await ingestRecords(
				[
					{
						id: "test:lora-1", type: "gotcha", title: "LoRA scale gotcha",
						detail: "scale overrides compose differently than you think.",
						tags: ["lora", "argparse"], dimension: null, confidence: 0.8,
						status: "active", superseded_by: null,
					},
					{
						id: "test:train-1", type: "pattern", title: "Training seed pattern",
						detail: "fixed seeds make A/B runs comparable.",
						tags: ["lora", "training"], dimension: null, confidence: 0.8,
						status: "active", superseded_by: null,
					},
				],
				{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "contract", folder: "Zettelkasten/knowledge-graph" },
			);
			const hook = hooks["before_agent_start"]!;
			const parentCtx = { sessionManager: { getSessionFile: () => "/sessions/main.jsonl" } };
			const turn = () => hook({ prompt: "prompt about the lora and argparse training behavior", systemPrompt: "BASE" }, parentCtx) as Promise<{ systemPrompt?: string } | undefined>;

			// Turn 1: both cards inject at the systemPrompt tail.
			const t1 = await turn();
			expect(t1?.systemPrompt).toContain("LoRA scale gotcha");
			expect(t1?.systemPrompt).toContain("Training seed pattern");
			expect(t1?.systemPrompt).not.toContain("# cooled:"); // footer only when something cooled

			// Turns 2–3: cooldown — the hook changes nothing at all.
			expect(await turn()).toBeUndefined();
			expect(await turn()).toBeUndefined();

			// Turn 4: the 3-turn window expired; the cards inject again.
			const t4 = await turn();
			expect(t4?.systemPrompt).toContain("LoRA scale gotcha");
			expect(t4?.systemPrompt).not.toContain("# cooled:");
		} finally {
			__setVaultResolverForTest(null);
			delete process.env.KC_AUTORECALL;
			rmSync(vault, { recursive: true, force: true });
		}
	});

	test("before_agent_start is registered and default-off returns no prompt change", async () => {
		const hooks: Record<string, ((e: unknown, ctx?: unknown) => Promise<unknown>) | undefined> = {};
		const { pi, commands } = makeMockPi();
		// Swap the no-op `on` for a captor so the hook body is testable.
		(pi as { on?: unknown }).on = (ev: string, fn: (e: unknown, ctx?: unknown) => Promise<unknown>) => {
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
	});

	test("armed hook skips in-memory (child) sessions and appends for persisted ones", async () => {
		const hooks: Record<string, ((e: unknown, ctx?: unknown) => Promise<unknown>) | undefined> = {};
		const { pi } = makeMockPi();
		(pi as { on?: unknown }).on = (ev: string, fn: (e: unknown, ctx?: unknown) => Promise<unknown>) => {
			hooks[ev] = fn;
		};
		// Arm BEFORE the factory call — `enabled` is captured at factory time.
		process.env.KC_AUTORECALL = "1";
		extensionFactory(pi as never);
		// Hermetic vault: one card tagged lora+argparse via the resolver seam.
		const vault = mkdtempSync(join(tmpdir(), "kcard-autorecall-"));
		__setVaultResolverForTest(async () => vault);
		try {
			await ingestRecords(
				[{
					id: "test:lora-1", type: "gotcha", title: "LoRA scale gotcha",
					detail: "scale overrides compose differently than you think.",
					tags: ["lora", "argparse"], dimension: null, confidence: 0.8,
					status: "active", superseded_by: null,
				}],
				{ vaultPath: vault, source: "workflow-jsonl", sourceLabel: "contract", folder: "Zettelkasten/knowledge-graph" },
			);
			const hook = hooks["before_agent_start"]!;
			// Child session (in-memory ⇒ getSessionFile() = ""): no prompt change.
			const childCtx = { sessionManager: { getSessionFile: () => "" } };
			const childOut = await hook({ prompt: "prompt about the lora and argparse training behavior", systemPrompt: "BASE" }, childCtx);
			expect(childOut).toBeUndefined();
			// Persisted (parent) session: appends the recall block at the tail.
			const parentCtx = { sessionManager: { getSessionFile: () => "/sessions/main.jsonl" } };
			const parentOut = (await hook({ prompt: "prompt about the lora and argparse training behavior", systemPrompt: "BASE" }, parentCtx)) as { systemPrompt?: string };
			expect(parentOut?.systemPrompt).toBeDefined();
			expect(parentOut.systemPrompt!.startsWith("BASE\n\n<knowledge-recall>")).toBe(true);
			expect(parentOut.systemPrompt).toContain("LoRA scale gotcha");
			expect(parentOut.systemPrompt!.endsWith("</knowledge-recall>")).toBe(true);
		} finally {
			__setVaultResolverForTest(null);
			delete process.env.KC_AUTORECALL;
			rmSync(vault, { recursive: true, force: true });
		}
	});
});
