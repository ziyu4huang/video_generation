/**
 * In-package shared test utilities (round-2 ticket 04, 2026-08-25).
 *
 * Homes the three previously-copy-per-file patterns:
 *   §1 makeMockPi      — recording mock pi for extension factories (was ×3)
 *   §2 spawn capture   — sync + async Bun subprocess drain (was ~8 privates)
 *   §3 tempDir         — mkdtemp + registered afterAll cleanup (was ×17)
 *
 * In-package ONLY: this is not a cross-package share (map D3 — makeMockPi's
 * cross-package dedup is its own follow-up). Keep it import-light: node
 * builtins + Bun globals only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── §1 makeMockPi ───────────────────────────────────────────────────────────

interface ToolLike {
	name?: unknown;
	[key: string]: unknown;
}

interface CommandLike {
	name?: string;
	handler?: unknown;
}

export interface MockPiResult {
	pi: Record<string, unknown>;
	tools: ToolLike[];
	commands: CommandLike[];
	shortcuts: Array<{ key: string; opts: unknown }>;
	onCount: number;
}

/**
 * Recording mock pi — enough surface for an extension factory to register.
 * Union of the three former variants (extension-contract.test.ts's full
 * recorder, tool-name-contract.test.ts's name collector, and
 * extension-shortcut-guard.test.ts's shortcut recorder): every register* call
 * is captured, everything else is the no-op/const surface those suites
 * asserted factories tolerate.
 */
export function makeMockPi(): MockPiResult {
	const tools: ToolLike[] = [];
	const commands: CommandLike[] = [];
	const shortcuts: Array<{ key: string; opts: unknown }> = [];
	let onCount = 0;
	const pi = {
		registerTool: (t: ToolLike) => {
			tools.push(t);
			return t;
		},
		registerCommand: (name: string, opts: CommandLike) => {
			commands.push({ name, handler: opts?.handler });
		},
		registerShortcut: (key: string, opts: unknown) => {
			shortcuts.push({ key, opts });
		},
		registerMessageRenderer: () => {},
		registerFlag: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setActiveTools: () => {},
		getActiveTools: () => [] as string[],
		getFlag: () => undefined,
		getThinkingLevel: () => "medium",
		setModel: async () => true,
		on: () => {
			onCount++;
		},
		events: {
			on: () => () => {}, // returns unsubscribe
			off: () => {},
			once: () => () => {},
			emit: () => {},
		},
		getAllTools: () => tools,
		exec: async () => "",
		z: { undefined: () => ({}) },
	};
	return { pi, tools, commands, shortcuts, get onCount() { return onCount; } };
}

// ── §2 spawn capture ────────────────────────────────────────────────────────

export interface SpawnResult {
	/** null → -1 coerced so assertions always have a finite value. */
	exitCode: number;
	stdout: string;
	stderr: string;
}

const dec = new TextDecoder();

/**
 * Sync subprocess run + output drain. The shared core of the former private
 * harnesses (e2e/_helpers runCli, boot-smoke runCanary, adhoc-extensions,
 * bundle-mode-anchor): spawn, pipe both streams, decode, coerce exitCode.
 * Per-suite env/cwd/cmd construction stays at the call site.
 */
export function spawnCaptureSync(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): SpawnResult {
	const proc = Bun.spawnSync({
		cmd,
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(opts.env ? { env: opts.env } : {}),
	});
	return {
		exitCode: proc.exitCode ?? -1,
		stdout: dec.decode(proc.stdout),
		stderr: dec.decode(proc.stderr),
	};
}

/**
 * Async subprocess run + full drain (patch-outcome's `-e` script runners,
 * cli-sh-main-argv's argv capture). Resolves only after the process exits AND
 * both streams are fully read.
 */
export async function spawnCaptureAsync(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<SpawnResult> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(opts.env ? { env: opts.env } : {}),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode: exitCode ?? -1, stdout, stderr };
}

// ── §3 tempDir ──────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/** mkdtemp under os.tmpdir(), registered for cleanupTempDirs(). */
export function tempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(d);
	return d;
}

/** rmSync every tempDir() this file handed out. Call from afterAll. */
export function cleanupTempDirs(): void {
	for (const d of tempDirs.splice(0)) {
		rmSync(d, { recursive: true, force: true });
	}
}
