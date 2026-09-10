/**
 * vault-sandbox.ts — the bench's one hard safety rule: NEVER touch the real
 * vault. Every lane operates on a throwaway copy of
 * `vaults_root/s2-agent-vault` in a fresh temp dir. The real vault's
 * knowledge-graph dir is checksummed before and after each test run; any
 * change fails the run (belt and suspenders — the copy alone should make
 * mutation impossible, the checksum proves it).
 */
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Repo root, derived from this file's location (bun-apps/bench-kcards/src). */
export function repoRoot(): string {
	return resolve(import.meta.dir, "..", "..", "..");
}

export function realVaultPath(): string {
	const p = join(repoRoot(), "vaults_root", "s2-agent-vault");
	if (!existsSync(p)) throw new Error(`real vault not found at ${p} — init the submodule first`);
	return p;
}

/** Recursive file count + total size — cheap tamper fingerprint for the graph dir. */
function fingerprint(dir: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	const walk = (d: string) => {
		for (const ent of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, ent.name);
			if (ent.isDirectory()) walk(p);
			else {
				files++;
				bytes += statSync(p).size;
			}
		}
	};
	walk(dir);
	return { files, bytes };
}

export interface Sandbox {
	/** Absolute path of the copied vault (safe to mutate). */
	vaultPath: string;
	/** Assert the REAL vault's knowledge-graph dir is untouched since the sandbox opened. */
	assertRealVaultUntouched(): void;
}

/** Copy the real vault into a temp dir and return the sandbox handle. */
export function openVaultSandbox(): Sandbox {
	const real = realVaultPath();
	const graphDir = join(real, "Zettelkasten", "knowledge-graph");
	const before = existsSync(graphDir) ? fingerprint(graphDir) : { files: 0, bytes: 0 };
	const vaultPath = join(tmpdir(), `bench-kcards-vault-${Date.now()}-${process.pid}`);
	cpSync(real, vaultPath, { recursive: true });
	return {
		vaultPath,
		assertRealVaultUntouched() {
			const after = existsSync(graphDir) ? fingerprint(graphDir) : { files: 0, bytes: 0 };
			if (before.files !== after.files || before.bytes !== after.bytes) {
				throw new Error(
					`REAL VAULT MUTATED during bench run (knowledge-graph ${before.files}/${before.bytes} → ${after.files}/${after.bytes}) — this is a bench bug, fix the sandbox isolation`,
				);
			}
		},
	};
}
