/**
 * runCli() must propagate the `process.exitCode = 1` failure convention.
 *
 * Several commands report failure WITHOUT throwing — they just set
 * process.exitCode and return:
 *   - commands/doctor.ts      (`if (!ok) process.exitCode = 1`)
 *   - commands/zk-query.ts    (unconverged coverage / failed health check)
 *
 * Before the merge, the CLI's entry block let the success path fall out of the
 * module with no process.exit() at all, so Bun honoured process.exitCode on the
 * way out. Now that src/cli.ts calls `process.exit(await runCli(argv))`, an
 * explicit numeric argument to process.exit() ALWAYS beats a previously-set
 * process.exitCode — so a hardcoded `return 0` here would silently turn every
 * one of those documented failures into a success.
 *
 * `version` is used as the vehicle because it only console.log()s and returns:
 * no model, no network, no filesystem writes, and (unlike the die() paths) no
 * process.exit() that would tear down the test runner.
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "../dispatch.ts";

/**
 * NOTE on restoring: Bun SILENTLY IGNORES `process.exitCode = undefined` (it
 * keeps the previous number; Node would clear it). So `saved` is coerced with
 * `?? 0` — otherwise a test that set 1 could never hand a clean slate to the
 * next test in this file, and the leak would show up as a bogus failure.
 *
 * That same quirk is why the genuinely-UNSET case (exitCode never assigned →
 * runCli returns 0 via the `typeof !== "number"` fallback) is not simulated
 * here: it is unreachable once anything has set a number. It is covered
 * instead by the e2e suite, whose 44 tests each spawn a fresh process where
 * nothing has touched process.exitCode and assert exit 0 on success paths.
 */
describe("runCli — process.exitCode propagation", () => {
	// runCli() also exports PI_SELF_ENTRY_PREFIX=cli for pi-agent-ext-subagent's
	// getPiInvocation() and never restores it — correct for the real entry, which
	// process.exit()s immediately, but these tests call runCli() IN-PROCESS. Bun
	// shares one process across a suite, so without this the var would leak into
	// every later test file. Same class of leak as the process.exitCode one above.
	const restore = (saved: typeof process.exitCode, savedPrefix: string | undefined) => {
		process.exitCode = typeof saved === "number" ? saved : 0;
		if (savedPrefix === undefined) delete process.env.PI_SELF_ENTRY_PREFIX;
		else process.env.PI_SELF_ENTRY_PREFIX = savedPrefix;
	};

	test("a command that set process.exitCode = 1 without throwing returns 1", async () => {
		const saved = process.exitCode;
		const savedPrefix = process.env.PI_SELF_ENTRY_PREFIX;
		try {
			// Simulate doctor/zk-query's non-throwing failure report.
			process.exitCode = 1;
			expect(await runCli(["version"])).toBe(1);
		} finally {
			restore(saved, savedPrefix);
		}
	});

	test("an explicit process.exitCode = 0 returns 0", async () => {
		const saved = process.exitCode;
		const savedPrefix = process.env.PI_SELF_ENTRY_PREFIX;
		try {
			process.exitCode = 0;
			expect(await runCli(["version"])).toBe(0);
		} finally {
			restore(saved, savedPrefix);
		}
	});

	test("a non-zero code other than 1 is propagated verbatim", async () => {
		const saved = process.exitCode;
		const savedPrefix = process.env.PI_SELF_ENTRY_PREFIX;
		try {
			process.exitCode = 3;
			expect(await runCli(["version"])).toBe(3);
		} finally {
			restore(saved, savedPrefix);
		}
	});
});
