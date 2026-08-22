#!/usr/bin/env bun
/**
 * version-bump-cli — bump `bun-apps/s2-agent`'s version and keep its sync
 * sites in lockstep.
 *
 * `bun bun-apps/s2-agent-ext-devops/src/version-bump-cli.ts --package s2-agent [--patch|--minor|--major] [--dry-run]`
 *
 * WHY THIS EXISTS
 * ---------------
 * The deploy version is `<pkgVersion>+g<gitsha>` (scripts/lib/version.ts), so
 * the git sha did all the distinguishing while the pkgVersion prefix sat at
 * 0.1.0 forever. A 2026-08-07 decision record said "no release tooling — no
 * consumer reads a version"; the user overrode that on 2026-08-22: bumps are
 * MANUAL, at PR finish, via this CLI, with an advisory nudge from
 * merge-pr-after-ci when s2-agent changed without a bump.
 *
 * Policy: patch = any s2-agent change; minor = user-visible / host-contract
 * (hostApi/hostModules) change; major = breaking. Human judgment decides —
 * this tool only does the arithmetic and the mechanical sync.
 *
 * SYNC SITES (kept in lockstep, loud-fail when an anchor is missing):
 *   1. bun-apps/s2-agent/package.json        `version` field
 *   2. bun-apps/s2-agent/src/cli/dispatch.ts `const VERSION = "x.y.z";`
 *   The e2e literal pins were retired (tests read package.json) — do not add
 *   new ones.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliResult, defaultRepoRoot, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const VERSION_BUMP_CLI_USAGE = [
	"usage: version-bump-cli.ts --package s2-agent [--patch|--minor|--major] [--dry-run]",
	"",
	"Bumps bun-apps/s2-agent's semver and syncs every site that hardcodes it",
	"(package.json version + src/cli/dispatch.ts VERSION). The deploy pipeline",
	"then renders <newVersion>+g<sha> for the next version dir.",
	"",
	"Policy: patch = any change · minor = user-visible / host-contract change ·",
	"major = breaking. Run at PR finish, in the PR branch, and commit the bump",
	"with the change it names.",
	"",
	"Exit 0 bumped (or dry-run ok) · 1 failure (unknown package, non-x.y.z",
	"current version, missing sync anchor) · 2 usage error.",
	"Options:",
	"  --package <name>  only `s2-agent` is supported for now",
	"  --patch           bump x.y.z → x.y.(z+1)   (default)",
	"  --minor           bump x.y.z → x.(y+1).0",
	"  --major           bump x.y.z → (x+1).0.0",
	"  --dry-run         compute + report, mutate nothing",
	"  --repo-root <p>   default: the repo this file lives in",
].join("\n");

export type BumpLevel = "patch" | "minor" | "major";

export interface ParsedVersionBumpArgs {
	package: string;
	level: BumpLevel;
	dryRun: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseVersionBumpArgs(
	argv: string[],
): { ok: true; args: ParsedVersionBumpArgs } | { ok: false; message: string } {
	let pkg: string | undefined;
	let level: BumpLevel | undefined;
	let dryRun = false;
	let repoRoot: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--package") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--package needs a value" };
			pkg = v;
		} else if (a === "--patch" || a === "--minor" || a === "--major") {
			if (level) return { ok: false, message: `--${level} and ${a} are mutually exclusive` };
			level = a.slice(2) as BumpLevel;
		} else if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--repo-root needs a value" };
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	if (!pkg) return { ok: false, message: "--package is required (only `s2-agent` is supported for now)" };
	if (pkg !== "s2-agent") return { ok: false, message: `unsupported package: ${pkg} (only \`s2-agent\` for now)` };
	return { ok: true, args: { package: pkg, level: level ?? "patch", dryRun, repoRoot } };
}

/** Pure bump arithmetic. Rejects prerelease/buildmetadata forms (x.y.z only). */
export function bumpVersion(current: string, level: BumpLevel): { ok: true; next: string } | { ok: false; message: string } {
	const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return { ok: false, message: `current version is not plain x.y.z: "${current}" (bump manually if you need prerelease forms)` };
	const [x, y, z] = m.slice(1).map(Number);
	if (level === "major") return { ok: true, next: `${x + 1}.0.0` };
	if (level === "minor") return { ok: true, next: `${x}.${y + 1}.0` };
	return { ok: true, next: `${x}.${y}.${z + 1}` };
}

/** Anchor patterns — loud-fail beats silently leaving a stale literal. */
export function rewritePkgJson(raw: string, from: string, to: string): { ok: true; value: string } | { ok: false; message: string } {
	const anchor = `"version": "${from}"`;
	if (!raw.includes(anchor)) return { ok: false, message: `package.json anchor missing: ${anchor}` };
	return { ok: true, value: raw.replace(anchor, `"version": "${to}"`) };
}

export function rewriteDispatch(raw: string, from: string, to: string): { ok: true; value: string } | { ok: false; message: string } {
	const anchor = `const VERSION = "${from}";`;
	if (!raw.includes(anchor)) {
		return { ok: false, message: `dispatch.ts anchor missing: ${anchor} (moved or renamed? update this tool)` };
	}
	return { ok: true, value: raw.replace(anchor, `const VERSION = "${to}";`) };
}

export async function runVersionBumpCli(
	argv: string[],
	deps: { repoRoot?: string } = {},
): Promise<CliResult> {
	const parsed = parseVersionBumpArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: VERSION_BUMP_CLI_USAGE };
		return usageError(parsed.message, VERSION_BUMP_CLI_USAGE);
	}
	const repoRoot = parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot();
	const pkgJsonPath = join(repoRoot, "bun-apps", parsed.args.package, "package.json");
	const dispatchPath = join(repoRoot, "bun-apps", parsed.args.package, "src", "cli", "dispatch.ts");

	try {
		const pkgRaw = await readFile(pkgJsonPath, "utf8");
		const current = (JSON.parse(pkgRaw) as { version?: string }).version;
		if (typeof current !== "string") {
			return jsonResult(1, { ok: false, error: `no version field in ${pkgJsonPath}` });
		}
		const b = bumpVersion(current, parsed.args.level);
		if (!b.ok) return jsonResult(1, { ok: false, error: b.message });

		const newPkg = rewritePkgJson(pkgRaw, current, b.next);
		if (!newPkg.ok) return jsonResult(1, { ok: false, error: newPkg.message });
		let dispatchRaw: string;
		try {
			dispatchRaw = await readFile(dispatchPath, "utf8");
		} catch {
			return jsonResult(1, { ok: false, error: `cannot read ${dispatchPath}` });
		}
		const newDispatch = rewriteDispatch(dispatchRaw, current, b.next);
		if (!newDispatch.ok) return jsonResult(1, { ok: false, error: newDispatch.message });

		if (!parsed.args.dryRun) {
			await writeFile(pkgJsonPath, newPkg.value);
			await writeFile(dispatchPath, newDispatch.value);
		}
		return jsonResult(0, {
			ok: true,
			package: parsed.args.package,
			from: current,
			to: b.next,
			level: parsed.args.level,
			dryRun: parsed.args.dryRun,
			files: parsed.args.dryRun ? [] : [pkgJsonPath, dispatchPath],
		});
	} catch (e) {
		return jsonResult(1, { ok: false, error: e instanceof Error ? e.message : String(e) });
	}
}

if (import.meta.main) emit(await runVersionBumpCli(Bun.argv.slice(2)));
