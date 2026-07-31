/**
 * Smoke test for the extension entry: it registers exactly one command named
 * "response-language". (The command's behavior is covered by command/settings
 * tests; the handler is not invoked here — no real ExtensionCommandContext.)
 */
import { describe, expect, test } from "bun:test";
import entry from "../extensions/response-language.js";

function fakePi() {
	const commands: Array<{ name: string; description: string }> = [];
	return {
		commands,
		api: {
			registerCommand: (name: string, options: { description: string }) =>
				commands.push({ name, description: options.description }),
		},
	};
}

describe("response-language extension entry", () => {
	test("registers the response-language command", () => {
		const pi = fakePi();
		(entry as (api: unknown) => void)(pi.api);
		expect(pi.commands.map((c) => c.name)).toEqual(["response-language"]);
	});

	test("the command has a non-empty description", () => {
		const pi = fakePi();
		(entry as (api: unknown) => void)(pi.api);
		expect(pi.commands[0]!.description.length).toBeGreaterThan(0);
	});
});
