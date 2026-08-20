import { describe, test, expect } from "bun:test";
import { registerSwitchBackendCommand } from "../../src/handlers/switch-backend.ts";
import type { DbBackend } from "../../src/types.ts";
import type { SwitchBackendDeps } from "../../src/handlers/switch-backend.ts";

function makeHarness() {
	const commands: Record<string, { handler: (args: unknown, ctx: unknown) => Promise<void> }> = {};
	const notifications: { message: string; level?: string }[] = [];
	const pi = {
		registerCommand: (name: string, opts: { handler: (a: unknown, c: unknown) => Promise<void> }) => {
			commands[name] = { handler: opts.handler };
		},
	};
	const ctx = { ui: { notify: (message: string, level?: string) => { notifications.push({ message, level }); } } };
	return { pi, commands, notifications, ctx };
}

function deps(overrides: Partial<SwitchBackendDeps> = {}): SwitchBackendDeps {
	return {
		getCurrent: () => "sqlite",
		switchTo: async () => ({ ok: true, message: "ok" }),
		labelFor: (t: DbBackend) => t,
		...overrides,
	};
}

describe("registerSwitchBackendCommand", () => {
	test("rejects an invalid backend name with an error notify", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		registerSwitchBackendCommand(pi as never, deps({ switchTo: async () => { throw new Error("must not be called"); } }));
		await commands["memory-switch-backend"].handler(["postgres"], ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0].level).toBe("error");
		expect(notifications[0].message).toContain("usage");
	});

	test("short-circuits when already on the target (no switch)", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		let called = false;
		registerSwitchBackendCommand(pi as never, deps({
			getCurrent: () => "surrealdb",
			switchTo: async () => { called = true; return { ok: true, message: "" }; },
		}));
		await commands["memory-switch-backend"].handler(["surrealdb"], ctx);
		expect(called).toBe(false);
		expect(notifications[0].message).toContain("already on");
	});

	test("performs the switch and notifies success + the session caveat", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		let switchedTo: string | null = null;
		registerSwitchBackendCommand(pi as never, deps({
			switchTo: async (t) => { switchedTo = t; return { ok: true, message: "switched" }; },
			labelFor: (t) => `label-${t}`,
		}));
		await commands["memory-switch-backend"].handler(["surrealdb"], ctx);
		expect(switchedTo).toBe("surrealdb");
		expect(notifications.some((n) => n.message.includes("switched to surrealdb"))).toBe(true);
		expect(notifications.some((n) => n.message.includes("memory-index-sessions"))).toBe(true);
	});

	test("notifies error when the switch fails and reports it stayed on current", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		registerSwitchBackendCommand(pi as never, deps({
			switchTo: async () => ({ ok: false, message: "surreal server unreachable" }),
		}));
		await commands["memory-switch-backend"].handler(["surrealdb"], ctx);
		expect(notifications.some((n) => n.level === "error" && n.message.includes("surreal server unreachable"))).toBe(true);
		expect(notifications.some((n) => n.message.includes("still on sqlite"))).toBe(true);
	});

	test("normalizes upper-case / whitespace args", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		let switchedTo: string | null = null;
		registerSwitchBackendCommand(pi as never, deps({
			switchTo: async (t) => { switchedTo = t; return { ok: true, message: "" }; },
		}));
		await commands["memory-switch-backend"].handler(["  SurrealDB  "], ctx);
		expect(switchedTo).toBe("surrealdb");
	});

	test("accepts a bare string arg (not just an array)", async () => {
		const { pi, commands, notifications, ctx } = makeHarness();
		let switchedTo: string | null = null;
		registerSwitchBackendCommand(pi as never, deps({
			switchTo: async (t) => { switchedTo = t; return { ok: true, message: "" }; },
		}));
		await commands["memory-switch-backend"].handler("sqlite", ctx);
		// current is sqlite → short-circuits (still proves bare-string parse worked)
		expect(notifications[0].message).toContain("already on");
	});
});
