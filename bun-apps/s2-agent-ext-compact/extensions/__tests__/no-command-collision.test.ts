/**
 * no-command-collision — pins slash-surface-consistency ticket 01's decision
 * (2026-08-29): pi ships a BUILTIN /compact (TUI onSubmit intercepts it before
 * extension dispatch ever runs), and this extension deliberately does NOT
 * register a slash command — it rides the host's session_before_compact hook
 * so BOTH the builtin /compact and auto-compaction flow through the CC-style
 * summarizer. If this test fails, someone added a command (likely "compact"),
 * which upstream would shadow in the TUI and suffix in the palette — reopen
 * .planning/2026-08-29-slash-surface-consistency ticket 01 before shipping.
 */
import { test, expect } from "bun:test";
import { createCompactExtension } from "../compact.ts";

const ENABLED = { enabled: true, modelOverrideSpec: undefined, maxTokensFactor: 0.8 };

/** Records every pi-API method call the factory makes (Proxy: unknown future
 *  APIs are recorded too, so the assertion set stays exhaustive). */
function recordPiCalls() {
	const calls: { method: string; args: unknown[] }[] = [];
	const pi = new Proxy(
		{},
		{
			get(_t, prop: string) {
				return (...args: unknown[]) => {
					calls.push({ method: prop, args });
				};
			},
		},
	);
	createCompactExtension({ config: ENABLED })(pi as never);
	return calls;
}

test("registers NO slash command — the hook is the only surface", () => {
	const calls = recordPiCalls();
	const commands = calls.filter((c) => /registercommand/i.test(c.method));
	expect(commands).toEqual([]);
	// And nothing named "compact" sneaks in through any other API either.
	expect(calls.some((c) => JSON.stringify(c.args).includes('"compact"'))).toBe(false);
});

test("exactly one session_before_compact handler is subscribed", () => {
	const calls = recordPiCalls().filter((c) => c.method === "on");
	expect(calls.map((c) => c.args[0])).toEqual(["session_before_compact"]);
});
