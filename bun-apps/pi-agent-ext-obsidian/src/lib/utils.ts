import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";

export const execFileP = promisify(execFile);

export function _findMonorepoRoot(from: string | undefined): string {
	if (!from) return "(repo root)";
	let dir = from;
	while (dir !== dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.workspaces) return dir;
		} catch {
			/* no package.json or unreadable — keep walking up */
		}
		dir = dirname(dir);
	}
	return "(repo root)";
}

export function _missingDeps(deps: string[], from: string | undefined): string[] {
	if (!from) return [];
	// Compiled-binary mode: `from` is a $bunfs/~BUN virtual path — deps are
	// inlined into the binary at build time, and walking the REAL filesystem up
	// from a virtual path can never find node_modules (always false-alarms).
	if (from.includes("$bunfs") || from.includes("~BUN") || from.includes("%7EBUN")) return [];
	return deps.filter((dep) => {
		const pkgName = dep.startsWith("@")
			? dep.split("/").slice(0, 2).join("/")
			: dep.split("/")[0] ?? dep;
		let dir = from;
		while (true) {
			if (existsSync(join(dir, "node_modules", pkgName, "package.json")))
				return false;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return true;
	});
}
