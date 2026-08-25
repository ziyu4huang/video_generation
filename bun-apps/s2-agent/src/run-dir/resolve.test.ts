import { beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import manifest from "./manifest.json";
import {
	buildArgvFromManifest,
	resolveRunDirArgv,
	suppressResolvedArgv,
	runtimeDependencyNames,
} from "./resolve.ts";

// detectMode's own suite lives at src/mode.test.ts (the canonical seam test —
// .ts→source, .js→bundle, own-URL→source). This file keeps only the
// argv/manifest resolution behavior that is its real subject.
// (dedup 2026-08-25, round-2 ticket 03)

describe("buildArgvFromManifest", () => {
	function setup() {
		const base = mkdtempSync(join(tmpdir(), "pi-rundir-"));
		// Normalize manifest v2 entries: objects → their `entry` string.
		const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : (e as { entry: string }).entry));
		// materialize the manifest's relative entries under base
		for (const rel of extEntries) {
			const full = join(base, rel);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, "// ext");
		}
		for (const rel of manifest.skills ?? []) {
			mkdirSync(join(base, rel), { recursive: true });
		}
		return base;
	}

	test("workspace extensions → -e pairs under base, all present", () => {
		const base = setup();
		const warns: string[] = [];
		const argv = buildArgvFromManifest(manifest, base, [], () => true, (m) => warns.push(m));
		// every declared extension appears as `-e <base>/<rel>`
		const extEntries = (manifest.extensions ?? []).map((e) => (typeof e === "string" ? e : (e as { entry: string }).entry));
		for (const rel of extEntries) {
			expect(argv).toContain("-e");
			expect(argv).toContain(join(base, rel));
		}
		expect(warns).toHaveLength(0);
	});

	test("skills → --skill pairs under base", () => {
		const base = setup();
		const argv = buildArgvFromManifest(manifest, base, [], () => true, () => {});
		for (const rel of manifest.skills ?? []) {
			expect(argv).toContain("--skill");
			expect(argv).toContain(join(base, rel));
		}
	});

	test("missing extension path is skipped + warned", () => {
		// exists=false for everything → no -e/--skill emitted, all warned
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: ["a/x.ts"], skills: ["s"] },
			"/base",
			[],
			() => false,
			(m) => warns.push(m),
		);
		expect(argv).toEqual([]);
		expect(warns.some((w) => w.includes("extension path not found"))).toBe(true);
		expect(warns.some((w) => w.includes("skill path not found"))).toBe(true);
	});

	test("malformed entry (object missing 'entry') is skipped + warned, not a crash (I-1)", () => {
		// A declared object without `entry` previously made path.join throw an
		// opaque "paths[1] must be a string" TypeError at boot. Manifest entries
		// arrive as raw JSON (not typed literals), so simulate that reality and
		// assert the guard skips + warns instead of crashing.
		const malformed = JSON.parse('{"name":"phantom"}'); // raw object, no `entry`
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: [malformed, "real/x.ts"] },
			"/base",
			[],
			() => true,
			(m) => warns.push(m),
		);
		expect(argv).toEqual(["-e", join("/base", "real/x.ts")]);
		expect(warns.some((w) => w.includes("missing 'entry'") && w.includes("phantom"))).toBe(true);
	});

	test("undefined base → workspace ext + skills skipped, npm ext still included, warned once for base", () => {
		const warns: string[] = [];
		const argv = buildArgvFromManifest(
			{ extensions: ["a/x.ts"], skills: ["s"] },
			undefined,
			["/npm/pkg/index.ts"],
			(p) => p.startsWith("/npm"),
			(m) => warns.push(m),
		);
		// only the npm extension survives
		expect(argv).toEqual(["-e", "/npm/pkg/index.ts"]);
		expect(warns.some((w) => w.includes("could not determine bun-apps/"))).toBe(true);
		// workspace ext + skill NOT assembled (no base to join against) → not warned as "not found"
		expect(warns.some((w) => w.includes("extension path not found"))).toBe(false);
		expect(warns.some((w) => w.includes("skill path not found"))).toBe(false);
	});

	test("npm extensions appended AFTER workspace extensions", () => {
		const base = setup();
		const argv = buildArgvFromManifest(
			{ extensions: ["z.ts"] },
			base,
			["/npm/a.ts", "/npm/b.ts"],
			() => true,
			() => {},
		);
		const lastWorkspace = argv.lastIndexOf(join(base, "z.ts"));
		const firstNpm = argv.indexOf("/npm/a.ts");
		expect(lastWorkspace).toBeGreaterThan(-1);
		expect(firstNpm).toBeGreaterThan(lastWorkspace);
	});

	test("empty manifest → empty argv", () => {
		expect(buildArgvFromManifest({}, "/base", [], () => true, () => {})).toEqual([]);
	});

	test("uses the injected exists predicate (not real fs) — a present-on-disk but 'absent' path is skipped", () => {
		const base = setup();
		const argv = buildArgvFromManifest(
			{ extensions: ["z.ts"] },
			base,
			[],
			() => false, // pretend nothing exists
			() => {},
		);
		expect(argv).toEqual([]);
	});
});

describe("resolveRunDirArgv (integration, source mode against the real repo)", () => {
	test("every returned path is absolute and exists on disk", async () => {
		const argv = await resolveRunDirArgv();
		expect(argv.length).toBeGreaterThan(0);
		for (let i = 0; i < argv.length; i++) {
			const tok = argv[i]!;
			if (tok === "-e" || tok === "--skill") {
				const path = argv[i + 1]!;
				expect(path.startsWith("/")).toBe(true); // absolute
				expect(existsSync(path)).toBe(true);
				i++; // consume the path token
			} else if (tok === "-ne") {
				continue;
			} else {
				throw new Error(`unexpected token in source-mode argv: ${tok}`);
			}
		}
	});

	test("resolves at least the manifest's workspace extensions + skills", async () => {
		const argv = await resolveRunDirArgv();
		const set = new Set(argv);
		// workspace extensions present in manifest should appear (they exist in this repo)
		expect((manifest.extensions ?? []).length).toBeGreaterThan(0);
		// at least one -e and the skill dir
		expect(argv).toContain("-e");
		expect(argv.filter((t) => t === "-e").length).toBeGreaterThanOrEqual(
			(manifest.extensions ?? []).length,
		);
		// skill dir resolves
		for (const rel of manifest.skills ?? []) {
			expect([...set].some((p) => p.endsWith(rel))).toBe(true);
		}
	});

	test("user -ne/-ns suppress the injected -e/--skill pairs", async () => {
		const suppressed = await resolveRunDirArgv({ noExtensions: true, noSkills: true });
		expect(suppressed).not.toContain("-e");
		expect(suppressed).not.toContain("--skill");

		// -ne alone keeps skills flowing
		const extOnly = await resolveRunDirArgv({ noExtensions: true });
		expect(extOnly).not.toContain("-e");
		expect(extOnly).toContain("--skill");

		// default (no flags) is unchanged
		const full = await resolveRunDirArgv();
		expect(full).toContain("-e");
	});
});

describe("suppressResolvedArgv", () => {
	const argv = ["-ne", "-e", "/a/ext.ts", "--skill", "/a/skills", "-e", "/b/ext.js"];

	test("noExtensions strips -e pairs, keeps --skill and bare -ne", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true })).toEqual([
			"-ne",
			"--skill",
			"/a/skills",
		]);
	});

	test("noSkills strips --skill pairs only", () => {
		expect(suppressResolvedArgv(argv, { noSkills: true })).toEqual([
			"-ne",
			"-e",
			"/a/ext.ts",
			"-e",
			"/b/ext.js",
		]);
	});

	test("both flags leave only the bare -ne marker; no flags is identity", () => {
		expect(suppressResolvedArgv(argv, { noExtensions: true, noSkills: true })).toEqual(["-ne"]);
		expect(suppressResolvedArgv(argv, {})).toEqual(argv);
	});

	test("--extension long form is stripped like -e", () => {
		expect(
			suppressResolvedArgv(["--extension", "/a/ext.ts", "--skill", "/s"], { noExtensions: true }),
		).toEqual(["--skill", "/s"]);
	});
});

describe("runtimeDependencyNames", () => {
	test("returns dependencies when only those are declared", () => {
		expect(runtimeDependencyNames({ dependencies: { "js-yaml": "^4.0.0" } })).toEqual(["js-yaml"]);
	});

	test("returns peerDependencies (the pi-tui regression)", () => {
		// @earendil-works/pi-tui is declared as a peerDependency in several
		// extensions; the probe MUST surface it or the self-heal in check-deps.ts
		// never installs it, and pi crashes with "Cannot find module" on launch.
		expect(
			runtimeDependencyNames({ peerDependencies: { "@earendil-works/pi-tui": "0.80.10" } }),
		).toEqual(["@earendil-works/pi-tui"]);
	});

	test("returns devDependencies (typebox is a runtime import in some exts)", () => {
		expect(runtimeDependencyNames({ devDependencies: { typebox: "^1.3.6" } })).toEqual(["typebox"]);
	});

	test("unions + dedupes all three sections, dependencies-first order", () => {
		const names = runtimeDependencyNames({
			dependencies: { "js-yaml": "^4.0.0", shared: "*" },
			peerDependencies: { "@earendil-works/pi-tui": "0.80.10", shared: "*" },
			devDependencies: { typebox: "^1.3.6" },
		});
		expect(names).toEqual(["js-yaml", "shared", "@earendil-works/pi-tui", "typebox"]);
	});

	test("empty/undefined sections → empty array", () => {
		expect(runtimeDependencyNames({})).toEqual([]);
	});
});
