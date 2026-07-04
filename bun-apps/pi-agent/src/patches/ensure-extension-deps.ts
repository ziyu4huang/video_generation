/**
 * ensure-extension-deps.ts — make extension bare specifiers natively resolvable.
 *
 * PROBLEM (the real root cause of "extension won't load" in source/dev mode):
 * pi loads each `-e` extension via `createJiti({ alias: getAliases() })`. For the
 * FIRST extension module jiti tries `try-native` (Bun imports the .ts directly),
 * but that fails because the extension's bare specifiers — `@earendil-works/*`,
 * `typebox` — are declared as peerDependencies and are NOT on the node_modules
 * walk-up path from the extension's own file. jiti then falls back to transforming
 * every module in the graph. Under Bun + jiti 2.7.0, any transformed module over
 * ~4 KB trips `JITI_ESM_EVAL_TEMP_FILE`'s temp-file path, which fails with
 * `Cannot find module .../jiti-esm/binary-*.mjs from ''`. So ANY extension whose
 * graph contains a >4 KB module (pi-agent-ext-flux2/src/binary.ts, krea2's, the
 * 40 KB+ pi-hermes-memory modules) is un-loadable. (Setting the env to false just
 * restores `NameTooLong` instead — both jiti paths are broken under Bun.)
 *
 * FIX: if the bare specifiers ARE on the node_modules walk-up path, `try-native`
 * SUCCEEDS — Bun imports the .ts graph natively (Bun handles .ts, and there is no
 * module-size limit), so jiti never transforms anything and the bug never fires.
 * This patch creates repo-root `node_modules/` symlinks for exactly the packages
 * `getAliases()` would resolve, pointing at the SAME global-store copies (so the
 * host and every extension share ONE typebox / pi-coding-agent instance — no
 * version drift). Repo root is on the walk-up path from every `bun-apps/*` member.
 *
 * SOURCE mode only. Bundle mode symlinks its own node_modules at build; binary
 * mode cannot load .ts extensions at all. Idempotent + cheap (relinks only when
 * the target moved, e.g. after a `bun install` that re-pinned a version).
 *
 * Env gate: BUN_PI_ENSURE_EXT_DEPS (default on). Reversible for debugging.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { mkdirSync, readlinkSync, symlinkSync, lstatSync, rmSync } from "node:fs";

// SOURCE mode only — match the same import.meta.url key the other mode-aware
// patches use (set-package-dir). Bundle = /dist/pi-agent/pi-agent.js; binary =
// $bunfs|~BUN. In those modes extension resolution is handled differently
// (bundle symlinks node_modules; binary can't load .ts), so this is a no-op.
const url = import.meta.url;
const isSource = url.includes("/src/patches/");

if (isSource) {
	const require = createRequire(url);

	// Resolve the four package roots extensions import as bare specifiers. Done
	// from THIS module's require context (pi-agent depends on pi-coding-agent, so
	// it resolves), then from pi-coding-agent's package.json for the transitive
	// peers (typebox, pi-agent-core, pi-ai) — exactly the resolution getAliases()
	// performs in pi's loader, so the symlink targets are byte-for-byte the same
	// copies the host uses.
	const pcaPkg = require.resolve("@earendil-works/pi-coding-agent/package.json");
	const fromPca = createRequire(pcaPkg);
	const pkgRoot = (spec: string): string | null => {
		try {
			return path.dirname(fromPca.resolve(`${spec}/package.json`));
		} catch {
			return null;
		}
	};

	const targets: Record<string, string | null> = {
		"@earendil-works/pi-coding-agent": pkgRoot("@earendil-works/pi-coding-agent"),
		"@earendil-works/pi-agent-core": pkgRoot("@earendil-works/pi-agent-core"),
		"@earendil-works/pi-ai": pkgRoot("@earendil-works/pi-ai"),
		typebox: pkgRoot("typebox"),
	};

	// Repo root = 4 levels up from bun-apps/pi-agent/src/patches/.
	const repoRoot = path.resolve(import.meta.dirname, "../../../..");
	const nmRoot = path.join(repoRoot, "node_modules");

	for (const [spec, abs] of Object.entries(targets)) {
		if (!abs) continue;
		const linkPath = path.join(nmRoot, spec);
		try {
			mkdirSync(path.dirname(linkPath), { recursive: true });
		} catch {
			/* directory may already exist */
		}
		let current: string | null = null;
		try {
			current = readlinkSync(linkPath);
		} catch {
			/* not a symlink — recreate below */
		}
		if (current === abs) continue; // already correct — no-op (the common case)
		try {
			if (lstatSync(linkPath).isDirectory()) {
				rmSync(linkPath, { recursive: true, force: true });
			} else {
				rmSync(linkPath, { force: true });
			}
		} catch {
			/* doesn't exist — fine */
		}
		try {
			symlinkSync(abs, linkPath);
		} catch (e) {
			// Best-effort: a failed symlink falls back to jiti's alias path, which
			// still works for <4 KB extensions. Warn, don't crash the agent.
			console.error(`[ensure-extension-deps] could not symlink ${spec} -> ${abs}: ${(e as Error).message}`);
		}
	}
}

export const __test = { isSource };
