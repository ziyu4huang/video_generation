/**
 * sh-version.ts — version naming, target resolution, and the `current` symlink.
 *
 * The symlink is relative (`current -> 0.1.0+g520acb9`) so the whole out root
 * can be moved without breaking it, and it is swapped via rename() so a reader
 * never observes a missing `current`.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join } from "node:path";

export function computeVersion(opts: { pkgVersion: string; gitSha: string | null; useGitSha: boolean }): string {
	if (!opts.useGitSha || !opts.gitSha) return opts.pkgVersion;
	return `${opts.pkgVersion}+g${opts.gitSha.slice(0, 7)}`;
}

export function resolveTargetDir(outRoot: string, version: string): string {
	if (version.includes("/") || version.includes("\\") || version === "." || version === "..") {
		throw new Error(`invalid version string "${version}": must not contain a path separator`);
	}
	return join(outRoot, version);
}

/** Point <outRoot>/current at <version>. The version dir must already exist. */
export function swapCurrent(outRoot: string, version: string): void {
	const target = join(outRoot, version);
	if (!existsSync(target)) throw new Error(`cannot point current at "${version}": ${target} does not exist`);

	const link = join(outRoot, "current");
	if ((existsSync(link) || isSymlink(link)) && !isSymlink(link)) {
		throw new Error(`${link} exists and is not a symlink — refusing to replace it`);
	}
	// Create a temp link then rename over the old one: rename is atomic, so a
	// concurrent reader sees either the old target or the new one, never none.
	const tmp = join(outRoot, `.current-swap-${process.pid}`);
	if (existsSync(tmp) || isSymlink(tmp)) rmSync(tmp, { force: true });
	symlinkSync(version, tmp);
	renameSync(tmp, link);
}

export function listVersions(outRoot: string): { versions: string[]; current: string | null } {
	if (!existsSync(outRoot)) return { versions: [], current: null };
	const versions = readdirSync(outRoot)
		.filter((n) => n !== "current" && !n.startsWith("."))
		.filter((n) => {
			try {
				return lstatSync(join(outRoot, n)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
	const link = join(outRoot, "current");
	const current = isSymlink(link) ? readlinkSync(link) : null;
	return { versions, current };
}

/** Create the out root if needed (deploys must work on a fresh machine). */
export function ensureOutRoot(outRoot: string): void {
	mkdirSync(outRoot, { recursive: true });
}

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
