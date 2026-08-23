/**
 * Print-mode idle watchdog — bounds `.planning/2026-08-23-headless-dispatch-hang`
 * ticket 01 (B1/B3: a headless `-p` run that finished its work but never exited).
 *
 * Two observed hang shapes (2026-08-23, this machine):
 *   (a) `main()` resolved, agent settled, but a lingering handle kept the
 *       bun event loop from draining — the process idled at 0% CPU forever.
 *   (b) `main()` never resolved (post-main code never ran) — time-windowed
 *       by concurrent deploy/probe s2-agent processes sharing ~/.pi state.
 *
 * The watchdog is armed in cli.ts BEFORE `await main(...)` when argv requests
 * print mode. It stamps every `process.stdout.write` (in print mode stdout
 * carries the event stream — a healthy run, however long, never goes silent
 * for minutes: deltas stream continuously), and fires when stdout has been
 * silent past the idle deadline: it dumps the resources holding the event
 * loop (`process.getActiveResourcesInfo()`) to stderr and exits 2, turning
 * any recurrence into captured evidence instead of a silent forever-hang.
 *
 * Shape (a) is additionally handled after `main()` resolves: dump remaining
 * active resources and exit 0 after a short flush grace — natural exit when
 * the loop already drained, forced when a handle lingers.
 *
 * Config: `S2_PRINT_IDLE_EXIT_MS` (idle deadline; default 300_000 = 5 min,
 * `0` disables). Diagnostics go to stderr; stdout stays protocol-clean.
 */

export const DEFAULT_PRINT_IDLE_EXIT_MS = 300_000;

/** Read the idle deadline from the environment. 0 disables the watchdog. */
export function printIdleExitMsFromEnv(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env.S2_PRINT_IDLE_EXIT_MS;
	if (raw === undefined) return DEFAULT_PRINT_IDLE_EXIT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PRINT_IDLE_EXIT_MS;
	return Math.floor(parsed);
}

/** True when argv (flags only, after the program name) requests print mode. */
export function isPrintModeArgv(argv: readonly string[]): boolean {
	return argv.includes("-p") || argv.includes("--print");
}

export interface WatchdogDeps {
	/** Stamp of the last stdout activity (ms). */
	lastWrite: () => number;
	/** Current time (ms). */
	now: () => number;
	/** Schedule a repeating check. Return a cancel fn. */
	setInterval: (fn: () => void, ms: number) => () => void;
	/** Log the diagnostic (stderr). */
	log: (line: string) => void;
	/** Terminate the process. */
	exit: (code: number) => void;
	/** Override the event-loop resource dump (tests). Optional. */
	activeResources?: () => string[] | null;
}

export interface ArmedWatchdog {
	/** Cancel the watchdog (unused today; kept for symmetry/testability). */
	disarm: () => void;
}

/**
 * Arm the idle watchdog. `lastWriteAt` must be initialized to "now" at arm
 * time — a run that produces NO stdout at all is itself the hang shape and
 * should still be bounded.
 */
export function armPrintIdleWatchdog(
	idleMs: number,
	deps: WatchdogDeps,
): ArmedWatchdog {
	if (idleMs <= 0) return { disarm: () => {} };
	const cancel = deps.setInterval(() => {
		const idleFor = deps.now() - deps.lastWrite();
		if (idleFor < idleMs) return;
		deps.log(
			`[print-idle-watchdog] no stdout activity for ${Math.round(idleFor / 1000)}s (deadline ${Math.round(idleMs / 1000)}s) — exiting 2. Active event-loop resources: ${JSON.stringify(
				deps.activeResources?.() ?? process.getActiveResourcesInfo?.() ?? "unavailable",
			)}`,
		);
		deps.exit(2);
	}, Math.min(idleMs, 5_000));
	return { disarm: cancel };
}

/**
 * Post-`main()` handler for print mode: dump anything still holding the loop
 * and exit after a short stdout-flush grace. When the loop already drained
 * this is a no-op race against natural exit.
 */
export function finishPrintMode(
	graceMs: number,
	deps: Pick<WatchdogDeps, "log" | "exit"> & {
		setTimeout: (fn: () => void, ms: number) => void;
		activeResources?: () => string[] | null;
	},
): void {
	const active = deps.activeResources?.() ?? process.getActiveResourcesInfo?.() ?? null;
	if (active && active.length > 0) {
		deps.log(
			`[print-idle-watchdog] main() resolved with active event-loop resources (exiting after ${graceMs}ms grace): ${JSON.stringify(active)}`,
		);
	}
	deps.setTimeout(() => deps.exit(0), graceMs);
}
