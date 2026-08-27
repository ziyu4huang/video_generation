/**
 * url→fs conversion on a WINDOWS build host (crossos follow-through, 2026-08-27).
 *
 * Measured failure: crossos-deploy-verify run 33075359667, windows row, ~3s
 * into the deploy step —
 *   ENOENT … open '\C:\Users\runneradmin\.bun\install\cache\links\
 *   @earendil-works+pi-coding-agent@0.84.2+…\node_modules\@earendil-works\
 *   pi-coding-agent\package.json'
 * The old `dirname(new URL(url).pathname)` kept the URL's posix `/C:/…`
 * pathname; path.win32.join then normalized it to the unopenable `\C:\…`.
 * `fileURLToPath` (behind lib/fs.ts urlToFsPath) is the only spelling that
 * yields a real `C:\…` path on win32. On darwin both spellings agree, so no
 * behavioral darwin test can separate them — coverage is (a) urlToFsPath
 * unit tests incl. the host-form rethrow, (b) the live resolution still
 * works, (c) a mechanism test pinning the exact artifact string under
 * path.win32, and (d) a source-scan tripwire banning `.pathname` reads
 * across ALL deploy sources (artifact-leak test style). The integration
 * gate that actually exercises the win32 branch is the crossos-deploy-verify
 * windows row itself.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { urlToFsPath } from "../src/deploy/lib/fs.ts";
import { resolvePiPkgDir } from "../src/deploy/run.ts";

describe("urlToFsPath (win32 url→path trap)", () => {
	test("plain paths and non-file URLs pass through untouched", () => {
		expect(urlToFsPath("/tmp/release-base")).toBe("/tmp/release-base");
		expect(urlToFsPath("https://github.com/oven-sh/bun")).toBe("https://github.com/oven-sh/bun");
	});

	test("a file:// URL round-trips to a real path", () => {
		const p = urlToFsPath(`file://${join(import.meta.dir, "fixtures")}`);
		expect(p).toBe(join(import.meta.dir, "fixtures"));
	});

	test("host-form file URLs: win32 rethrows with context, posix passes through", () => {
		// e.g. a win32 drive-letter typo: `C:` parses as the URL HOST. On
		// win32 fileURLToPath throws a bare TypeError naming neither the input
		// nor the fix — urlToFsPath must surface a diagnosable error instead.
		// On posix the host form is accepted (returns the pathname), so the
		// darwin lane pins the passthrough and the win32 expectation is
		// documented by the branch below (exercised by crossos windows row).
		if (process.platform === "win32") {
			expect(() => urlToFsPath("file://C:/mirror/bun.zip")).toThrow(/file:\/\/C:\/mirror\/bun\.zip/);
			expect(() => urlToFsPath("file://C:/mirror/bun.zip")).toThrow(/file:\/\/\/C:\/path/);
		} else {
			expect(urlToFsPath("file://C:/mirror/bun.zip")).toBe("/C:/mirror/bun.zip");
		}
	});
});

describe("resolvePiPkgDir (win32 url→path trap)", () => {
	test("resolves THIS machine's real pi-coding-agent package dir", () => {
		const dir = resolvePiPkgDir();
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
		expect(pkg.name).toBe("@earendil-works/pi-coding-agent");
	});

	test("mechanism: url.pathname + path.win32.join reproduces the exact run-33075359667 artifact", () => {
		const url =
			"file:///C:/Users/runneradmin/.bun/install/cache/links/@earendil-works+pi-coding-agent@0.84.2+c41fff0105edc355-bb9a7f2aa13c74d4/node_modules/@earendil-works/pi-coding-agent/package.json";
		// The OLD expression: posix pathname fed to a windows join → the exact
		// leading-backslash ENOENT shape from the run log. fileURLToPath
		// instead anchors at the drive letter (C:\…) on win32; on darwin it
		// degenerates to the posix pathname, which is correct HERE — the two
		// only diverge on win32.
		const old = win32.join(dirname(new URL(url).pathname), "package.json");
		expect(old).toBe(
			"\\C:\\Users\\runneradmin\\.bun\\install\\cache\\links\\" +
				"@earendil-works+pi-coding-agent@0.84.2+c41fff0105edc355-bb9a7f2aa13c74d4\\" +
				"node_modules\\@earendil-works\\pi-coding-agent\\package.json",
		);
	});
});

describe("tripwire: no .pathname fs reads in deploy sources", () => {
	/** Collect .ts files under dir (flat walk is enough — deploy lib is shallow). */
	function tsFiles(dir: string): string[] {
		const out: string[] = [];
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) out.push(...tsFiles(p));
			else if (e.name.endsWith(".ts")) out.push(p);
		}
		return out;
	}

	test("every src/deploy/**/*.ts is free of url .pathname reads", () => {
		// Broad token on purpose: catches both the joined spelling
		// (`new URL(x).pathname`) and the split one (`const u = new URL(x);
		// … u.pathname`) in ANY deploy source — not just the two files the
		// 2026-08-27 fix touched. All url→fs conversions live behind
		// urlToFsPath (lib/fs.ts), so there is no false-positive cost.
		const offenders: string[] = [];
		for (const f of tsFiles(join(import.meta.dir, "..", "src", "deploy"))) {
			if (readFileSync(f, "utf8").includes(".pathname")) offenders.push(f);
		}
		expect(offenders).toEqual([]);
	});
});
