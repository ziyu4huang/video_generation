import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PRINT_IDLE_EXIT_MS,
	armPrintIdleWatchdog,
	finishPrintMode,
	isPrintModeArgv,
	printIdleExitMsFromEnv,
	type WatchdogDeps,
} from "./print-idle-watchdog.ts";

function makeDeps(overrides: Partial<WatchdogDeps> = {}): WatchdogDeps & {
	logs: string[];
	exits: number[];
} {
	const logs: string[] = [];
	const exits: number[] = [];
	return {
		lastWrite: () => 0,
		now: () => 1000,
		setInterval: (fn) => {
			fn();
			return () => {};
		},
		log: (line) => logs.push(line),
		exit: (code) => exits.push(code),
		activeResources: () => ["TCPSocketWrap"],
		...overrides,
		logs,
		exits,
	} as WatchdogDeps & { logs: string[]; exits: number[] };
}

describe("printIdleExitMsFromEnv", () => {
	test("default when unset", () => {
		expect(printIdleExitMsFromEnv({})).toBe(DEFAULT_PRINT_IDLE_EXIT_MS);
	});
	test("parses a positive integer", () => {
		expect(printIdleExitMsFromEnv({ S2_PRINT_IDLE_EXIT_MS: "4500" })).toBe(4500);
	});
	test("0 disables", () => {
		expect(printIdleExitMsFromEnv({ S2_PRINT_IDLE_EXIT_MS: "0" })).toBe(0);
	});
	test("garbage falls back to the default", () => {
		expect(printIdleExitMsFromEnv({ S2_PRINT_IDLE_EXIT_MS: "soon" })).toBe(
			DEFAULT_PRINT_IDLE_EXIT_MS,
		);
		expect(printIdleExitMsFromEnv({ S2_PRINT_IDLE_EXIT_MS: "-5" })).toBe(
			DEFAULT_PRINT_IDLE_EXIT_MS,
		);
	});
});

describe("isPrintModeArgv", () => {
	test("-p and --print arm; their absence does not", () => {
		expect(isPrintModeArgv(["-p", "hi"])).toBe(true);
		expect(isPrintModeArgv(["--print", "hi"])).toBe(true);
		expect(isPrintModeArgv(["--mode", "json", "hi"])).toBe(false);
	});
});

describe("armPrintIdleWatchdog", () => {
	test("fires exit 2 with a resource dump once past the idle deadline", () => {
		const d = makeDeps({ lastWrite: () => 0, now: () => 60_001 });
		armPrintIdleWatchdog(60_000, d);
		expect(d.exits).toEqual([2]);
		expect(d.logs[0]).toContain("no stdout activity for 60s");
		expect(d.logs[0]).toContain("TCPSocketWrap");
	});
	test("fresh stdout activity keeps it silent", () => {
		const d = makeDeps({ lastWrite: () => 59_000, now: () => 60_000 });
		armPrintIdleWatchdog(60_000, d);
		expect(d.exits).toEqual([]);
		expect(d.logs).toEqual([]);
	});
	test("idleMs 0 never arms", () => {
		const d = makeDeps({ lastWrite: () => 0, now: () => 1e9 });
		armPrintIdleWatchdog(0, d);
		expect(d.exits).toEqual([]);
	});
});

describe("finishPrintMode", () => {
	test("dumps lingering resources and exits 0 after the grace", () => {
		const d = makeDeps();
		let fired: (() => void) | undefined;
		finishPrintMode(2_000, {
			log: d.log,
			exit: d.exit,
			activeResources: () => ["Timeout"],
			setTimeout: (fn) => {
				fired = fn;
			},
		});
		expect(d.logs[0]).toContain("main() resolved with active event-loop resources");
		expect(d.logs[0]).toContain("Timeout");
		expect(d.exits).toEqual([]);
		fired!();
		expect(d.exits).toEqual([0]);
	});
	test("drained loop logs nothing but still exits after the grace", () => {
		const d = makeDeps();
		let fired: (() => void) | undefined;
		finishPrintMode(0, {
			log: d.log,
			exit: d.exit,
			activeResources: () => [],
			setTimeout: (fn) => {
				fired = fn;
			},
		});
		expect(d.logs).toEqual([]);
		fired!();
		expect(d.exits).toEqual([0]);
	});
});
