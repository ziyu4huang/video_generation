import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import manifest from "./manifest.json";
import {
	buildArgvFromManifest,
	detectMode,
	resolveRunDirArgv,
} from "./resolve.ts";

describe("detectMode", () => {
	test("source mode: url contains /run-dir/", () => {
		expect(
			detectMode("file:///repo/bun-apps/pi-agent/run-dir/resolve.ts"),
		).toBe("source");
	});

	test("binary mode: $bunfs virtual scheme", () => {
		expect(detectMode("file://$bunfs/pi-agent.js")).toBe("binary");
	});

	test("binary mode: ~BUN marker", () => {
		expect(detectMode("file:///~BUN/pi-agent.js")).toBe("binary");
	});

	test("binary mode: URL-encoded ~BUN (%7EBUN)", () => {
		expect(detectMode("file:///%7EBUN/pi-agent.js")).toBe("binary");
	});

	test("binary takes precedence over source", () => {
		// a compiled binary whose path happens to contain /run-dir/ still binary
		expect(detectMode("file://$bunfs/run-dir/x")).toBe("binary");
	});

	test("bundle mode: none of the above (bundled .js next to packages)", () => {
		expect(detectMode("file:///opt/pi-agent/dist/pi-agent.js")).toBe("bundle");
	});

	test("the real module URL (this test run) is source mode", () => {
		// This test file lives in run-dir/ too, so its URL is a source-mode URL.
		expect(detectMode(import.meta.url)).toBe("source");
	});
});

describe("buildArgvFromManifest", () => {
	function setup() {
		const base = mkdtempSync(join(tmpdir(), "pi-rundir-"));
		// materialize the manifest's relative entries under base
		for (const rel of manifest.extensions ?? []) {
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
		for (const rel of manifest.extensions ?? []) {
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
				// -ne is a flag with no path payload (deploy-package mode) — not hit here
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
});
