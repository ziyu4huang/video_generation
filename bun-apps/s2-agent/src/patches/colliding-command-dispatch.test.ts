/**
 * Pins the colliding-command-dispatch patch (headless-dispatch-hang ticket 03 /
 * B4): when multiple extensions register the same command name, upstream
 * suffixes every registration to name:1/name:2 and getCommand("name") misses —
 * so prompt()'s slash dispatch falls through and the literal "/cmd …" text
 * reaches the model. The patch retries a plain-name miss as name:1
 * (deterministic first registration); the palette is unaffected (it lists
 * resolveRegisteredCommands() directly, not getCommand()).
 */

import { describe, expect, test } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { patchApplied } from "./colliding-command-dispatch.ts";

type Command = { name: string; invocationName: string; handler?: () => void };

/** getCommand() delegates to this.resolveRegisteredCommands() — a fake `this`
 *  carrying just that method exercises the patched prototype against any
 *  registry shape. */
function lookup(registry: Command[], name: string): Command | undefined {
	const fakeThis = { resolveRegisteredCommands: () => registry };
	return (ExtensionRunner.prototype as unknown as { getCommand: (n: string) => Command | undefined }).getCommand.call(
		fakeThis,
		name,
	);
}

const COLLIDING: Command[] = [
	{ name: "loop", invocationName: "loop:1" },
	{ name: "loop", invocationName: "loop:2" },
];

describe("colliding-command-dispatch", () => {
	test("patch bound", () => {
		expect(patchApplied).toBe(true);
	});

	test("plain name resolves to the FIRST registration when the name collides", () => {
		const found = lookup(COLLIDING, "loop");
		expect(found?.invocationName).toBe("loop:1");
	});

	test("explicit suffixes still address each registration", () => {
		expect(lookup(COLLIDING, "loop:1")?.invocationName).toBe("loop:1");
		expect(lookup(COLLIDING, "loop:2")?.invocationName).toBe("loop:2");
	});

	test("non-colliding name resolves unchanged (no fallback needed)", () => {
		const registry = [{ name: "goal", invocationName: "goal" }];
		expect(lookup(registry, "goal")?.invocationName).toBe("goal");
	});

	test("unknown plain name without a ':1' sibling stays a miss", () => {
		expect(lookup([{ name: "goal", invocationName: "goal" }], "loop")).toBeUndefined();
		expect(lookup([], "loop")).toBeUndefined();
	});

	test("an explicit-suffix miss does NOT fall back (':' names a registration)", () => {
		expect(lookup(COLLIDING, "loop:3")).toBeUndefined();
	});
});
