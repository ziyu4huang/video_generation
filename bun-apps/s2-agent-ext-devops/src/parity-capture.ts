/**
 * parity-capture — run the fingerprint probe through ONE launcher and parse it.
 * Marker missing / unparseable / timeout → ok:false. The caller turns that
 * into a FAIL verdict (never skip): a silently-absent probe is the incident
 * class this gate exists for (host-module-map `-e` skip).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARITY_PROBE_SOURCE, parseParityFpLine, type ParityFingerprint } from "./parity-probe.js";
import type { SpawnFn } from "./spawn.js";

export const PARITY_PROBE_CAP_MS = 120_000;

export type CaptureParityResult = { ok: true; fp: ParityFingerprint } | { ok: false; error: string };

export async function captureParityFingerprint(
	launcherPath: string,
	mode: string,
	spawn: SpawnFn,
	capMs: number = PARITY_PROBE_CAP_MS,
): Promise<CaptureParityResult> {
	const workDir = mkdtempSync(join(tmpdir(), "parity-probe-"));
	try {
		const probePath = join(workDir, "parity-probe.ts");
		writeFileSync(probePath, PARITY_PROBE_SOURCE);
		// env: SpawnOptions.env is EXTRA vars MERGED over the inherited
		// process env by both live spawn paths (spawnDetached and
		// createLiveSpawn spread {...process.env, ...env}) — no manual
		// process.env spread needed here, exactly like the tools-probe's
		// pinSpawnEnv vars. The launcher keeps PATH & friends.
		const r = await spawn(launcherPath, ["-e", probePath, "-p", "hi", "--no-session"], {
			timeoutMs: capMs,
			env: { PARITY_MODE: mode },
		});
		if (r.timedOut) return { ok: false, error: `parity probe timed out after ${capMs}ms` };
		const p = parseParityFpLine(r.stderr);
		return p.ok ? { ok: true, fp: p.fp } : { ok: false, error: `${p.error} (exit=${r.exitCode})` };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}
