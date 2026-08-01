/**
 * Smoke test for the response-language registrar: it registers exactly one
 * command named "response-language". (The command's behavior is covered by the
 * command/settings tests; the handler is not invoked here — no real
 * ExtensionCommandContext.)
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResponseLanguage } from "../response-language.js";

function fakePi() {
	const commands: Array<{ name: string; description: string }> = [];
	const pi = {
		registerCommand: (name: string, options: { description: string }) =>
			commands.push({ name, description: options.description }),
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

describe("registerResponseLanguage", () => {
	test("registers exactly the response-language command", () => {
		const { pi, commands } = fakePi();
		registerResponseLanguage(pi);
		expect(commands.map((c) => c.name)).toEqual(["response-language"]);
	});

	test("the command has a non-empty description", () => {
		const { pi, commands } = fakePi();
		registerResponseLanguage(pi);
		expect(commands[0]!.description.length).toBeGreaterThan(0);
	});
});
