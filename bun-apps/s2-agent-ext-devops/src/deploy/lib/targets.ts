/**
 * targets.ts — cross-OS deploy target naming (crossos-deploy t05, D6/D7).
 *
 * A TARGET names the platform a deploy tree is FOR, not the machine
 * building it: `<platform>-<arch>` (plus `-musl` for a linux musl variant,
 * D4 keeps musl fog). The deploy routes a target's version dirs and
 * `current` under `<outRoot>/<target>/` while the content-addressed caches
 * (`.cores`/`.buns`) stay at the shared top level — the core hash has no
 * platform term and the bun hash folds platform+arch, so cross-target
 * sharing is exact, not incidental.
 */
import { detectLibc } from "./vendor-closure.ts";

export interface TargetSpec {
	platform: NodeJS.Platform;
	arch: string;
	/** linux-only convention; glibc implied for bare `linux-x64` (D4 matrix). */
	libc?: "glibc" | "musl";
}

const KNOWN_ARCHS = new Set(["x64", "arm64", "ia32"]);

/** The host's own target name — the `--target` default. */
export function hostTargetName(): string {
	return `${process.platform}-${process.arch}`;
}

/**
 * Parse `darwin-arm64` / `linux-x64` / `linux-x64-musl` / `win32-x64` into a
 * spec. Unknown-but-well-formed platform names parse fine (the matrix is
 * data, not a whitelist); a malformed name throws before any filesystem
 * layout depends on it.
 */
export function parseTargetName(name: string): TargetSpec {
	const m = /^([a-z0-9]+)-([a-z0-9]+)(?:-(musl|glibc))?$/.exec(name);
	if (!m || m[1] === undefined || m[2] === undefined) {
		throw new Error(
			`invalid --target "${name}": expected <platform>-<arch>[-musl|glibc], e.g. darwin-arm64, linux-x64, win32-x64`,
		);
	}
	const platform = m[1];
	const arch = m[2];
	const libc = m[3];
	if (!KNOWN_ARCHS.has(arch)) {
		throw new Error(`invalid --target "${name}": unknown arch "${arch}" (known: ${[...KNOWN_ARCHS].join(", ")})`);
	}
	if (libc && platform !== "linux") {
		throw new Error(`invalid --target "${name}": a libc suffix is a linux-only convention`);
	}
	return {
		platform: platform as NodeJS.Platform,
		arch,
		// D4: bare linux implies glibc; musl is the explicit opt-in.
		libc: platform === "linux" ? ((libc ?? "glibc") as "glibc" | "musl") : undefined,
	};
}

/**
 * True when the spec names the machine running the deploy (the default case).
 * libc-aware where it can be: on a linux host, `linux-x64` (glibc implied)
 * must NOT classify as host if the machine is musl — the host's bun would
 * ship under a target name promising the other flavor. Non-linux targets
 * have no libc convention, so platform+arch decides.
 */
export function isHostTarget(spec: TargetSpec): boolean {
	if (spec.platform !== process.platform || spec.arch !== process.arch) return false;
	if (spec.platform === "linux" && spec.libc && spec.libc !== detectLibc("linux")) return false;
	return true;
}

/**
 * The GitHub release artifact name for a target's bun (D7): tag
 * `bun-v<Bun.version>` carries per-target zips. Arch spellings follow
 * oven-sh's naming (arm64 → aarch64 on darwin/linux), NOT Node's.
 */
export function githubBunArtifact(spec: TargetSpec): string {
	const ovenArch = spec.arch === "arm64" ? "aarch64" : spec.arch;
	switch (spec.platform) {
		case "darwin":
			return `bun-darwin-${ovenArch}.zip`;
		case "linux":
			return `bun-linux-${ovenArch}${spec.libc === "musl" ? "-musl" : ""}.zip`;
		case "win32":
			return `bun-windows-${ovenArch}.zip`;
		default:
			throw new Error(`no bun release artifact mapping for platform "${spec.platform}"`);
	}
}

/** The executable name bun ships as inside the artifact / the tree's bin/ (t04's .ps1 expects both spellings). */
export function bunBinaryName(spec: TargetSpec): string {
	return spec.platform === "win32" ? "bun.exe" : "bun";
}

/**
 * Platform families the target grammar actually names today (D4 matrix).
 * Subroot CLASSIFICATION (version.ts's --list / current resolution) matches
 * on these prefixes only: a pre-t05 flat dir named e.g. `demo-run` must not
 * be misread as a target subroot. Deploying a target outside the known
 * families still parses (the grammar is data) — it just won't be classified
 * as a subroot by layout tools until taught here.
 */
const KNOWN_PLATFORM_PREFIXES = ["darwin-", "linux-", "win32-"];

export function isKnownTargetSubrootName(name: string): boolean {
	return KNOWN_PLATFORM_PREFIXES.some((p) => name.startsWith(p)) && /^[a-z0-9]+-[a-z0-9]+(?:-(?:musl|glibc))?$/.test(name);
}
