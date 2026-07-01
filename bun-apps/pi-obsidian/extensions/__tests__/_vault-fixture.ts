/**
 * Shared helper for tests that depend on the reference vault submodule
 * (vaults_root/pi-agent-vault). On a fresh `git clone` the submodule is NOT
 * initialized — its directory is empty — and vault-driven tests would fail
 * opaquely. Gate them with `it.skipIf(!vaultAvailable())` / `describe.skipIf`
 * so they skip with a clear reason instead.
 *
 * Initialize the fixture with:  git submodule update --init vaults_root/pi-agent-vault
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const VAULT = join(REPO_ROOT, "vaults_root", "pi-agent-vault");

/** True when the reference vault submodule is checked out (non-empty). */
export function vaultAvailable(): boolean {
	try {
		return existsSync(VAULT) && readdirSync(VAULT).some((n) => !n.startsWith("."));
	} catch {
		return false;
	}
}

export const SKIP_REASON = "vaults_root/pi-agent-vault submodule not initialized — run `git submodule update --init`";
