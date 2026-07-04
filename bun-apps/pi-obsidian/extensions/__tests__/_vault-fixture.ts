/**
 * Shared helper for tests that depend on the reference vault submodule
 * (vaults_root/pi-agent-vault). On a fresh `git clone` the submodule is NOT
 * initialized — its directory is empty — and vault-driven tests would fail
 * opaquely. Gate them with `it.skipIf(!vaultAvailable())` / `describe.skipIf`
 * so they skip with a clear reason instead.
 *
 * Initialize the fixture with:  git submodule update --init vaults_root/pi-agent-vault
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const VAULT = join(REPO_ROOT, "vaults_root", "pi-agent-vault");

// Anchor file that proves the submodule was actually populated (not just
// half-initialized with a stray file from an aborted `submodule update`).
const VAULT_ANCHOR = join(VAULT, "Tags", "Index.md");

/** True when the reference vault submodule is checked out AND populated. */
export function vaultAvailable(): boolean {
	try {
		return existsSync(VAULT_ANCHOR);
	} catch {
		return false;
	}
}

export const SKIP_REASON = "vaults_root/pi-agent-vault submodule not initialized — run `git submodule update --init`";
