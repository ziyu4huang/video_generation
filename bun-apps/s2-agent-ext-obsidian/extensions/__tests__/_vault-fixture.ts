/**
 * Shared helper for tests that depend on the reference vault submodule
 * (vaults_root/s2-agent-vault). On a fresh `git clone` the submodule is NOT
 * initialized — its directory is empty — and vault-driven tests would fail
 * opaquely. Gate them with `it.skipIf(!vaultAvailable())` / `describe.skipIf`
 * so they skip with a clear reason instead.
 *
 * Initialize the fixture with:  git submodule update --init vaults_root/s2-agent-vault
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const VAULT = join(REPO_ROOT, "vaults_root", "s2-agent-vault");

// The exact command that syncs the submodule to the commit the superproject
// records. Surfaced in every drift message so the fix is copy-pasteable.
export const VAULT_SYNC_CMD = "git submodule update --init vaults_root/s2-agent-vault";

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

export const SKIP_REASON = [
	"vaults_root/s2-agent-vault submodule not initialized.",
	`  Fix: \`${VAULT_SYNC_CMD}\``,
	"  Submodule-free contract guard: `bun run regen:contract` (runs against fixtures/frozen-vault/).",
].join("\n");

/**
 * Detect submodule POINTER drift and return a one-line, copy-pasteable fix.
 *
 * `vaultAvailable()` only checks the anchor file EXISTS — but a drifted
 * submodule (working tree at commit X, superproject records commit Y) has the
 * anchor present yet DIFFERENT content, so byte-for-byte baseline tests emit a
 * useless 200-line diff instead of telling you the submodule is stale.
 *
 * Returns null when the submodule is at the commit the superproject records
 * (clean) — in which case any baseline mismatch is a genuine content/regen
 * issue, NOT submodule drift, and the existing diff is the right signal.
 *
 * `git submodule status` prefix legend:
 *   ' '  at recorded commit (clean)
 *   '-'  not initialized
 *   '+'  checked-out commit ≠ recorded (DRIFT — the common case after a
 *        `git pull`/`checkout` that bumped the pointer without recursing)
 *   'U'  merge conflict
 */
export function vaultDriftReason(): string | null {
	// Anchor missing = not initialized at all; the describe.skipIf already
	// handles that. Only probe git when the tree *looks* populated.
	if (!existsSync(VAULT_ANCHOR)) return null;
	try {
		const status = execSync("git submodule status vaults_root/s2-agent-vault", {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
		const flag = status[0];
		if (flag === " " || flag === undefined) return null; // clean / at recorded commit
		if (flag === "+") {
			return `vaults_root/s2-agent-vault is DRIFTED (checked-out commit ≠ recorded by superproject). ` +
				`Baseline byte-diff is meaningless until synced. Fix:\n  ${VAULT_SYNC_CMD}`;
		}
		if (flag === "-") return `vaults_root/s2-agent-vault not initialized. Fix:\n  ${VAULT_SYNC_CMD}`;
		if (flag === "U") return `vaults_root/s2-agent-vault has a merge conflict. Resolve, then:\n  ${VAULT_SYNC_CMD}`;
		return null;
	} catch {
		return null; // git unavailable / not a repo — anchor check above is enough
	}
}
