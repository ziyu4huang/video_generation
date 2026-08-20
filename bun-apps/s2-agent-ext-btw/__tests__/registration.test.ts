/**
 * Registration contract for s2-agent-ext-btw.
 *
 * Locks in the extraction from s2-agent-ext-power-tool: invoking the entry
 * factory against a recorder must register the full BTW command surface
 * (8 commands), the message renderer, the focus shortcuts, and the 4
 * lifecycle/context handlers. BtwEngine's constructor is trivial (stores pi),
 * so this runs without spawning any subprocess.
 */
import { test, expect } from "bun:test";
import factory from "../extensions/btw";
import { BTW_MESSAGE_TYPE } from "../src/btw/constants";

function makeRecorderPi() {
	const commands: string[] = [];
	const shortcuts: unknown[] = [];
	const renderers: string[] = [];
	const events: string[] = [];
	const pi = {
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerShortcut: (s: unknown) => {
			shortcuts.push(s);
		},
		registerMessageRenderer: (type: string) => {
			renderers.push(type);
		},
		on: (event: string) => {
			events.push(event);
		},
	};
	return { pi, commands, shortcuts, renderers, events };
}

test("entry is a callable ExtensionFactory", () => {
	expect(typeof factory).toBe("function");
});

test("registers the full BTW command surface (8 commands)", () => {
	const { pi, commands } = makeRecorderPi();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	factory(pi as any);
	expect(commands.sort()).toEqual(
		[
			"btw",
			"btw:tangent",
			"btw:new",
			"btw:clear",
			"btw:inject",
			"btw:summarize",
			"btw:model",
			"btw:thinking",
		].sort(),
	);
});

test("registers the BTW message renderer + lifecycle/context handlers", () => {
	const { pi, renderers, events } = makeRecorderPi();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	factory(pi as any);
	expect(renderers).toContain(BTW_MESSAGE_TYPE);
	expect(events.sort()).toEqual(["context", "session_shutdown", "session_start", "session_tree"]);
});

test("registers the 2 BTW focus-toggle shortcuts", () => {
	const { pi, shortcuts } = makeRecorderPi();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	factory(pi as any);
	expect(shortcuts).toHaveLength(2);
});
